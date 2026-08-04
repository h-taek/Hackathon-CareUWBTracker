import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  SERVER_CONFIG_USAGE,
  parseServerConfig,
  wantsHelp,
  type ServerConfig,
} from './config/cli.ts';
import {
  createPositionSmoother,
  smootherOptionsFromEnv,
  SMOOTHER_DEFAULTS,
  type PositionRecord,
} from './positioning/smoother.ts';
import { handleIngest } from './ingest/endpoint.ts';
import { validateIngest, IngestValidationError } from './ingest/validate.ts';
import { createPositioningHandler } from './positioning/handler.ts';
import { rangesForPoint } from './positioning/to-ranges.ts';
import { loadClips, clipSummary } from './inject/clip.ts';
import { createInjector, ClipNotFoundError, TagNotFoundError } from './inject/injector.ts';
import { Simulator, type SimTag, type SimMap } from './sim.ts';
import { formatIngestLine, DEFAULT_GRAVITY, type IngestPayload } from './lib/ingest-log.ts';
import { createFallDetector, optionsFromEnv, type FallEvent } from './detection/fall.ts';
import { createCascadeDetector } from './detection/cascade.ts';
import { zoneAt } from './lib/zone.ts';
import { applyZonePolicy, type PositionLike } from './lib/privacy.ts';
import { createStaticHandler } from './static/handler.ts';
import { createEventRecorder, recorderOptionsFromEnv, RECORDER_DEFAULTS, type EventRecord } from './events/recorder.ts';
import { createEventStore, isValidEventId } from './events/store.ts';
import { routeEvents, routeIncidents, parseOutcomePath, parsePurgeWorkdirPath } from './events/routes.ts';
import { applyJudgment, isJudgment, outcomeOf, wantsIncident, type Judgment, type OutcomeFields } from './events/outcome.ts';
import { createRetention, retentionOptionsFromEnv } from './events/retention.ts';
import { createAuditLog, createCollectTracker } from './lib/audit.ts';
import { attachmentLimitFromEnv, createAttachmentStore } from './events/attachments.ts';
import { handleAttachmentUpload, parseAttachmentPath, parseReconTriggerPath } from './events/upload.ts';
import {
  parseAttachmentFilePath,
  parseReconLogPath,
  readReconLogTail,
  serveAttachment,
} from './events/download.ts';
import { createReconRunner } from './events/recon/runner.ts';
import {
  resolveOpenSplatBin,
  tuningFromEnv,
  tuningFromParams,
  RECON_DEFAULTS,
} from './events/recon/steps.ts';

const args = process.argv.slice(2);
if (wantsHelp(args)) {
  console.log(SERVER_CONFIG_USAGE);
  process.exit(0);
}

let config: ServerConfig;
try {
  config = parseServerConfig(args);
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`실행 인자 오류: ${message}\n`);
  console.error(SERVER_CONFIG_USAGE);
  process.exit(1);
}

const anchorConfig = config.anchor;
const sourceMode = config.source;

const port = Number(process.env.PORT ?? 8080);
const map: SimMap = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, 'map.json'), 'utf8'),
);
const sim = new Simulator(map);
// 기본은 고전 감지 후 LightGBM 정밀 판정. 비활성화 또는 모델 로드 실패 시 고전 감지기로 폴백한다.
const fallDetector = (() => {
  if (process.env.FALL_AI === '0') {
    console.log('[fall] 고전 단독 모드(FALL_AI=0)');
    return createFallDetector(optionsFromEnv());
  }
  try {
    const detector = createCascadeDetector({
      ...optionsFromEnv(),
      // 기각은 스트림에 아무것도 안 내보내므로 로그가 유일한 흔적이다.
      onReject: ({ tagId, aiScore, threshold, peakAccel }) => {
        console.log(`[fall] 기각 ${tagId} peak=${peakAccel}g ai=${aiScore} (임계 ${threshold}) — 낙상 아님으로 판정`);
      },
    });
    console.log('[fall] 2단계 캐스케이드(고전+LightGBM) 모드');
    return detector;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[fall] AI 모델 로드 실패 → 고전 단독 폴백: ${message}`);
    return createFallDetector(optionsFromEnv());
  }
})();
const smootherConfig = { ...SMOOTHER_DEFAULTS, ...smootherOptionsFromEnv() };
const positionSmoother = createPositionSmoother(smootherConfig);
const clients = new Set<ServerResponse>();

// 사고 기록(R-1) — 경보를 SSE로 뿌리고 끝내지 않고 전후 궤적·가속도와 함께 파일로 남긴다.
// 여기에 남은 eventId가 R-2~R-4의 현장 영상·재구성 산출물이 붙을 자리다.
const recorderConfig = { ...RECORDER_DEFAULTS, ...recorderOptionsFromEnv() };
const dataDir = process.env.DATA_DIR || path.join(import.meta.dirname, 'data');
const eventStore = createEventStore(process.env.EVENTS_DIR || path.join(dataDir, 'events'));
// 확인 사건. **감지 이벤트와 다른 폴더다**(spec operation 02 §2). 판정이 confirmed가 되면
// 여기 사본이 생기고, 그 뒤로 둘의 삭제·보관기간은 서로 관계가 없다.
const incidentStore = createEventStore(process.env.INCIDENTS_DIR || path.join(dataDir, 'incidents'));

// 처리사실 확인자료·접속기록(spec 11 §4.6). 좌표는 지우고 이 기록은 남긴다 —
// 위치정보법 제16조②는 보존을 요구하고, 미이행이 형사처벌 대상이다.
const auditLog = createAuditLog(process.env.AUDIT_DIR || path.join(dataDir, 'audit'));
const collectTracker = createCollectTracker(auditLog);

/**
 * 아직 파일로 안 닫힌 경보에 대한 판정.
 *
 * 기록은 후행 창(10초)이 찬 뒤에 닫히는데, 관제사가 그 전에 경보를 끄면 갱신할 레코드가
 * 아직 없다. 판정을 여기 담아 뒀다가 레코드가 닫힐 때 같이 심는다.
 */
const pendingJudgments = new Map<string, OutcomeFields>();

/**
 * 아직 파일로 안 닫힌 경보의 원본. 기록이 닫히기 전에 판정이 들어와도 사건을 **바로**
 * 만들려면 시각·구역·충격이 필요한데, 그것을 쥔 것이 이 경보 객체뿐이다.
 * 궤적과 가속도는 나중에 기록이 닫힐 때 채워 넣는다.
 */
const liveAlerts = new Map<string, FallEvent>();

const eventRecorder = createEventRecorder({
  ...recorderConfig,
  onRecord: (record) => {
    // 관제사가 기록이 닫히기 전에 판정했으면 그것부터 얹는다. 안 그러면 판정이 사라진다.
    const pending = pendingJudgments.get(record.eventId);
    if (pending) pendingJudgments.delete(record.eventId);
    const saved = pending ? { ...record, ...pending } : record;
    eventStore.save(saved);
    liveAlerts.delete(record.eventId);
    // 판정이 먼저 들어와 사건을 이미 만들었으면, 이제 확정된 궤적·가속도를 채워 넣는다.
    // 첨부는 건드리지 않는다 — 그 사이에 영상이 붙었을 수 있다.
    if (incidentStore.read(record.eventId)) {
      incidentStore.patch(record.eventId, { track: saved.track, accel: saved.accel, alert: saved.alert });
      console.log(`[incident] ${record.eventId} 궤적 ${saved.track.length}점 · 가속도 ${saved.accel.length}표본 채움`);
    } else if (pending?.outcome && isJudgment(pending.outcome)) {
      // 경보 객체가 없어 사건을 못 만들었던 경우의 보루.
      syncIncident(record.eventId, saved, pending.outcome, pending.resolvedBy ?? OPERATOR, pending.resolvedAt ?? Date.now());
    }
    console.log(
      `[event] 기록 ${record.eventId} (${record.tagId})`
      + ` 궤적 ${record.track.length}점 · 가속도 ${record.accel.length}표본`
      + `${pending ? ` · 판정 ${pending.outcome}` : ''} → ${eventStore.dir}`,
    );
  },
  // 디스크가 차거나 권한이 없어도 관제는 계속 돌아야 한다. 기록만 잃고 경보는 이미 나갔다.
  onError: (error, record) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[event] ⚠ ${record.eventId} 기록 실패 — 경보는 정상 발행됐습니다: ${message}`);
  },
});

// 현장 영상 첨부(R-2)와 재구성 파이프라인(R-3·R-4).
const attachmentLimitBytes = attachmentLimitFromEnv();
// 영상·3D는 **사건에** 붙는다. 이벤트는 24시간이라 거기 붙이면 같이 사라진다.
const eventAttachments = createAttachmentStore(incidentStore, { limitBytes: attachmentLimitBytes });
// 도구가 안 깔린 자리에서는 업로드만 받고 재구성은 걸지 않는다. 안 그러면 올릴 때마다
// 실패 기록만 쌓인다. 나중에 POST /events/<id>/attachments/<attId>/recon으로 손수 건다.
const reconAuto = process.env.RECON_AUTO !== '0';
const reconTuning = {
  ...RECON_DEFAULTS,
  ...tuningFromEnv(),
  // 빌드해 둔 opensplat을 서버가 알아서 찾는다. 안 그러면 OPENSPLAT_BIN을 빼먹었을 때
  // COLMAP을 몇 분 돌린 끝에 마지막 단계에서 죽는다.
  openSplatBin: resolveOpenSplatBin(import.meta.dirname, process.env, fs.existsSync),
};
const reconRunner = createReconRunner({
  ...reconTuning,
  store: incidentStore,
  attachments: eventAttachments,
  // 산출물이 나온 순간 중간물은 목적을 달성한다. 한 건에 471MB라 바로 거둔다(spec 11 §4.5).
  onDone: (eventId) => {
    for (const action of retention.purgeWorkdir(eventId)) {
      console.log(`[retention] ${action.eventId} ${action.action} · ${action.reason}`
        + ` (${(action.bytes / 1024 / 1024).toFixed(1)}MB)`);
    }
  },
});

// 보관기간 파기(spec 11 §7). 기동 시 한 번 훑고 그 뒤로 주기 실행이다.
const retention = createRetention({
  ...retentionOptionsFromEnv(),
  store: eventStore,
  incidents: incidentStore,
  audit: auditLog,
  facilityDir: process.env.FACILITY_DIR || path.join(dataDir, 'facility'),
});

function broadcast(event: 'position' | 'alert', data: unknown): void {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const response of clients) response.write(frame);
}

/**
 * 좌표에 구역 라벨을 붙이고, 사생활 구역이면 좌표를 지운다(F-6, spec 03 §1.1).
 *
 * 맵을 쥐고 있는 건 서버뿐이라 구역 판정은 여기서만 할 수 있다. 그래서 이 함수는
 * **처리 단계의 첫 관문**이다 — 여기를 지난 프레임만 기록·로그·감지기·방출로 간다.
 * 방출 직전에 두면 화면에서만 감춰지고 궤적 버퍼와 서버 로그에는 좌표가 남는다.
 *
 * 좌표는 구역 판정에 쓰고 즉시 버린다. 평활기까지는 좌표가 들어가지만 그건 메모리
 * 안에서 끝나고, 이 함수 뒤로는 어디에도 기록되지 않는다.
 */
function zonePolicy(position: unknown): unknown {
  const pos = (position as { pos?: { x: number; y: number } | null } | null)?.pos;
  if (!position || !pos) return position;   // 측위 실패·보류 프레임은 그대로 흘린다
  return applyZonePolicy(map, position as PositionLike);
}

const handlePositioning = createPositioningHandler({
  ...anchorConfig,
});

/**
 * 낙상 경보가 걸린 채 아직 관제사가 끄지 않은 태그.
 *
 * 경보를 끝내는 경로는 관제사 조작 하나뿐이고(spec 03 §3), 서버는 그걸 알 방법이 없었다 —
 * `경보 종료`가 화면 안에서만 일어났기 때문이다. 그래서 클립 재생이 끝나는 순간 시뮬이
 * 태그를 다시 걷게 만들었다. 화면에는 경보가 떠 있는데 마커는 산책하는 상태였다.
 */
const alertedTags = new Set<string>();

/** 행위자. 관제 화면 인증이 아직 없어 고정값이다(spec 11 §8에 미구현으로 적어 둔다). */
const OPERATOR = 'operator';

/**
 * 판정을 레코드에 심는다. 경보 종료(최초 판정)와 번복이 같은 길을 쓴다.
 *
 * `allowPending`은 경보 종료 쪽에만 준다. 기록은 후행 창 10초가 찬 뒤에 닫히는데
 * 관제사가 그 전에 끄는 일이 흔하다 — 그때는 판정을 들고 있다가 기록이 닫힐 때 심는다.
 * 번복은 이미 닫힌 기록을 고치는 것이라 없는 eventId면 404가 맞다.
 */
function judge(
  eventId: string,
  outcome: Judgment,
  by: string,
  { allowPending = false }: { allowPending?: boolean } = {},
): { ok: boolean; reason: string; status: number } {
  if (!isValidEventId(eventId)) return { ok: false, reason: `잘못된 eventId: ${eventId}`, status: 400 };

  const record = eventStore.read(eventId);
  if (!record) {
    if (!allowPending) return { ok: false, reason: `없는 이벤트: ${eventId}`, status: 404 };
    const at = Date.now();
    const fields: OutcomeFields = {
      outcome,
      resolvedAt: at,
      resolvedBy: by,
      outcomeHistory: [{ at, from: 'detected', to: outcome, by }],
    };
    pendingJudgments.set(eventId, fields);

    // **사건은 지금 만든다.** 기록이 닫히기를 기다리면 12초 뒤에야 목록에 뜬다 —
    // 판정한 사람 눈에는 아무 일도 안 일어난 것처럼 보인다. 궤적·가속도는 비워 두고
    // 기록이 닫힐 때 채운다(onRecord).
    const alert = liveAlerts.get(eventId);
    if (alert) {
      syncIncident(eventId, { ...stubFrom(alert), ...fields }, outcome, by, at);
    }
    return { ok: true, reason: '', status: 200 };
  }

  const at = Date.now();
  const result = applyJudgment(record, outcome, by, at, retention.config.undoWindowMs);
  if (!result.ok || !result.patch) return { ok: false, reason: result.reason, status: 409 };

  const from = outcomeOf(record);
  const next = eventStore.patch(eventId, result.patch);
  syncIncident(eventId, next ?? { ...record, ...result.patch }, outcome, by, at);
  auditLog.record({
    at,
    kind: 'access',
    tagId: record.tagId,
    actor: by,
    detail: `${eventId} 판정 ${from} → ${outcome}`,
  });
  console.log(`[event] ${eventId} 판정 ${from} → ${outcome} (${by})`);
  return { ok: true, reason: '', status: 200 };
}

/** 아직 안 닫힌 경보로 만드는 뼈대 레코드. 궤적·가속도는 기록이 닫힐 때 채워진다. */
function stubFrom(alert: FallEvent): EventRecord {
  return {
    eventId: alert.eventId,
    tagId: alert.tagId,
    ts: alert.ts,
    alert: { ...alert } as Record<string, unknown>,
    track: [],
    accel: [],
    attachments: [],
  };
}

/**
 * 판정에 맞춰 사건 사본을 만들거나 지운다.
 *
 * **사본이지 참조가 아니다.** 원본 이벤트를 지워도 사건은 온전히 남고, 사건을 지워도
 * 로그는 그대로다(spec operation 02 §2). 사건 쪽에는 첨부가 붙으므로 이미 있으면
 * 덮어쓰지 않는다 — 덮어쓰면 붙여둔 영상·3D 목록이 날아간다.
 */
function syncIncident(
  eventId: string,
  record: EventRecord,
  outcome: Judgment,
  by: string,
  at: number,
): void {
  const had = incidentStore.read(eventId);
  if (wantsIncident(outcome)) {
    if (had) return;
    incidentStore.save({ ...record, attachments: [] });
    auditLog.record({ at, kind: 'access', tagId: record.tagId, actor: by, detail: `${eventId} 사건 기록 생성` });
    console.log(`[incident] ${eventId} 사건 기록 생성 → ${incidentStore.dir}`);
    return;
  }
  // 낙상 → 오보로 뒤집혔다. 사건도 같이 지운다(붙어 있던 영상·3D째).
  if (!had) return;
  incidentStore.remove(eventId);
  auditLog.record({ at, kind: 'access', tagId: record.tagId, actor: by, detail: `${eventId} 사건 기록 파기 · 오보로 번복` });
  console.log(`[incident] ${eventId} 사건 기록 파기 (오보로 번복)`);
}

// 삼각측량이 해 없음으로 클램프됐을 때 알리는 경고. 50Hz로 쏟아지면 로그가 못 쓰게 되므로
// 태그별로 간격을 둔다. 시각은 payload.ts를 쓴다 — 주입 재생과 실측이 같은 기준으로 찍힌다.
const GEOM_WARN_INTERVAL_MS = 2000;
const lastGeomWarnAt = new Map<string, number>();

function warnIfGeometryBroken(position: { tagId: string; ts?: unknown; geom?: { error: number } } | null): void {
  if (!position?.geom) return;
  const ts = typeof position.ts === 'number' ? position.ts : 0;
  const last = lastGeomWarnAt.get(position.tagId);
  if (last != null && ts - last < GEOM_WARN_INTERVAL_MS) return;
  lastGeomWarnAt.set(position.tagId, ts);
  console.warn(
    `[position] ⚠ ${position.tagId} 삼각측량 해가 없어 y를 0으로 클램프했습니다`
    + ` (${position.geom.error.toFixed(2)}m 모자람).`
    + ` --anchor-distance ${anchorConfig.anchorDistance}m 가 실제 두 앵커 간격과 맞는지 확인하세요.`,
  );
}

// 1앵커 추정 좌표는 방향이 설정값이라 진짜 측위가 아니다. 태그마다 처음 한 번만 알린다 —
// 매 프레임 찍으면 로그가 못 쓰게 되고, 아예 안 찍으면 가짜 좌표가 조용히 화면에 오른다.
const singleAnchorNoticed = new Set<string>();

function noteSingleAnchorEstimate(
  position: { tagId: string; estimate?: { bearingDeg: number; anchorId: string } } | null,
): void {
  if (!position?.estimate || singleAnchorNoticed.has(position.tagId)) return;
  singleAnchorNoticed.add(position.tagId);
  console.warn(
    `[position] ⚠ ${position.tagId} 1앵커 추정 좌표입니다 — ${position.estimate.anchorId} 거리만 실측이고`
    + ` 방향은 ${position.estimate.bearingDeg}도 고정입니다(--single-anchor-bearing). 측위 검증에는 쓸 수 없습니다.`,
  );
}

function logAndPosition(payload: IngestPayload): PositionRecord | null {
  // 확인자료의 '수집'. 프레임마다가 아니라 세션 단위로 남는다 — 조문이 요구하는 것은
  // 처리 사실이지 프레임 이력이 아니다(spec 11 §4.6).
  if (payload.tagId) collectTracker.touch(payload.tagId);
  const rawPosition = handlePositioning(payload as Parameters<typeof handlePositioning>[0]);
  warnIfGeometryBroken(rawPosition);
  noteSingleAnchorEstimate(rawPosition);
  // 평활화까지가 좌표를 다루는 마지막 자리다. 그 뒤 zonePolicy를 지나면 사생활 구역
  // 프레임에는 좌표가 없고, 아래 넷(방출·기록·로그·감지기)은 전부 지워진 것만 본다.
  const smoothed = rawPosition ? positionSmoother.observe(rawPosition) : null;
  const position = zonePolicy(smoothed) as PositionRecord | null;
  if (position) broadcast('position', position);
  // 경보보다 먼저 넣는다. 판정은 정점 뒤 1.5초에 나므로, 경보가 등록되는 시점에는
  // 이 프레임까지가 이미 버퍼에 들어 있어야 한다.
  eventRecorder.observe(payload, position);
  console.log(formatIngestLine(payload, position, {
    mainAnchorId: anchorConfig.mainAnchorId,
    subAnchorId: anchorConfig.subAnchorId,
    gravity: DEFAULT_GRAVITY,
  }));

  let fallEvents: FallEvent[] = [];
  try {
    fallEvents = fallDetector.observe(payload, position);
  } catch (error: unknown) {
    console.error('[fall] detector error', error);
  }
  for (const event of fallEvents) {
    // 좌표가 있으면 그 자리로 라벨을 다시 매긴다. 사생활 구역은 좌표가 없으므로
    // 감지기가 실어 보낸 구역명(마지막으로 본 구역)을 그대로 둔다.
    if (event.pos) event.zone = zoneAt(map, event.pos.x, event.pos.y);
    // 쓰러진 사람은 누가 갈 때까지 그 자리에 있다. 시뮬이 이 태그를 계속 걷게 두면
    // 화면에는 경보가 떠 있는데 마커만 산책하는 상태가 된다. 푸는 것은 관제사가
    // 경보를 끌 때뿐이다(/alerts/resolve).
    alertedTags.add(event.tagId);
    sim.freeze(event.tagId);
    const ai = event.aiScore != null ? ` ai=${event.aiScore}` : '';
    const where = event.privacy ? `${event.zone ?? '사생활 구역'} · 좌표 미기록` : (event.zone ?? '-');
    console.log(`[fall] ${event.type} ${event.tagId} peak=${event.peakAccel}g freefall=${event.freefall}${ai} zone=${where}`);
    broadcast('alert', event);
    // 확인자료의 '이용'. 좌표를 낙상 판정과 화면 표시에 썼다는 사실을 남긴다.
    // **좌표값 자체는 넣지 않는다** — 그러면 확인자료가 아니라 파기 대상이 된다.
    auditLog.record({
      kind: 'use',
      tagId: event.tagId,
      actor: 'system',
      detail: `낙상 감지 · ${event.eventId} · ${event.zone ?? '구역 미지정'}`,
    });
    // zone까지 채운 뒤에 넘긴다 — 레코드의 alert는 SSE로 나간 것과 같아야 한다.
    liveAlerts.set(event.eventId, { ...event });
    eventRecorder.record(event);
  }
  return position;
}

// 측위 스트림은 sim 모드에서만 방출한다. live 모드에서는 실측 ingest만 /stream으로 나간다.
if (sourceMode === 'sim') {
  // 시뮬 좌표도 같은 관문을 지난다. 배경 태그가 화장실에 있으면 화면에서도 사라져야 한다.
  sim.on('position', (position: unknown) => broadcast('position', zonePolicy(position)));
  sim.start(5);
}

// 데모 주입기 — 데이터셋 클립을 ingest 프레임으로 되돌려 /ingest와 같은 길로 흘린다.
// 소스 모드와 무관하게 동작한다. 주입된 프레임은 그 자체가 ingest라, live 모드에서도
// 실측 프레임과 나란히 흐르는 게 맞다.
const clips = loadClips(path.join(import.meta.dirname, 'inject', 'clips'));
const injector = createInjector({
  clips,
  gravity: DEFAULT_GRAVITY,
  rangesFor: (tagId) => {
    const point = sim.positionOf(tagId);
    return point ? rangesForPoint(point, anchorConfig) : null;
  },
  // 실측 워치가 보내는 것과 같은 검증을 통과시킨다. 여기서 걸리면 클립이나 거리 합성이
  // spec 03 스키마를 벗어난 것이다. 타이머 안이라 그냥 던지면 서버가 죽으므로,
  // 크게 남기고 그 재생만 끊는다.
  onFrame: (frame) => {
    try {
      logAndPosition(validateIngest(frame) as unknown as IngestPayload);
    } catch (error: unknown) {
      if (!(error instanceof IngestValidationError)) throw error;
      console.error(`[inject] ingest 스키마 위반으로 재생 중단: ${error.issues.join('; ')}`);
      injector.stop(frame.tagId);
    }
  },
  onStart: (tagId, clip) => {
    sim.freeze(tagId);
    // 앞선 재생이 남긴 감지기 상태(COOLDOWN 등)를 지운다. 새 클립은 새 상황이다.
    fallDetector.reset(tagId);
    // 기록 버퍼도 같이 비운다. 안 비우면 앞 클립의 파형이 다음 사고의 '사고 직전'으로 붙는다.
    // 대기 중이던 기록은 있는 만큼으로 먼저 닫힌다.
    eventRecorder.reset(tagId);
    console.log(`[inject] ${tagId} <- ${clip.id} (${clip.source.dataset} ${clip.source.activity}/${clip.source.trial}, ${clip.samples.ax.length}샘플)`);
  },
  onEnd: (tagId, clip, completed) => {
    // 재생이 끝나도 경보가 살아 있으면 그 자리에 둔다. 관제사가 끄면 그때 걷는다.
    if (!alertedTags.has(tagId)) sim.unfreeze(tagId);
    console.log(`[inject] ${tagId} ${completed ? '재생 끝' : '중단'} ${clip.id}`
      + (alertedTags.has(tagId) ? ' · 경보 대기 중이라 정지 유지' : ''));
  },
});

function sendJson(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(value));
}

// public/ 아래 파일이 곧 URL. 페이지·에셋 추가에 서버 코드 수정이 필요 없다.
const serveStatic = createStaticHandler(path.join(import.meta.dirname, 'public'));

const server = http.createServer((request: IncomingMessage, response: ServerResponse) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  const { pathname } = url;

  if (pathname === '/ingest') {
    handleIngest(request, response, {
      onIngest: (payload) => logAndPosition(payload as unknown as IngestPayload),
    });
    return;
  }
  if (pathname === '/stream') {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    response.write('retry: 2000\n\n');
    clients.add(response);
    request.on('close', () => clients.delete(response));
    return;
  }
  // 첨부는 다섯 갈래다. 로그(GET) → 재구성 걸기(POST) → 업로드(POST) → 파일(GET) → JSON 조회.
  const logTarget = parseReconLogPath(pathname);
  if (logTarget) {
    const tail = readReconLogTail(incidentStore.dir, logTarget, Number(url.searchParams.get('tail')) || undefined);
    if (tail === null) return sendJson(response, { ok: false, error: '로그가 아직 없습니다' }, 404);
    response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    return void response.end(tail);
  }

  const reconTarget = parseReconTriggerPath(pathname);
  if (reconTarget) {
    if (request.method !== 'POST') return sendJson(response, { ok: false, error: 'POST만 받습니다' }, 405);
    const attachment = eventAttachments.get(reconTarget.eventId, reconTarget.attachmentId);
    if (!attachment) return sendJson(response, { ok: false, error: '없는 첨부' }, 404);
    if (attachment.kind !== 'video') {
      return sendJson(response, { ok: false, error: `재구성 대상은 영상뿐입니다: kind=${attachment.kind}` }, 400);
    }
    const queued = reconRunner.enqueue({ ...reconTarget, tuning: tuningFromParams(url.searchParams) });
    return sendJson(response, {
      ok: true,
      queued,
      // 이미 대기·진행 중이면 새로 넣지 않는다. 두 번 눌렀다고 두 번 돌면 GPU만 낭비된다.
      note: queued ? '대기열에 넣었습니다' : '이미 대기 또는 진행 중입니다',
      pending: reconRunner.size(),
    });
  }

  const uploadTarget = parseAttachmentPath(pathname);
  if (uploadTarget !== null) {
    handleAttachmentUpload(request, uploadTarget, url.searchParams, eventAttachments, (attachment) => {
      // 영상이 붙으면 그 자리에서 재구성 대기열로 보낸다. 실제 실행은 응답 밖에서 돈다.
      if (attachment.kind !== 'video' || !reconAuto) return;
      reconRunner.enqueue({
        eventId: attachment.eventId,
        attachmentId: attachment.attachmentId,
        // 화면이 이 업로드에만 쓸 설정을 같이 보낸다. 없으면 서버 기본값으로 돈다.
        tuning: tuningFromParams(url.searchParams),
      });
    })
      .then((result) => sendJson(response, result.body, result.status))
      .catch((error: unknown) => {
        console.error('[event] 첨부 처리 실패', error);
        sendJson(response, { ok: false, error: 'internal_error' }, 500);
      });
    return;
  }
  const fileTarget = parseAttachmentFilePath(pathname);
  if (fileTarget && serveAttachment(request, response, fileTarget, eventAttachments)) return;

  // 판정 번복(spec 11 §3). 번복 창 안에서만 되고, 밖이면 409로 막는다.
  // **routeEvents보다 먼저다** — 그쪽은 `/events/` 뒤를 통째로 eventId로 읽어서,
  // 늦게 두면 `/events/<id>/outcome`이 "잘못된 eventId"로 떨어진다.
  const outcomeTarget = parseOutcomePath(pathname);
  if (outcomeTarget) {
    if (request.method !== 'POST') return sendJson(response, { ok: false, error: 'POST만 받습니다' }, 405);
    const outcome = url.searchParams.get('outcome');
    if (!isJudgment(outcome)) {
      return sendJson(response, { ok: false, error: 'outcome은 confirmed 또는 false_alarm이어야 합니다' }, 400);
    }
    const result = judge(outcomeTarget, outcome, url.searchParams.get('by') || OPERATOR);
    if (!result.ok) return sendJson(response, { ok: false, error: result.reason }, result.status);
    return sendJson(response, { ok: true, eventId: outcomeTarget, outcome });
  }

  // 6층만 지운다. 사건 기록과 최종 산출물은 그대로 둔다 — 관제 화면에 둬도 되는 유일한 삭제다.
  const purgeTarget = parsePurgeWorkdirPath(pathname);
  if (purgeTarget) {
    if (request.method !== 'POST') return sendJson(response, { ok: false, error: 'POST만 받습니다' }, 405);
    if (!incidentStore.read(purgeTarget)) {
      return sendJson(response, { ok: false, error: `없는 사건: ${purgeTarget}` }, 404);
    }
    const actions = retention.purgeWorkdir(purgeTarget);
    const bytes = actions.reduce((sum, a) => sum + a.bytes, 0);
    auditLog.record({ kind: 'access', actor: OPERATOR, detail: `${purgeTarget} 재구성 중간물 정리 요청` });
    return sendJson(response, { ok: true, eventId: purgeTarget, purged: actions.length, bytes });
  }

  // 수동 파기. **감지 이벤트와 확인 사건은 서로를 건드리지 않는다** — 사건은 사본이라
  // 원본을 지워도 남고, 사건을 지워도 로그는 그대로다(spec operation 02 §2).
  if (request.method === 'DELETE') {
    const target = ['/events/', '/incidents/'].find((base) => pathname.startsWith(base));
    if (target) {
      const isIncident = target === '/incidents/';
      const store = isIncident ? incidentStore : eventStore;
      const what = isIncident ? '사건' : '이벤트';
      const id = decodeURIComponent(pathname.slice(target.length).replace(/\/$/, ''));
      if (!isValidEventId(id)) {
        return sendJson(response, { ok: false, error: `잘못된 id: ${id}` }, 400);
      }
      const record = store.read(id);
      if (!store.remove(id)) {
        return sendJson(response, { ok: false, error: `없는 ${what}: ${id}` }, 404);
      }
      auditLog.record({
        kind: 'access',
        ...(record?.tagId ? { tagId: record.tagId } : {}),
        actor: OPERATOR,
        detail: `${id} ${what} 수동 파기`,
      });
      console.log(`[retention] ${id} ${what} 수동 파기`);
      return sendJson(response, { ok: true, id, deleted: true });
    }
  }

  const incidentRoute = routeIncidents(pathname, url.searchParams, incidentStore);
  if (incidentRoute) return sendJson(response, incidentRoute.body, incidentRoute.status);

  const eventRoute = routeEvents(pathname, url.searchParams, eventStore, retention.config.undoWindowMs);
  if (eventRoute) return sendJson(response, eventRoute.body, eventRoute.status);
  if (pathname === '/map') return sendJson(response, map);
  if (pathname === '/clips') return sendJson(response, clips.map(clipSummary));
  if (pathname === '/inject-fall') {
    // 경보는 응답에 담지 않는다. 담을 수가 없다 — 클립을 다 흘리고 나서야 감지기가
    // 판정하고, 그 결과는 /stream으로 나간다. 응답은 "무엇을 얼마나 재생하는지"까지다.
    const clipId = url.searchParams.get('clip') ?? clips[0].id;
    const tagId = url.searchParams.get('tagId') ?? '';
    try {
      const handle = injector.start(tagId, clipId);
      return sendJson(response, { ok: true, ...handle });
    } catch (error: unknown) {
      if (error instanceof ClipNotFoundError || error instanceof TagNotFoundError) {
        return sendJson(response, { ok: false, error: error.message }, 400);
      }
      throw error;
    }
  }
  if (pathname === '/tags') {
    return sendJson(response, sim.tags.map((tag: SimTag) => ({ id: tag.id, name: tag.name })));
  }
  // 시연용. 배경 태그 하나를 사생활 구역으로 들여보낸다.
  //
  // 배경 태그는 통행 구역만 걷게 돼 있어(sim.waypoint) 화장실에 스스로 들어가지 않는다.
  // 그래서 사생활 구역 필터가 걸리는 장면을 보려면 누군가를 들여보내야 한다. 순간이동이
  // 아니라 걸어 들어가게 두는 이유는, 마커가 화장실 앞에서 사라지는 그 순간이 이 기능의
  // 전부이기 때문이다. 도착까지 걸리는 시간은 응답의 etaMs로 알려준다.
  if (pathname === '/demo/privacy-enter') {
    // 시연용 이동 속도(m/s). 평소 배회 속도(0.4~0.9)로 맵을 가로지르면 20초 넘게 걸려
    // 발표가 멈춘다. 도착하면 평소 걸음으로 되돌아온다(sim.sendTo).
    const DEMO_WALK_SPEED = 3.0;
    const zone = map.zones.find((z) => z.privacy);
    if (!zone) return sendJson(response, { ok: false, error: '맵에 사생활 구역이 없습니다' }, 400);
    const [rx, ry, rw, rh] = zone.rect;
    const center = { x: rx + rw / 2, y: ry + rh / 2 };

    // 재생 중인 태그는 주입기가 좌표를 쥐고 있어 걷게 할 수 없다. 남은 것 중 제일 가까운 태그.
    const candidates = sim.tags
      .filter((tag: SimTag) => !sim.frozen.has(tag.id))
      .map((tag: SimTag) => ({ tag, at: sim.positionOf(tag.id) }))
      .filter((c): c is { tag: SimTag; at: { x: number; y: number } } => c.at !== null)
      .sort((a, b) => Math.hypot(a.at.x - center.x, a.at.y - center.y)
        - Math.hypot(b.at.x - center.x, b.at.y - center.y));
    const chosen = candidates[0];
    if (!chosen) return sendJson(response, { ok: false, error: '보낼 수 있는 대상이 없습니다' }, 409);

    // 낙상 주입을 기다렸다가 판정까지 끝낼 만큼은 머물러야 한다. 나오는 장면까지 보려면
    // holdMs로 줄인다 — 체류가 끝나면 스스로 통행 구역으로 걸어 나간다.
    const holdMs = Number(url.searchParams.get('holdMs'));
    const sent = sim.sendTo(
      chosen.tag.id, center,
      Number.isFinite(holdMs) && holdMs >= 0 ? holdMs : 120_000,
      DEMO_WALK_SPEED,
    );
    if (!sent) return sendJson(response, { ok: false, error: '보낼 수 있는 대상이 없습니다' }, 409);
    console.log(`[demo] ${chosen.tag.id} → ${zone.label} (약 ${(sent.etaMs / 1000).toFixed(1)}초)`);
    return sendJson(response, {
      ok: true, tagId: chosen.tag.id, name: chosen.tag.name, zone: zone.label, etaMs: sent.etaMs,
    });
  }
  // 관제사가 경보를 껐다. 경보를 끝내는 유일한 경로이고, 여기서만 태그가 다시 움직인다.
  //
  // **경보 해제와 판정은 다른 일이다.** `outcome`이 있으면 함께 판정하고, 없으면 경보만
  // 끈다(화면 우상단 X). 판정 없이 끈 건은 번복 창 안에 아무도 안 보면 좌표가 파기되며
  // 미판정이 된다(spec operation 02 §3).
  if (pathname === '/alerts/resolve') {
    const tagId = url.searchParams.get('tagId') ?? '';
    const eventId = url.searchParams.get('eventId') ?? '';
    const raw = url.searchParams.get('outcome');
    if (raw !== null && !isJudgment(raw)) {
      return sendJson(response, { ok: false, error: 'outcome은 confirmed 또는 false_alarm이어야 합니다' }, 400);
    }
    const outcome = raw as Judgment | null;

    const had = alertedTags.delete(tagId);
    // 재생 중이면 주입기가 좌표를 쥐고 있다. 지금 풀면 시뮬 5Hz와 주입 50Hz가 마커를
    // 서로 뺏는다 — 재생이 끝날 때 onEnd가 알아서 푼다.
    if (had && !injector.isPlaying(tagId)) sim.unfreeze(tagId);
    if (had) console.log(`[alert] ${tagId} 경보 종료 — ${outcome ?? '판정 없음'} (관제사 확인)`);
    if (!outcome) {
      // 판정을 안 했다는 것도 처리 행위다. 나중에 "왜 판정이 없나"를 이 기록으로 답한다.
      auditLog.record({
        kind: 'access',
        ...(tagId ? { tagId } : {}),
        actor: OPERATOR,
        detail: `${eventId || tagId} 경보 해제 · 판정 보류`,
      });
    }

    const judged = outcome && eventId
      ? judge(eventId, outcome, OPERATOR, { allowPending: true })
      : { ok: false, reason: outcome ? 'eventId가 없다' : '판정 없음' };
    return sendJson(response, { ok: true, tagId, eventId, outcome, resolved: had, judged: judged.ok });
  }

  // API 라우트를 다 흘려보낸 뒤 정적 파일. 못 찾으면 404로 떨어진다.
  if (serveStatic(request, response, pathname)) return;

  response.writeHead(404);
  response.end('not found');
});

server.listen(port, () => {
  // PORT=0이면 OS가 포트를 고른다. 요청값을 그대로 찍으면 "localhost:0"이라고 알려주게 된다.
  const address = server.address();
  const shown = typeof address === 'object' && address !== null ? address.port : port;
  console.log(`시물 스트림 서버 실행: http://localhost:${shown}`);
  console.log(`  대시보드   http://localhost:${shown}/`);
  console.log(`  SSE 스트림 http://localhost:${shown}/stream`);
  console.log(`  ingest     POST http://localhost:${shown}/ingest`);
  console.log(`  앵커       ${anchorConfig.mainAnchorId} (0,0) / ${anchorConfig.subAnchorId} (${anchorConfig.anchorDistance},0), ${anchorConfig.halfPlane}`);
  console.log(
    `  스무딩     최근 ${smootherConfig.windowSize}개 이동평균`
    + ` · 정지 ${smootherConfig.staticDeadbandM}m 고정 · 점프 ${smootherConfig.jumpBaseM}m↑ 컷 · 클램프 프레임 제외`
    + ' (POS_DEADBAND_M / POS_MAX_JUMP_M 로 조절)',
  );
  console.log(
    `  사고 기록  ${eventStore.dir}`
    + ` · 경보 전 ${recorderConfig.preWindowMs / 1000}초 / 후 ${recorderConfig.postWindowMs / 1000}초`
    + ' (EVENT_PRE_MS / EVENT_POST_MS 로 조절)',
  );
  console.log(`  이벤트 조회 GET http://localhost:${shown}/events · 확인 사건 GET /incidents`);
  console.log(`  확인 사건  ${incidentStore.dir} (판정이 낙상이면 이벤트의 사본이 여기 생긴다)`);
  console.log(
    `  보관·파기  감지 이벤트 ${retention.config.undoWindowMs / 3_600_000}시간`
    + ` · 확인 사건 ${Math.round(retention.config.incidentRetentionMs / 86_400_000)}일`
    + ` · ${retention.config.sweepIntervalMs / 3_600_000}시간마다 자동`
    + `${retention.config.dryRun ? ' · dry-run' : ''}`
    + ' (UNDO_WINDOW_HOURS / INCIDENT_RETENTION_DAYS / SWEEP_INTERVAL_HOURS)',
  );
  console.log(`  확인자료   ${auditLog.dir} (위치정보법 제16조② · 파기 금지)`);
  console.log(
    `  현장 영상  POST /events/<eventId>/attachments?kind=video (본문=파일 바이트)`
    + ` · 최대 ${Math.round(attachmentLimitBytes / 1024 / 1024)}MB (ATTACHMENT_LIMIT_MB)`
    + ` · 재구성 ${reconAuto ? '업로드 시 자동' : '수동(RECON_AUTO=0)'}`,
  );
  console.log(
    `  재구성     ${reconTuning.ffmpegBin} → ${reconTuning.colmapBin} → ${reconTuning.openSplatBin}`
    + ` · 상류 기본 ${reconTuning.targetFrames}장`
    + ` · 가로 ${reconTuning.frameWidth > 0 ? `${reconTuning.frameWidth}px` : '원본'}`
    + ` · 학습 ${reconTuning.numIters}회 (화면에서 실행마다 바꾼다)`,
  );
  // 도구가 없으면 지금 알려준다. 재구성을 걸고 나서 알면 COLMAP을 몇 분 돌린 뒤다.
  if (!reconTuning.openSplatBin.includes('/') || !fs.existsSync(reconTuning.openSplatBin)) {
    console.warn(
      `  ⚠ opensplat을 못 찾았습니다(${reconTuning.openSplatBin}).`
      + ' 빌드는 tools/recon/README.md, 다른 자리면 OPENSPLAT_BIN으로 지정하세요.',
    );
  }
  console.log(`  주입 클립  ${clips.map((clip) => clip.id).join(', ')} (실제 파이프라인 통과)`);
  console.log(`  소스       ${sourceMode}${sourceMode === 'sim' ? ' (시뮬 자동 방출)' : ' (실측 ingest만 방출)'}`);
  if (anchorConfig.singleAnchorBearingDeg !== undefined) {
    console.warn(
      `  ⚠ 1앵커 테스트 모드 — 서브 앵커 거리가 없으면 ${anchorConfig.mainAnchorId} 거리를`
      + ` ${anchorConfig.singleAnchorBearingDeg}도 방향에 얹어 좌표를 만듭니다.`
      + ' 거리만 실측이고 방향은 가짜이므로 리허설·시연에는 끄고 실행하세요.',
    );
  }
  // 기동 시 한 번 훑는다. 서버가 꺼져 있던 사이에 만료된 것을 여기서 거둔다.
  retention.start();
});

// 열려 있는 수집 세션을 닫고 나간다. 안 닫으면 확인자료에 개시만 남고 종료가 없다.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    collectTracker.flush();
    retention.stop();
    process.exit(0);
  });
}
