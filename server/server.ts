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
import { createStaticHandler } from './static/handler.ts';
import { createEventRecorder, recorderOptionsFromEnv, RECORDER_DEFAULTS } from './events/recorder.ts';
import { createEventStore } from './events/store.ts';
import { routeEvents } from './events/routes.ts';

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
const eventStore = createEventStore(
  process.env.EVENTS_DIR || path.join(import.meta.dirname, 'data', 'events'),
);
const eventRecorder = createEventRecorder({
  ...recorderConfig,
  onRecord: (record) => {
    eventStore.save(record);
    console.log(
      `[event] 기록 ${record.eventId} (${record.tagId})`
      + ` 궤적 ${record.track.length}점 · 가속도 ${record.accel.length}표본 → ${eventStore.dir}`,
    );
  },
  // 디스크가 차거나 권한이 없어도 관제는 계속 돌아야 한다. 기록만 잃고 경보는 이미 나갔다.
  onError: (error, record) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[event] ⚠ ${record.eventId} 기록 실패 — 경보는 정상 발행됐습니다: ${message}`);
  },
});

function broadcast(event: 'position' | 'alert', data: unknown): void {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const response of clients) response.write(frame);
}

const handlePositioning = createPositioningHandler({
  ...anchorConfig,
});

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
  const rawPosition = handlePositioning(payload as Parameters<typeof handlePositioning>[0]);
  warnIfGeometryBroken(rawPosition);
  noteSingleAnchorEstimate(rawPosition);
  const position = rawPosition ? positionSmoother.observe(rawPosition) : null;
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
    if (event.pos) event.zone = zoneAt(map, event.pos.x, event.pos.y);
    const ai = event.aiScore != null ? ` ai=${event.aiScore}` : '';
    console.log(`[fall] ${event.type} ${event.tagId} peak=${event.peakAccel}g freefall=${event.freefall}${ai} zone=${event.zone ?? '-'}`);
    broadcast('alert', event);
    // zone까지 채운 뒤에 넘긴다 — 레코드의 alert는 SSE로 나간 것과 같아야 한다.
    eventRecorder.record(event);
  }
  return position;
}

// 측위 스트림은 sim 모드에서만 방출한다. live 모드에서는 실측 ingest만 /stream으로 나간다.
if (sourceMode === 'sim') {
  sim.on('position', (position: unknown) => broadcast('position', position));
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
    sim.unfreeze(tagId);
    console.log(`[inject] ${tagId} ${completed ? '재생 끝' : '중단'} ${clip.id}`);
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
  const eventRoute = routeEvents(pathname, url.searchParams, eventStore);
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
  console.log(`  이벤트 조회 GET http://localhost:${shown}/events · /events/<eventId>`);
  console.log(`  주입 클립  ${clips.map((clip) => clip.id).join(', ')} (실제 파이프라인 통과)`);
  console.log(`  소스       ${sourceMode}${sourceMode === 'sim' ? ' (시뮬 자동 방출)' : ' (실측 ingest만 방출)'}`);
  if (anchorConfig.singleAnchorBearingDeg !== undefined) {
    console.warn(
      `  ⚠ 1앵커 테스트 모드 — 서브 앵커 거리가 없으면 ${anchorConfig.mainAnchorId} 거리를`
      + ` ${anchorConfig.singleAnchorBearingDeg}도 방향에 얹어 좌표를 만듭니다.`
      + ' 거리만 실측이고 방향은 가짜이므로 리허설·시연에는 끄고 실행하세요.',
    );
  }
});
