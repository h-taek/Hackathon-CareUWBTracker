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
  DEFAULT_POSITION_WINDOW,
  type PositionRecord,
} from './positioning/smoother.ts';
import { handleIngest } from './ingest/endpoint.ts';
import { createPositioningHandler } from './positioning/handler.ts';
import { Simulator, isFallScenario, type SimTag, type SimMap } from './sim.ts';
import { formatIngestLine, DEFAULT_GRAVITY, type IngestPayload } from './lib/ingest-log.ts';
import { createFallDetector, optionsFromEnv, type FallEvent } from './detection/fall.ts';
import { createCascadeDetector } from './detection/cascade.ts';
import { zoneAt } from './lib/zone.ts';
import { createStaticHandler } from './static/handler.ts';

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
    const detector = createCascadeDetector(optionsFromEnv());
    console.log('[fall] 2단계 캐스케이드(고전+LightGBM) 모드');
    return detector;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[fall] AI 모델 로드 실패 → 고전 단독 폴백: ${message}`);
    return createFallDetector(optionsFromEnv());
  }
})();
const positionSmoother = createPositionSmoother(DEFAULT_POSITION_WINDOW);
const clients = new Set<ServerResponse>();

function broadcast(event: 'position' | 'alert', data: unknown): void {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const response of clients) response.write(frame);
}

const handlePositioning = createPositioningHandler({
  ...anchorConfig,
});

function logAndPosition(payload: IngestPayload): PositionRecord | null {
  const rawPosition = handlePositioning(payload as Parameters<typeof handlePositioning>[0]);
  const position = rawPosition ? positionSmoother.observe(rawPosition) : null;
  if (position) broadcast('position', position);
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
  }
  return position;
}

// 측위 스트림은 sim 모드에서만 방출한다. live 모드에서는 실측 ingest만 /stream으로 나간다.
if (sourceMode === 'sim') {
  sim.on('position', (position: unknown) => broadcast('position', position));
  sim.start(5);
}

// 낙상 주입은 소스와 무관하게 살려둔다. 손으로 누르는 데모 트리거라 실측 위치를 보면서
// 경보 UI만 확인하고 싶은 상황이 실제로 생긴다. 예전에는 이 구독이 sim 모드 안에 있어
// live로 띄우면 버튼이 성공 응답을 주면서 아무 일도 안 했다 — 가장 나쁜 조합이다.
sim.on('alert', (alert: unknown) => broadcast('alert', alert));

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
  if (pathname === '/map') return sendJson(response, map);
  if (pathname === '/inject-fall') {
    const requested = url.searchParams.get('scenario') ?? 'confirm';
    if (!isFallScenario(requested)) {
      return sendJson(response, { ok: false, error: 'scenario는 confirm 또는 cancel이어야 합니다.' }, 400);
    }
    const alert = sim.injectFall(url.searchParams.get('tagId') ?? '', requested);
    return sendJson(response, { ok: true, scenario: requested, alert });
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
  console.log(`시물 스트림 서버 실행: http://localhost:${port}`);
  console.log(`  대시보드   http://localhost:${port}/`);
  console.log(`  SSE 스트림 http://localhost:${port}/stream`);
  console.log(`  ingest     POST http://localhost:${port}/ingest`);
  console.log(`  앵커       ${anchorConfig.mainAnchorId} (0,0) / ${anchorConfig.subAnchorId} (${anchorConfig.anchorDistance},0), ${anchorConfig.halfPlane}`);
  console.log(`  스무딩     태그별 최근 ${DEFAULT_POSITION_WINDOW}개 좌표 이동평균`);
  console.log(`  소스       ${sourceMode}${sourceMode === 'sim' ? ' (시뮬 자동 방출)' : ' (실측 ingest만 방출)'}`);
});
