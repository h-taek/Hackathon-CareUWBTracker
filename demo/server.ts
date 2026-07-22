'use strict';

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AnchorConfig } from './config/anchor.ts';
import type { PositionRecord } from './positioning/smoother.ts';

const {
  ANCHOR_CONFIG_USAGE,
  parseAnchorConfig,
  wantsAnchorConfigHelp,
} = require('./config/anchor.ts');
const {
  createPositionSmoother,
  DEFAULT_POSITION_WINDOW,
} = require('./positioning/smoother.ts');

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { handleIngest } = require('./ingest/endpoint.js');
const { createPositioningHandler } = require('./positioning/handler.js');
const { Simulator } = require('./sim.js');
const { formatIngestLine, DEFAULT_GRAVITY } = require('./lib/ingest-log.js');
const { createFallDetector, optionsFromEnv } = require('./detection/fall.js');
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
  pos?: Position;
  zone?: string | null;
}

interface SimTag {
  id: string;
  name: string;
}

const args = process.argv.slice(2);
if (wantsAnchorConfigHelp(args)) {
  console.log(ANCHOR_CONFIG_USAGE);
  process.exit(0);
}

let anchorConfig: AnchorConfig;
try {
  anchorConfig = parseAnchorConfig(args);
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`앵커 설정 오류: ${message}\n`);
  console.error(ANCHOR_CONFIG_USAGE);
  process.exit(1);
}

const port = Number(process.env.PORT ?? 8080);
const map: JsonObject = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'map.json'), 'utf8'),
);
const sim = new Simulator(map);
const fallDetector = createFallDetector(optionsFromEnv());
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
  const rawPosition: PositionRecord | null = handlePositioning(payload);
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
    console.log(`[fall] ${event.type} ${event.tagId} peak=${event.peakAccel}g freefall=${event.freefall} zone=${event.zone ?? '-'}`);
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
  console.log(`  앵커       ${anchorConfig.mainAnchorId} (0,0) / ${anchorConfig.subAnchorId} (${anchorConfig.anchorDistance},0), ${anchorConfig.halfPlane}`);
  console.log(`  스무딩     태그별 최근 ${DEFAULT_POSITION_WINDOW}개 좌표 이동평균`);
});
