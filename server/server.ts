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
import { loadEnvFile } from './config/env-file.ts';
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
import { Simulator, type SimTag } from './sim.ts';
import {
  parseFacilityMap, createFloorIndex,
  type FacilityMap, type FloorIndex, type Floor,
} from './map/floors.ts';
import { formatIngestLine, DEFAULT_GRAVITY, type IngestPayload } from './lib/ingest-log.ts';
import { createFallDetector, optionsFromEnv, type FallEvent } from './detection/fall.ts';
import { createCascadeDetector } from './detection/cascade.ts';
import { zoneAt } from './lib/zone.ts';
import { applyZonePolicy, type PositionLike } from './lib/privacy.ts';
import { createTagRegistry, normalizeLabel, isValidTagId } from './tags/registry.ts';
import { createSightings } from './tags/sightings.ts';
import {
  createOperatorRegistry,
  normalizeOperatorName,
  isValidOperatorId,
} from './operators/registry.ts';
import {
  createSessionStore,
  readCookie,
  sessionCookie,
  clearedSessionCookie,
  sessionTtlFromEnv,
  SESSION_COOKIE,
} from './operators/session.ts';
import { createTokenMailbox, parseTokenMessage, isPeerId } from './ni/mailbox.ts';
import { readJsonBody, HttpBodyError } from './ingest/body.ts';
import { createStaticHandler } from './static/handler.ts';
import { createEventRecorder, recorderOptionsFromEnv, RECORDER_DEFAULTS, type EventRecord } from './events/recorder.ts';
import { createEventStore, isValidEventId } from './events/store.ts';
import { routeEvents, routeIncidents, parseOutcomePath, parsePurgeWorkdirPath } from './events/routes.ts';
import { applyJudgment, isJudgment, outcomeOf, wantsIncident, type Judgment, type OutcomeFields } from './events/outcome.ts';
import { createRetention, retentionOptionsFromEnv } from './events/retention.ts';
import { createExporterFromEnv } from './events/export/sender.ts';
import { createAuditLog, createCollectTracker } from './lib/audit.ts';
import { attachmentLimitFromEnv, createAttachmentStore } from './events/attachments.ts';
import { handleAttachmentUpload, parseAttachmentPath, parseReconTriggerPath } from './events/upload.ts';
import {
  parseAttachmentFilePath,
  parseReconLogPath,
  readReconLogTail,
  serveAttachment,
} from './events/download.ts';
import { createReconRunner, recoverInterrupted } from './events/recon/runner.ts';
import {
  missingTools,
  resolveOpenSplatBin,
  tuningFromEnv,
  tuningFromParams,
  RECON_DEFAULTS,
} from './events/recon/steps.ts';

// **설정을 읽는 첫 줄이다.** 아래 어떤 설정도 이보다 먼저 읽히면 안 된다.
const envFile = loadEnvFile(import.meta.dirname);

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

// 맵은 층의 배열이다(spec system 03 §5.2). 어긋난 선언은 여기서 끝난다 —
// 틀린 층으로 도는 서버는 사고 기록에 틀린 층을 박고, 그건 나중에 되돌릴 수 없다.
let map: FacilityMap;
let floorIndex: FloorIndex;
let liveFloor: Floor;
try {
  map = parseFacilityMap(JSON.parse(
    fs.readFileSync(path.join(import.meta.dirname, 'map.json'), 'utf8'),
  ));
  floorIndex = createFloorIndex(map);
  // 실측 프레임이 어느 층 것인지는 이 대조로 정해진다.
  liveFloor = floorIndex.requireAnchorPair(anchorConfig.mainAnchorId, anchorConfig.subAnchorId);
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`맵 설정 오류(server/map.json): ${message}`);
  process.exit(1);
}

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

// 관제사 명부와 세션(spec operation 03). 확인자료의 `actor`가 여기서 온다 — 예전에는
// `'operator'` 고정값이라 "누가 이 경보를 오보로 내렸나"에 답할 수 없었다.
// **모드로 나누지 않는다.** 시뮬이든 실기기든 화면 앞에 앉은 사람은 같은 사람이다.
const operatorRegistry = createOperatorRegistry(process.env.OPERATORS_DIR || dataDir);
const sessions = createSessionStore({
  ttlMs: sessionTtlFromEnv(),
  // 만료는 조회하는 순간 발견된다. 화면이 만료 시각에 `GET /session`을 부르므로
  // 실질적으로는 만료된 그때 남는다.
  onExpire: (session) => auditLog.record({
    kind: 'access',
    actor: session.operatorId,
    detail: '관제 화면 세션 만료',
  }),
});

// 태그 명부. **반납이 곧 수집 중단이다**(위치정보법 제24조②의 기술적 수단).
// 여기에 없거나 반납된 태그의 프레임은 아래 ingest 관문에서 통째로 버린다.
//
// **모드마다 장부가 다르다.** 시뮬 배경 태그는 기동할 때 자동으로 명부에 오르는데(아래),
// 장부가 한 파일이면 그 세 명이 파일에 남아 다음에 실기기로 띄워도 "수집 중"으로 앉아 있다.
// 명부는 지금 누구의 위치를 수집하는지를 말하는 장부이자 확인자료의 근거라, 가짜 사람이
// 섞이면 안 된다. 걸러서 감추는 대신 장부 자체를 나눈다 — 필터는 언젠가 새는 곳이 생긴다.
const tagRegistry = createTagRegistry(process.env.TAGS_DIR || path.join(dataDir, 'tags'), {
  fileName: sourceMode === 'sim' ? 'registry.sim.json' : 'registry.live.json',
});
// 명부에 없는 태그가 문을 두드린 기록(메모리 전용). 관리 화면이 이걸 보고 배정한다.
const sightings = createSightings();
// 앵커 폰끼리 NI 토큰을 건네는 우편함(메모리 전용, 만료 15초). 자세한 이유는 ni/mailbox.ts.
// 명부와 달리 수집 여부와 무관한 무선 링크 설정용이라, 등록 관문 앞에 있어도 된다 —
// 토큰이 오간다고 위치가 수집되지는 않는다. 수집은 /ingest 관문이 따로 막는다.
const tokenMailbox = createTokenMailbox();

/** 등록과 반납은 처리 사실이라 확인자료에 남는다. 반납 시각이 곧 수집 종료 시각이다. */
function registerTag(tagId: string, label: string, by: string) {
  const entry = tagRegistry.register(tagId, label, by);
  // 배정됐으니 더는 미등록이 아니다.
  sightings.forget(tagId);
  auditLog.record({ kind: 'collect', tagId, actor: by, detail: `태그 등록 · ${label}` });
  return entry;
}

function releaseTag(tagId: string, by: string) {
  const entry = tagRegistry.release(tagId, by);
  if (!entry) return null;
  // 열려 있던 수집 세션도 지금 닫는다. 반납했는데 세션이 30초 더 열려 있으면
  // 확인자료의 종료 시각과 실제 중단 시각이 어긋난다.
  auditLog.closeCollect(tagId);
  auditLog.record({ kind: 'collect', tagId, actor: by, detail: `태그 반납 · 수집 중단 · ${entry.label}` });
  return entry;
}

// 시뮬 배경 태그를 기동 시 명부에 올린다. 명부에 없으면 관문에서 프레임이 버려져
// 화면이 빈 채로 뜬다. **이미 반납한 태그는 되살리지 않는다** — 재기동으로 반납이
// 풀린다면 그건 중지 수단이 아니다.
//
// **live 모드에서는 올리지 않는다.** 시뮬이 안 도는데 명부에 "수집 중"으로 세 명이
// 앉아 있으면 실기기 검증 중에 명부가 거짓말을 하는 셈이다. 그때 명부는 비어서
// 시작하고, 워치를 켜면 미등록으로 잡혀 거기서 배정한다.
if (sourceMode === 'sim') {
  for (const tag of sim.tags) {
    if (!tagRegistry.get(tag.id)) registerTag(tag.id, tag.name, 'system');
  }
}

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
      // 판정이 들어올 때 행위자가 함께 실렸다. 없다면 그건 사람이 거친 판정이 아니다.
      syncIncident(record.eventId, saved, pending.outcome, pending.resolvedBy ?? SYSTEM, pending.resolvedAt ?? Date.now());
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
const reconTuning = {
  ...RECON_DEFAULTS,
  ...tuningFromEnv(),
  // 빌드해 둔 opensplat을 서버가 알아서 찾는다. 안 그러면 OPENSPLAT_BIN을 빼먹었을 때
  // COLMAP을 몇 분 돌린 끝에 마지막 단계에서 죽는다.
  openSplatBin: resolveOpenSplatBin(import.meta.dirname, process.env, fs.existsSync),
};
// 도구가 안 깔린 자리에서는 업로드만 받고 재구성은 걸지 않는다. 안 그러면 올릴 때마다
// 실패 기록만 쌓인다 — 도구를 못 갖춘 사람이 이 서버에서 처음 보는 3D가 붉은 실패가 된다.
// 나중에 POST /events/<id>/attachments/<attId>/recon으로 손수 걸 수는 있다(그건 막지 않는다.
// 도구를 방금 깔았을 수 있고, 그때는 실패해도 누른 사람이 이유를 안다).
const reconMissing = missingTools(reconTuning);
const reconAuto = process.env.RECON_AUTO !== '0' && reconMissing.length === 0;

/** 배너에 자동 실행이 왜 꺼졌는지까지 적는다. "수동"만 적으면 껐는지 못 찾은 건지 모른다. */
function reconAutoLabel(): string {
  if (reconAuto) return '업로드 시 자동';
  if (process.env.RECON_AUTO === '0') return '수동(RECON_AUTO=0)';
  return `수동 — 도구 ${reconMissing.length}개 없음`;
}
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

// 학습 데이터 반출(spec 03 §7). EXPORT_URL이 없으면 큐만 쌓는다 — 기본이 off다.
const exporter = createExporterFromEnv(dataDir);

// 보관기간 파기(spec 11 §7). 기동 시 한 번 훑고 그 뒤로 주기 실행이다.
const retention = createRetention({
  ...retentionOptionsFromEnv(),
  store: eventStore,
  incidents: incidentStore,
  audit: auditLog,
  exporter,
  facilityDir: process.env.FACILITY_DIR || path.join(dataDir, 'facility'),
});

function broadcast(event: 'position' | 'alert' | 'tags', data: unknown): void {
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
function zonePolicy(floor: Floor, position: unknown): unknown {
  const pos = (position as { pos?: { x: number; y: number } | null } | null)?.pos;
  if (!position || !pos) return position;   // 측위 실패·보류 프레임은 그대로 흘린다
  return applyZonePolicy(floor, position as PositionLike);
}

/**
 * 층별 측위 계산기. 삼각측량은 **그 층의 앵커 쌍**을 기준선으로 삼는다.
 *
 * 하나로 두면 실행 인자의 앵커만 알아보므로, 다른 층 앵커로 들어온 프레임(주입기가
 * 만든 것 포함)은 거리 짝을 못 찾아 좌표가 안 나온다. 앵커 간격과 반평면은 실행 인자
 * 그대로 공유한다 — 층마다 다르게 둘 근거가 아직 없다(spec system 03 §5.2).
 */
const positioningByFloor = new Map<string, ReturnType<typeof createPositioningHandler>>();
function positioningFor(floor: Floor) {
  const cached = positioningByFloor.get(floor.id);
  if (cached) return cached;
  const handler = createPositioningHandler({
    ...anchorConfig,
    mainAnchorId: floor.anchors[0] ?? anchorConfig.mainAnchorId,
    subAnchorId: floor.anchors[1] ?? anchorConfig.subAnchorId,
  });
  positioningByFloor.set(floor.id, handler);
  return handler;
}

/**
 * 낙상 경보가 걸린 채 아직 관제사가 끄지 않은 태그.
 *
 * 경보를 끝내는 경로는 관제사 조작 하나뿐이고(spec 03 §3), 서버는 그걸 알 방법이 없었다 —
 * `경보 종료`가 화면 안에서만 일어났기 때문이다. 그래서 클립 재생이 끝나는 순간 시뮬이
 * 태그를 다시 걷게 만들었다. 화면에는 경보가 떠 있는데 마커는 산책하는 상태였다.
 */
const alertedTags = new Set<string>();

/**
 * 사람이 개입하지 않은 자동 동작. 수집 세션과 보관기간 파기가 이 이름으로 남는다.
 */
const SYSTEM = 'system';

/**
 * 세션 없이 한 일. **명부 수정에만 나온다** — 처음에는 명부가 비어 있어 식별을 요구할 수
 * 없는데(spec operation 03 §2), 식별 없이 한 일이 있었다는 사실은 기록에 드러나야 한다.
 */
const UNIDENTIFIED = 'unidentified';

/** 선택창과 상단바에 나가는 형태. 확인자료에는 ID만 남고 이름은 명부에서 찾는다. */
const publicOperator = (entry: { operatorId: string; name: string }) => ({
  id: entry.operatorId,
  name: entry.name,
});

/** 세션 없이는 못 하는 POST들. 경로가 고정된 것만 여기 두고, id가 낀 것은 아래 파서로 본다. */
const OPERATOR_REQUIRED_POSTS = ['/alerts/resolve', '/tags/register', '/tags/release', '/export/run'];

/**
 * 이 요청이 관제사 식별을 요구하는가(spec operation 03 §4).
 *
 * **조회는 하나도 막지 않는다.** 막는 것은 기록을 바꾸는 동작뿐이다.
 *
 * 첨부 업로드와 재구성 실행도 여기 든다 — 사건 기록에 영상을 붙이는 것은 그 기록을 바꾸는
 * 일이고, 나중에 "이 3D는 누가 올린 영상으로 만들어졌나"를 물을 자리가 확인자료뿐이다.
 */
function requiresOperator(method: string, pathname: string): boolean {
  // 수동 파기. 되돌릴 수 없는 동작이라 누가 눌렀는지가 특히 중요하다.
  if (method === 'DELETE') return pathname.startsWith('/events/') || pathname.startsWith('/incidents/');
  if (method !== 'POST') return false;
  if (OPERATOR_REQUIRED_POSTS.includes(pathname)) return true;
  if (parseAttachmentPath(pathname) !== null || parseReconTriggerPath(pathname) !== null) return true;
  return parseOutcomePath(pathname) !== null || parsePurgeWorkdirPath(pathname) !== null;
}

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

/**
 * 이 태그를 지금 수집해도 되는가. **프레임 하나하나가 여기를 먼저 통과한다.**
 *
 * 반납한 태그의 프레임은 여기서 끝난다 — 측위도, 기록도, 로그도, 낙상 판정도 돌지 않는다.
 * 위치정보법 제24조 제2항이 요구하는 "일시 중지의 기술적 수단"이 이 한 줄이고, 수단을
 * 안 갖춘 것 자체가 과태료 대상이라 화면에서 감추는 것으로는 갈음되지 않는다.
 *
 * 명부에 아예 없는 태그도 같이 막힌다. 등록은 배정 절차이자 수집 근거의 시작이라,
 * 등록 안 된 태그가 흘러들어오는 것은 근거 없는 수집이다.
 */
function isCollecting(tagId: unknown): boolean {
  return typeof tagId === 'string' && tagRegistry.isActive(tagId);
}

/**
 * 안 받은 프레임을 기록한다. **프레임은 버리고 태그 번호와 시각만 남긴다.**
 *
 * 명부에 아예 없는 태그는 "문을 두드리는 중"이라 관리 화면에 띄워야 배정할 수 있다.
 * 반납한 태그는 관제사가 이미 아는 상태라 목록에 올리지 않는다 — 올리면 반납할 때마다
 * 미등록 목록에 다시 나타나 반납이 안 끝난 것처럼 보인다.
 */
function noteDrop(tagId: unknown): void {
  const id = typeof tagId === 'string' ? tagId : '(태그 없음)';
  if (typeof tagId !== 'string') return;
  const entry = tagRegistry.get(tagId);
  if (entry) return;   // 반납된 태그. 조용히 버린다
  if (sightings.note(tagId)) console.log(`[tags] ${id} 미등록 태그가 신호를 보내고 있습니다`);
}

/**
 * 이 프레임이 어느 층 것인가(spec system 03 §5.1 1단계).
 *
 * 앵커가 실려 있으면 그 앵커가 선언된 층이다. **accel-only 프레임은 앵커가 없다** —
 * NI가 아직 안 붙었거나 끊긴 구간이고, 낙상 판정은 그래도 돌아야 한다. 그 태그는
 * 물리적으로 앵커가 깔린 층에 있으므로 실행 인자가 가리키는 층으로 본다.
 *
 * 앵커는 실렸는데 어느 층에도 없으면 null이다 — 그 프레임은 버린다.
 */
function floorForPayload(payload: IngestPayload): Floor | null {
  const ranges = (payload as { ranges?: { anchorId: string }[] }).ranges;
  if (!Array.isArray(ranges) || ranges.length === 0) return liveFloor;
  return floorIndex.ofRanges(ranges);
}

/** 모르는 앵커를 몇 번이나 봤는지. 프레임마다 찍으면 로그가 그걸로 덮인다. */
const unknownAnchorSeen = new Set<string>();

function logAndPosition(payload: IngestPayload): PositionRecord | null {
  // 반납했거나 등록 안 된 태그는 여기서 끝난다. 아래 어느 줄도 실행되지 않는다.
  if (!isCollecting(payload.tagId)) {
    noteDrop(payload.tagId);
    return null;
  }
  // 층을 먼저 정한다. 좌표는 층 판정에 관여하지 않는다 — 층은 앵커가 정한다.
  const floor = floorForPayload(payload);
  if (!floor) {
    const ids = ((payload as { ranges?: { anchorId: string }[] }).ranges ?? [])
      .map((r) => r.anchorId).join(', ');
    if (!unknownAnchorSeen.has(ids)) {
      unknownAnchorSeen.add(ids);
      console.warn(`[floor] 모르는 앵커라 프레임을 버립니다: ${ids}`
        + ` — map.json의 floors[].anchors에 없는 ID입니다`);
    }
    return null;
  }
  // 확인자료의 '수집'. 프레임마다가 아니라 세션 단위로 남는다 — 조문이 요구하는 것은
  // 처리 사실이지 프레임 이력이 아니다(spec 11 §4.6).
  if (payload.tagId) collectTracker.touch(payload.tagId);
  const handlePositioning = positioningFor(floor);
  const rawPosition = handlePositioning(payload as Parameters<typeof handlePositioning>[0]);
  warnIfGeometryBroken(rawPosition);
  noteSingleAnchorEstimate(rawPosition);
  // 평활화까지가 좌표를 다루는 마지막 자리다. 그 뒤 zonePolicy를 지나면 사생활 구역
  // 프레임에는 좌표가 없고, 아래 넷(방출·기록·로그·감지기)은 전부 지워진 것만 본다.
  const smoothed = rawPosition ? positionSmoother.observe(rawPosition) : null;
  // 층은 좌표에서 나온 값이 아니므로 사생활 필터를 지나도 남는다(spec system 03 §1).
  const withFloor = smoothed ? { ...smoothed, floor: floor.id } : null;
  const position = zonePolicy(floor, withFloor) as PositionRecord | null;
  if (position) broadcast('position', position);
  // 경보보다 먼저 넣는다. 판정은 정점 뒤 1.5초에 나므로, 경보가 등록되는 시점에는
  // 이 프레임까지가 이미 버퍼에 들어 있어야 한다.
  eventRecorder.observe(payload, position);
  console.log(formatIngestLine(payload, position, {
    mainAnchorId: floor.anchors[0] ?? anchorConfig.mainAnchorId,
    subAnchorId: floor.anchors[1] ?? anchorConfig.subAnchorId,
    gravity: DEFAULT_GRAVITY,
  }));

  let fallEvents: FallEvent[] = [];
  try {
    fallEvents = fallDetector.observe(payload, position);
  } catch (error: unknown) {
    console.error('[fall] detector error', error);
  }
  for (const event of fallEvents) {
    // 층은 좌표가 아니라 이 프레임이 온 앵커가 정한다. 좌표를 지운 사생활 구역
    // 경보에도 남는다 — 몇 층인지 모르면 관제사가 갈 수가 없다.
    event.floor = floor.id;
    // 좌표가 있으면 그 자리로 라벨을 다시 매긴다. **그 층의 구역만 본다.**
    // 사생활 구역은 좌표가 없으므로 감지기가 실어 보낸 구역명(마지막으로 본 구역)을 그대로 둔다.
    if (event.pos) event.zone = zoneAt(floor, event.pos.x, event.pos.y);
    // 쓰러진 사람은 누가 갈 때까지 그 자리에 있다. 시뮬이 이 태그를 계속 걷게 두면
    // 화면에는 경보가 떠 있는데 마커만 산책하는 상태가 된다. 푸는 것은 관제사가
    // 경보를 끌 때뿐이다(/alerts/resolve).
    alertedTags.add(event.tagId);
    sim.freeze(event.tagId);
    const ai = event.aiScore != null ? ` ai=${event.aiScore}` : '';
    const where = event.privacy ? `${event.zone ?? '사생활 구역'} · 좌표 미기록` : (event.zone ?? '-');
    console.log(`[fall] ${event.type} ${event.tagId} peak=${event.peakAccel}g freefall=${event.freefall}${ai} zone=${floor.id} ${where}`);
    broadcast('alert', event);
    // 확인자료의 '이용'. 좌표를 낙상 판정과 화면 표시에 썼다는 사실을 남긴다.
    // **좌표값 자체는 넣지 않는다** — 그러면 확인자료가 아니라 파기 대상이 된다.
    auditLog.record({
      kind: 'use',
      tagId: event.tagId,
      actor: 'system',
      // 층까지 남긴다. 구역명은 층마다 겹치므로("화장실(여)"는 네 층에 다 있다)
      // 층이 없으면 확인자료만 보고는 어디였는지 못 짚는다.
      detail: `낙상 감지 · ${event.eventId} · ${floor.name} ${event.zone ?? '구역 미지정'}`,
    });
    // zone까지 채운 뒤에 넘긴다 — 레코드의 alert는 SSE로 나간 것과 같아야 한다.
    liveAlerts.set(event.eventId, { ...event });
    eventRecorder.record(event);
  }
  return position;
}

// 측위 스트림은 sim 모드에서만 방출한다. live 모드에서는 실측 ingest만 /stream으로 나간다.
if (sourceMode === 'sim') {
  // 시뮬 좌표도 같은 관문 둘을 지난다 — 반납한 태그는 여기서도 안 나가고(제24조②),
  // 배경 태그가 화장실에 있으면 화면에서 사라진다(F-6).
  sim.on('position', (position: unknown) => {
    const frame = position as { tagId?: unknown; floor?: unknown } | null;
    if (!isCollecting(frame?.tagId)) return;
    // 시뮬은 층을 직접 싣고 온다(앵커가 없으므로 판정할 것이 없다). 구역 판정은
    // 실측과 똑같이 **그 층의 zones로만** 한다.
    const floor = typeof frame?.floor === 'string' ? floorIndex.byId(frame.floor) : null;
    if (!floor) return;   // 맵에 없는 층을 가리키는 프레임. 판정할 도면이 없다
    broadcast('position', zonePolicy(floor, position));
  });
  sim.start(5);
}

// 데모 주입기 — 데이터셋 클립을 ingest 프레임으로 되돌려 /ingest와 같은 길로 흘린다.
// 소스 모드와 무관하게 동작한다. 주입된 프레임은 그 자체가 ingest라, live 모드에서도
// 실측 프레임과 나란히 흐르는 게 맞다.
const clips = loadClips(path.join(import.meta.dirname, 'inject', 'clips'));
const injector = createInjector({
  clips,
  gravity: DEFAULT_GRAVITY,
  // 거리는 **그 태그가 있는 층의 앵커로** 합성한다. 실행 인자의 앵커 하나로 전부
  // 만들면 3층 태그에 넣은 낙상이 1층 사고로 기록된다 — 층은 앵커가 정하기 때문이다.
  rangesFor: (tagId) => {
    const point = sim.positionOf(tagId);
    if (!point) return null;
    const floorId = sim.floorIdOf(tagId);
    const floor = floorId ? floorIndex.byId(floorId) : null;
    return rangesForPoint(point, {
      ...anchorConfig,
      mainAnchorId: floor?.anchors[0] ?? anchorConfig.mainAnchorId,
      subAnchorId: floor?.anchors[1] ?? anchorConfig.subAnchorId,
    });
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

function sendJson(
  response: ServerResponse,
  value: unknown,
  status = 200,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
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

  // ── 관제사 식별(spec operation 03) ──────────────────────────────────────────
  //
  // **측위(/ingest)와 경보 수신(/stream)은 위에서 이미 지나갔다.** 식별은 조작의 조건이지
  // 감지의 조건이 아니다 — 세션이 없다고 낙상을 놓치면 본말전도다.
  const session = sessions.get(readCookie(request.headers.cookie, SESSION_COOKIE));
  /** 확인자료에 남길 행위자. **클라이언트가 보낸 이름은 쓰지 않는다** — 그건 위조 통로다. */
  const actor = session?.operatorId ?? UNIDENTIFIED;

  if (pathname === '/session') {
    // 교대 종료.
    if (request.method === 'DELETE') {
      const closed = sessions.close(session?.sid);
      if (closed) {
        auditLog.record({ kind: 'access', actor: closed.operatorId, detail: '관제 화면 교대 종료' });
        console.log(`[operators] ${closed.operatorId} 교대 종료`);
      }
      return sendJson(response, { ok: true }, 200, { 'Set-Cookie': clearedSessionCookie() });
    }
    // 관제사 선택.
    if (request.method === 'POST') {
      const operatorId = url.searchParams.get('operatorId') ?? '';
      if (!isValidOperatorId(operatorId)) {
        return sendJson(response, { ok: false, error: `잘못된 operatorId: ${operatorId}` }, 400);
      }
      const entry = operatorRegistry.get(operatorId);
      if (!entry || entry.removedAt != null) {
        return sendJson(response, { ok: false, error: '명부에 없거나 삭제된 관제사입니다' }, 409);
      }
      const opened = sessions.open(operatorId);
      // 만료 팝업의 `연장`이 부른 것인지 구분한다. 같은 사람이 세 시간마다 계속 연장만
      // 하고 있다면 그건 교대가 기록에 안 잡히고 있다는 뜻이라, 확인자료에서 보여야 한다.
      const renew = url.searchParams.get('renew') === '1';
      // 접속기록이다(개인정보보호법 시행령 제30조①5호). 확인자료 파일 하나로 같이 채운다.
      auditLog.record({
        kind: 'access',
        actor: operatorId,
        detail: `관제 화면 ${renew ? '연장' : '접속'} · ${entry.name}`,
      });
      console.log(`[operators] ${operatorId} ${renew ? '연장' : '접속'} · ${entry.name}`);
      return sendJson(
        response,
        { ok: true, operator: publicOperator(entry), expiresAt: opened.expiresAt },
        200,
        { 'Set-Cookie': sessionCookie(opened.sid, sessions.ttlMs) },
      );
    }
    // 화면이 선택창을 그리는 데 필요한 전부를 한 번에 준다.
    const current = session ? operatorRegistry.get(session.operatorId) : null;
    return sendJson(response, {
      ok: true,
      operator: current ? publicOperator(current) : null,
      expiresAt: session?.expiresAt ?? null,
      roster: operatorRegistry.active().map(publicOperator),
    });
  }

  // **명부 수정에는 세션이 필요 없다.** 처음에는 아무도 명부에 없어서, 식별을 요구하면
  // 첫 실행에서 누구도 들어갈 수 없다. 대신 그 행위 자체를 확인자료에 남긴다 —
  // 식별 없이 한 일이 있었다는 사실이 기록에 드러나는 것이 요점이다(spec operation 03 §2).
  if (pathname === '/operators/add') {
    if (request.method !== 'POST') return sendJson(response, { ok: false, error: 'POST만 받습니다' }, 405);
    const name = normalizeOperatorName(url.searchParams.get('name'));
    if (!name) return sendJson(response, { ok: false, error: '이름은 1~20자여야 합니다' }, 400);
    const entry = operatorRegistry.add(name, actor);
    if (!entry) return sendJson(response, { ok: false, error: '같은 이름이 이미 명부에 있습니다' }, 409);
    auditLog.record({ kind: 'access', actor, detail: `관제사 명부 추가 · ${entry.operatorId} ${name}` });
    console.log(`[operators] ${entry.operatorId} 추가 · ${name}`);
    return sendJson(response, { ok: true, operator: publicOperator(entry) });
  }
  if (pathname === '/operators/remove') {
    if (request.method !== 'POST') return sendJson(response, { ok: false, error: 'POST만 받습니다' }, 405);
    const operatorId = url.searchParams.get('operatorId') ?? '';
    if (!isValidOperatorId(operatorId)) {
      return sendJson(response, { ok: false, error: `잘못된 operatorId: ${operatorId}` }, 400);
    }
    const entry = operatorRegistry.remove(operatorId, actor);
    if (!entry) return sendJson(response, { ok: false, error: '명부에 없거나 이미 삭제된 관제사입니다' }, 409);
    // **명부에서 내린 사람의 세션도 함께 끊는다.** 안 끊으면 삭제한 사람이 남은 교대
    // 시간 동안 계속 판정한다. 반납이 곧 수집 중단인 것과 같은 결이다.
    const cut = sessions.closeOperator(operatorId);
    auditLog.record({ kind: 'access', actor, detail: `관제사 명부 삭제 · ${operatorId} ${entry.name}` });
    console.log(`[operators] ${operatorId} 삭제 · ${entry.name}${cut ? ' · 세션 종료' : ''}`);
    return sendJson(
      response,
      { ok: true, operator: publicOperator(entry), sessionClosed: cut !== null },
      200,
      // 자기 자신을 지웠으면 브라우저의 쿠키도 같이 비운다.
      cut && cut.sid === session?.sid ? { 'Set-Cookie': clearedSessionCookie() } : {},
    );
  }

  // 기록을 바꾸는 동작은 식별 없이 못 한다. 화면은 이 401을 받으면 선택창을 연다.
  if (!session && requiresOperator(request.method ?? 'GET', pathname)) {
    return sendJson(response, { ok: false, error: 'operator_required' }, 401);
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
    // 중지. **아래 수동 파기(DELETE)보다 먼저다** — 그쪽은 `/incidents/` 뒤를 통째로
    // id로 읽어서, 늦게 두면 이 주소가 "잘못된 id"로 떨어진다.
    if (request.method === 'DELETE') {
      const result = reconRunner.cancel(reconTarget);
      if (!result) {
        return sendJson(response, { ok: false, error: '대기·진행 중인 재구성이 아닙니다' }, 409);
      }
      auditLog.record({
        kind: 'access',
        actor,
        detail: `${reconTarget.eventId} 3D 재구성 중지 · ${reconTarget.attachmentId}`,
      });
      console.log(`[recon] ${reconTarget.eventId}/${reconTarget.attachmentId} 중지 요청 (${result})`);
      return sendJson(response, { ok: true, result });
    }
    if (request.method !== 'POST') return sendJson(response, { ok: false, error: 'POST·DELETE만 받습니다' }, 405);
    const attachment = eventAttachments.get(reconTarget.eventId, reconTarget.attachmentId);
    if (!attachment) return sendJson(response, { ok: false, error: '없는 첨부' }, 404);
    if (attachment.kind !== 'video') {
      return sendJson(response, { ok: false, error: `재구성 대상은 영상뿐입니다: kind=${attachment.kind}` }, 400);
    }
    const queued = reconRunner.enqueue({ ...reconTarget, tuning: tuningFromParams(url.searchParams) });
    if (queued) {
      auditLog.record({
        kind: 'access',
        actor,
        detail: `${reconTarget.eventId} 3D 재구성 실행 · ${reconTarget.attachmentId}`,
      });
    }
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
      // 사건 기록에 영상이 붙는 것도 기록의 변경이다. 누가 올렸는지를 확인자료에 남긴다.
      auditLog.record({
        kind: 'access',
        actor,
        detail: `${attachment.eventId} 현장 ${attachment.kind} 등록 · ${attachment.bytes}바이트`,
      });
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
    const result = judge(outcomeTarget, outcome, actor);
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
    auditLog.record({ kind: 'access', actor, detail: `${purgeTarget} 재구성 중간물 정리 요청` });
    return sendJson(response, { ok: true, eventId: purgeTarget, purged: actions.length, bytes });
  }

  // 학습 표본 수동 반출 — **시연용이다**(spec system 03 §7.2).
  //
  // 제품 경로는 파기 직전 하나뿐이다. 그 자리를 고른 이유가 번복 창이 닫혀 라벨이
  // 확정됐기 때문인데, 이 버튼은 **그 창을 건너뛴다** — 지금 로그에 있는 건은 아직
  // 뒤집힐 수 있고, 뒤집혀도 이미 나간 표본은 회수할 수 없다. 하루를 기다리지 않고
  // 파이프라인이 도는 것을 보이려고 둔 자리이며, 뽑는 것도 보내는 것도 제품과 같은 코드다.
  if (pathname === '/export/run') {
    if (request.method !== 'POST') return sendJson(response, { ok: false, error: 'POST만 받습니다' }, 405);
    let queued = 0;
    let skipped = 0;
    for (const summary of eventStore.list(Number.MAX_SAFE_INTEGER)) {
      const record = eventStore.read(summary.eventId);
      if (!record) continue;
      // 같은 건을 다시 눌러도 막지 않는다. 시연에서 두 번 나가는 것은 문제가 아니고,
      // 제품 경로에는 이 버튼이 없다.
      if (exporter.collect(record)) queued += 1;
      else skipped += 1;
    }
    auditLog.record({ kind: 'access', actor, detail: `학습 표본 수동 반출 · ${queued}건` });
    console.log(`[export] 수동 반출 ${queued}건 (판정 없음·창 미달 ${skipped}건 제외)`);
    exporter.flush()
      .catch(() => { /* flush는 안 던지지만, 던져도 응답은 나가야 한다 */ })
      .then(() => {
        const state = exporter.state();
        sendJson(response, {
          ok: true,
          queued,
          skipped,
          pending: exporter.pending(),
          configured: Boolean(exporter.config.url),
          ...(state.lastError ? { lastError: state.lastError } : {}),
        });
      });
    return;
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
        actor,
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
  // NI 토큰 우편함. 앵커 폰 두 대가 서로의 discoveryToken을 여기서 주고받는다.
  //
  // 워치는 짝폰(메인폰)하고만 통신할 수 있어 서브폰 몫 토큰은 메인폰이 중계해 왔는데, 그 폰↔폰
  // 구간이 Bonjour 탐색이라 Wi-Fi 환경을 탔다(같은 공유기여도 AP가 단말 간 통신을 막으면 못 찾는다).
  // 두 폰이 이미 주소를 아는 곳이 서버뿐이라 여기를 경유지로 쓴다. 자세한 근거는 ni/mailbox.ts.
  if (pathname === '/ni/token') {
    // 놓기. 본문은 앱이 Bonjour로 보내던 AddressedToken JSON 그대로다(부호화 변경 없음).
    if (request.method === 'POST') {
      readJsonBody(request, { limit: 16 * 1024 })
        .then((body) => {
          const message = parseTokenMessage(body);
          if (!message) return sendJson(response, { ok: false, error: '토큰 메시지 형식이 아닙니다' }, 400);
          const stored = tokenMailbox.put(message);
          return sendJson(response, { ok: true, at: stored.at });
        })
        .catch((error: unknown) => {
          if (error instanceof HttpBodyError) {
            return sendJson(response, { ok: false, error: error.message }, error.statusCode);
          }
          console.error('[ni] 토큰 저장 실패', error);
          return sendJson(response, { ok: false, error: 'internal_error' }, 500);
        });
      return;
    }
    // 가져가기. 지우지 않는다 — 응답을 한 번 놓쳐도 다음 조회에 다시 잡히고, 같은 토큰을
    // 두 번 받아도 앱이 아무것도 하지 않는다(runningToken 비교). 정리는 만료가 맡는다.
    const to = url.searchParams.get('to') ?? '';
    if (!isPeerId(to)) return sendJson(response, { ok: false, error: `잘못된 to: ${to}` }, 400);
    return sendJson(response, { ok: true, tokens: tokenMailbox.take(to) });
  }
  // 관제 화면이 쓰는 대상 명부. **수집 중인 태그만** 나간다 — 반납한 사람은 관제 대상이
  // 아니다. `{id, name}` 형태는 예전 계약 그대로다(화면이 이름을 여기서 찾는다).
  if (pathname === '/tags') {
    return sendJson(response, tagRegistry.active().map((t) => ({ id: t.tagId, name: t.label })));
  }
  // 관리 화면용. 반납분까지 이력 전체 + 문을 두드리는 미등록 태그를 같이 준다.
  if (pathname === '/tags/all') {
    return sendJson(response, { tags: tagRegistry.list(), pending: sightings.list() });
  }
  // 배정. 반납된 태그를 다시 등록하면 새 배정이 된다(같은 사람일 필요는 없다).
  if (pathname === '/tags/register') {
    const tagId = url.searchParams.get('tagId') ?? '';
    const label = normalizeLabel(url.searchParams.get('label'));
    if (!isValidTagId(tagId)) return sendJson(response, { ok: false, error: `잘못된 tagId: ${tagId}` }, 400);
    if (!label) return sendJson(response, { ok: false, error: '표시명은 1~40자여야 합니다' }, 400);
    const entry = registerTag(tagId, label, actor);
    console.log(`[tags] ${tagId} 등록 · ${label}`);
    return sendJson(response, { ok: true, tag: entry });
  }
  // 반납. 개인위치정보 수집 일시 중지를 이 절차로 갈음한다(위치정보법 제24조②).
  if (pathname === '/tags/release') {
    const tagId = url.searchParams.get('tagId') ?? '';
    if (!isValidTagId(tagId)) return sendJson(response, { ok: false, error: `잘못된 tagId: ${tagId}` }, 400);
    const entry = releaseTag(tagId, actor);
    if (!entry) return sendJson(response, { ok: false, error: '등록돼 있지 않거나 이미 반납한 태그입니다' }, 409);
    // 반납한 태그가 경보를 걸어 둔 채였다면 그 경보도 끝난다 — 대상이 관제에서 빠지므로
    // 화면에 남겨 두면 아무도 끌 수 없는 경보가 된다.
    alertedTags.delete(tagId);
    sim.unfreeze(tagId);
    // 화면이 이 태그를 목록에서 내리도록 알린다. 프레임이 그냥 끊기면 '측위 끊김'으로
    // 남아, 반납한 사람이 장애 상태로 계속 떠 있게 된다.
    broadcast('tags', { released: tagId, at: entry.releasedAt });
    console.log(`[tags] ${tagId} 반납 · 수집 중단 (${entry.label})`);
    return sendJson(response, { ok: true, tag: entry });
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
    // **보고 있는 층에서 일어나야 한다.** 화면이 현재 층을 실어 보내고, 없으면 앵커가
    // 깔린 층으로 본다 — 다른 층에서 들여보내면 관제사 화면에서는 아무 일도 안 일어난다.
    const askedFloor = url.searchParams.get('floor');
    const floor = (askedFloor ? floorIndex.byId(askedFloor) : null) ?? liveFloor;
    const zone = floor.zones.find((z) => z.privacy);
    if (!zone) {
      return sendJson(response, { ok: false, error: `${floor.name}에 사생활 구역이 없습니다` }, 400);
    }
    const [rx, ry, rw, rh] = zone.rect;
    const center = { x: rx + rw / 2, y: ry + rh / 2 };

    // 재생 중인 태그는 주입기가 좌표를 쥐고 있어 걷게 할 수 없다. 남은 것 중 제일 가까운 태그.
    const candidates = sim.tags
      // 그 층 사람만 보낸다. 층을 넘겨 걷게 하면 없는 기능(층간 이동)을 흉내내게 된다.
      .filter((tag: SimTag) => tag.floor === floor.id)
      // 반납한 태그는 어차피 프레임이 안 나가므로 보내 봐야 화면에 안 뜬다.
      .filter((tag: SimTag) => !sim.frozen.has(tag.id) && isCollecting(tag.id))
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
    console.log(`[demo] ${chosen.tag.id} → ${floor.id} ${zone.label} (약 ${(sent.etaMs / 1000).toFixed(1)}초)`);
    return sendJson(response, {
      ok: true, tagId: chosen.tag.id, name: chosen.tag.name,
      floor: floor.id, zone: zone.label, etaMs: sent.etaMs,
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
        actor,
        detail: `${eventId || tagId} 경보 해제 · 판정 보류`,
      });
    }

    const judged = outcome && eventId
      ? judge(eventId, outcome, actor, { allowPending: true })
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
  // 설정이 반영됐는지 확인할 자리. 없으면 전 항목이 기본값이라는 뜻이다.
  console.log(`  설정       ${envFile ?? '기본값 (server/.env 없음)'}`);
  console.log(`  대시보드   http://localhost:${shown}/`);
  console.log(`  SSE 스트림 http://localhost:${shown}/stream`);
  console.log(`  ingest     POST http://localhost:${shown}/ingest`);
  console.log(`  앵커       ${anchorConfig.mainAnchorId} (0,0) / ${anchorConfig.subAnchorId} (${anchorConfig.anchorDistance},0), ${anchorConfig.halfPlane}`);
  // 실측 프레임이 어느 층으로 기록되는지 밝힌다. 앵커 쌍이 하나뿐이라 live에서 사는 층은 이것 하나다.
  console.log(
    `  층         ${map.floors.map((f) => `${f.id} ${f.name}`).join(' · ')}`
    + `\n             실측 앵커가 가리키는 층 = ${liveFloor.id} ${liveFloor.name}`,
  );
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
  console.log(
    `  재구성 찌꺼기  성공 즉시 · 실패·중지는 ${retention.config.deadWorkdirGraceMs / 3_600_000}시간 뒤`
    + ' 중간물만 파기 (원본 영상·recon.log는 남는다, DEAD_WORKDIR_GRACE_HOURS)',
  );
  console.log(`  확인자료   ${auditLog.dir} (위치정보법 제16조② · 파기 금지)`);
  console.log(
    `  학습 반출  ${exporter.config.url || '전송 꺼짐 · 큐만 쌓는다 (EXPORT_URL)'}`
    + ' · 파기 직전 가속도 창 + 라벨만, 태그ID·시각·좌표 없음',
  );
  console.log(
    `  현장 영상  POST /incidents/<eventId>/attachments?kind=video (본문=파일 바이트)`
    + ` · 최대 ${Math.round(attachmentLimitBytes / 1024 / 1024)}MB (ATTACHMENT_LIMIT_MB)`
    + ` · 재구성 ${reconAutoLabel()}`,
  );
  console.log(
    `  재구성     ${reconTuning.ffmpegBin} → ${reconTuning.colmapBin} → ${reconTuning.openSplatBin}`
    + ` · 상류 기본 ${reconTuning.targetFrames}장`
    + ` · 가로 ${reconTuning.frameWidth > 0 ? `${reconTuning.frameWidth}px` : '원본'}`
    + ` · 학습 ${reconTuning.numIters}회 (화면에서 실행마다 바꾼다)`,
  );
  // 도구가 없으면 지금 알려준다. 재구성을 걸고 나서 알면 COLMAP을 몇 분 돌린 뒤다.
  // **없는 도구를 다 센다** — 하나씩 알려주면 깔고 다시 띄우기를 네 번 한다.
  if (reconMissing.length > 0) {
    console.warn(
      `  ⚠ 재구성 도구를 못 찾았습니다: ${reconMissing.join(', ')}.`
      + ' 영상 업로드와 3D 조회는 그대로 되고, 변환만 자동으로 걸지 않습니다.',
    );
    console.warn(
      '    조달·빌드는 tools/recon/README.md, 다른 자리에 있으면'
      + ' FFMPEG_BIN / FFPROBE_BIN / COLMAP_BIN / OPENSPLAT_BIN으로 지정하세요.',
    );
    console.warn(
      '    도구 없이 3D 화면만 보려면 이미 만들어진 .ply를 올리면 됩니다 —'
      + ' POST /incidents/<eventId>/attachments?kind=splat',
    );
  }
  console.log(`  주입 클립  ${clips.map((clip) => clip.id).join(', ')} (실제 파이프라인 통과)`);
  console.log(`  소스       ${sourceMode}${sourceMode === 'sim' ? ' (시뮬 자동 방출)' : ' (실측 ingest만 방출)'}`);
  // 어느 장부를 들고 있는지 밝힌다. 모드마다 다른 파일이라, 명부가 비어 보이는 게
  // 고장인지 다른 장부를 연 것인지 여기서 갈린다.
  console.log(`  태그 명부  ${tagRegistry.file} · 수집 중 ${tagRegistry.active().length}명`);
  console.log(
    `  관제사     ${operatorRegistry.file} · ${operatorRegistry.active().length}명`
    + ` · 세션 ${sessions.ttlMs / 3_600_000}시간 (SESSION_TTL_HOURS)`,
  );
  if (anchorConfig.singleAnchorBearingDeg !== undefined) {
    console.warn(
      `  ⚠ 1앵커 테스트 모드 — 서브 앵커 거리가 없으면 ${anchorConfig.mainAnchorId} 거리를`
      + ` ${anchorConfig.singleAnchorBearingDeg}도 방향에 얹어 좌표를 만듭니다.`
      + ' 거리만 실측이고 방향은 가짜이므로 리허설·시연에는 끄고 실행하세요.',
    );
  }
  // 지난 실행에서 끊긴 재구성을 먼저 되돌린다. 재구성은 이 프로세스 안에서 도므로
  // 서버가 죽으면 도구도 죽는데 레코드는 `running`인 채 남는다 — 그대로 두면 화면은
  // 영영 "변환 중"으로 보이고, 파기도 그 폴더를 `done`이 아니라며 지나친다.
  // **파기보다 먼저 돌아야 한다** — 되돌려야 아래 sweep이 그 중간물을 거둘 수 있다.
  for (const id of recoverInterrupted(incidentStore, eventAttachments)) {
    console.log(`[recon] ⚠ 지난 실행에서 끊긴 재구성을 실패로 되돌렸다 — ${id}`);
  }
  // 기동 시 한 번 훑는다. 서버가 꺼져 있던 사이에 만료된 것을 여기서 거둔다.
  retention.start();
  // 지난 실행에서 못 보낸 배치를 여기서 거둔다. **파기 루프에만 매달면** 뽑을 것이 있을
  // 때만 큐가 비워져, 수집 서버가 죽었다 살아나도 다음 파기까지 밀린 배치가 앉아 있다.
  exporter.start();
});

// 열려 있는 수집 세션을 닫고 나간다. 안 닫으면 확인자료에 개시만 남고 종료가 없다.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    collectTracker.flush();
    retention.stop();
    exporter.stop();
    process.exit(0);
  });
}
