'use strict';

import type { IncomingMessage, ServerResponse } from 'node:http';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { handleIngest } = require('./ingest/endpoint.js');
const { createPositioningHandler } = require('./positioning/handler.js');
const { Simulator } = require('./sim.js');
const { formatIngestLine, DEFAULT_GRAVITY } = require('./lib/ingest-log.js');
const { createFallDetector, optionsFromEnv } = require('./detection/fall.js');
const { createCascadeDetector } = require('./detection/cascade.js');
const { zoneAt } = require('./lib/zone.js');

type JsonObject = Record<string, unknown>;

interface Position extends JsonObject {
  x: number;
  y: number;
}

interface IngestPayload extends JsonObject {
  tagId: string;
}

interface FallEvent extends JsonObject {
  type: string;
  tagId: string;
  peakAccel: number;
  freefall: boolean;
  aiScore?: number;
  pos?: Position;
  zone?: string | null;
}

interface SimTag {
  id: string;
  name: string;
}

const port = Number(process.env.PORT ?? 8080);
const map: JsonObject = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'map.json'), 'utf8'),
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
const clients = new Set<ServerResponse>();

function broadcast(event: 'position' | 'alert', data: unknown): void {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const response of clients) response.write(frame);
}

const mainAnchorId = process.env.MAIN_ANCHOR_ID ?? 'phoneMain';
const subAnchorId = process.env.SUB_ANCHOR_ID ?? 'phoneSub';
const handlePositioning = createPositioningHandler({
  mainAnchorId,
  subAnchorId,
  anchorDistance: Number(process.env.ANCHOR_DISTANCE ?? 4),
  halfPlane: process.env.HALF_PLANE ?? 'positive',
}, (position: Position) => broadcast('position', position));

function logAndPosition(payload: IngestPayload): Position | null {
  const position: Position | null = handlePositioning(payload);
  console.log(formatIngestLine(payload, position, {
    mainAnchorId,
    subAnchorId,
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

sim.on('position', (position: Position) => broadcast('position', position));
sim.on('alert', (alert: FallEvent) => broadcast('alert', alert));
sim.start(5);

function sendJson(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(value));
}

function sendFile(response: ServerResponse, file: string, type: string): void {
  fs.readFile(file, (error: NodeJS.ErrnoException | null, buffer: Buffer) => {
    if (error) {
      response.writeHead(404);
      response.end('not found');
      return;
    }
    response.writeHead(200, { 'Content-Type': type });
    response.end(buffer);
  });
}

const server = http.createServer((request: IncomingMessage, response: ServerResponse) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  const { pathname } = url;

  if (pathname === '/ingest') {
    handleIngest(request, response, { onIngest: logAndPosition });
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
    const alert = sim.injectFall(url.searchParams.get('tagId') ?? '');
    return sendJson(response, { ok: true, alert });
  }
  if (pathname === '/tags') {
    return sendJson(response, sim.tags.map((tag: SimTag) => ({ id: tag.id, name: tag.name })));
  }
  if (pathname === '/' || pathname === '/index.html') {
    return sendFile(
      response,
      path.join(__dirname, 'public', 'index.html'),
      'text/html; charset=utf-8',
    );
  }

  response.writeHead(404);
  response.end('not found');
});

server.listen(port, () => {
  console.log(`시물 스트림 서버 실행: http://localhost:${port}`);
  console.log(`  대시보드   http://localhost:${port}/`);
  console.log(`  SSE 스트림 http://localhost:${port}/stream`);
  console.log(`  ingest     POST http://localhost:${port}/ingest`);
});
