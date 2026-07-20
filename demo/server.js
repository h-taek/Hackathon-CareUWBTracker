'use strict';

// 시뮬 측위 스트림 서버 (의존성 0, Node 내장 http만 사용).
// spec 03 계약 구현: GET /stream(SSE), GET /map(정적 JSON), GET / (2D 대시보드).
// 실행:  node demo/server.js   그리고 브라우저로 http://localhost:8080 접속.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { handleIngest } = require('./ingest/endpoint');
const { createPositioningHandler } = require('./positioning/handler');
const { Simulator } = require('./sim');
const { formatIngestLine, DEFAULT_GRAVITY } = require('./lib/ingest-log');
const { createFallDetector, optionsFromEnv } = require('./detection/fall');
const { zoneAt } = require('./lib/zone');

const PORT = process.env.PORT || 8080;
const map = JSON.parse(fs.readFileSync(path.join(__dirname, 'map.json'), 'utf8'));

const sim = new Simulator(map);
const fallDetector = createFallDetector(optionsFromEnv());
const clients = new Set(); // 현재 연결된 SSE 응답 객체들

// 시뮬 이벤트 -> 모든 SSE 클라이언트로 브로드캐스트.
function broadcast(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(frame);
}
const MAIN_ANCHOR_ID = process.env.MAIN_ANCHOR_ID || 'phoneMain';
const SUB_ANCHOR_ID = process.env.SUB_ANCHOR_ID || 'phoneSub';

const handlePositioning = createPositioningHandler({
  mainAnchorId: MAIN_ANCHOR_ID,
  subAnchorId: SUB_ANCHOR_ID,
  anchorDistance: Number(process.env.ANCHOR_DISTANCE || 4),
  halfPlane: process.env.HALF_PLANE || 'positive',
}, (position) => broadcast('position', position));

// 수신 관측용: 삼각측량을 시도(2앵커면 좌표, 부족하면 null)한 뒤, 프레임을 콘솔 한 줄로 찍는다.
// 포맷은 lib/ingest-log.js가 담당(순수 함수). accel-only(ranges:[])도 여기서 보이므로 "폰->서버 도착" 확인 가능.
function logAndPosition(payload) {
  const position = handlePositioning(payload);
  console.log(formatIngestLine(payload, position, {
    mainAnchorId: MAIN_ANCHOR_ID,
    subAnchorId: SUB_ANCHOR_ID,
    gravity: DEFAULT_GRAVITY,
  }));
  for (const evt of fallDetector.observe(payload, position)) {
    if (evt.pos) evt.zone = zoneAt(map, evt.pos.x, evt.pos.y);
    console.log(`[fall] ${evt.type} ${evt.tagId} peak=${evt.peakAccel}g freefall=${evt.freefall} zone=${evt.zone ?? '-'}`);
    broadcast('alert', evt);
  }
  return position;
}
sim.on('position', (p) => broadcast('position', p));
sim.on('alert', (a) => broadcast('alert', a));
sim.start(5); // 5Hz

function sendJSON(res, obj, status = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendFile(res, file, type) {
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': type });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  // 기기/B0 하네스의 원시 거리·가속도 수집. B2는 onIngest에서 연결한다.
  if (pathname === '/ingest') {
    handleIngest(req, res, {
      onIngest: logAndPosition,
    });
    return;
  }

  // 1) SSE 위치/경보 스트림.
  if (pathname === '/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 2000\n\n'); // 끊기면 2초 후 재연결
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  // 2) 맵 메타(좌표계 범위·구역).
  if (pathname === '/map') return sendJSON(res, map);

  // 3) 낙상 주입(데모 트리거). 대시보드 버튼이 호출.
  if (pathname === '/inject-fall') {
    const tagId = url.searchParams.get('tagId') || '';
    const alert = sim.injectFall(tagId);
    return sendJSON(res, { ok: true, alert });
  }

  // 4) 태그 목록(대시보드 낙상 버튼 구성용).
  if (pathname === '/tags') {
    return sendJSON(res, sim.tags.map((t) => ({ id: t.id, name: t.name })));
  }

  // 5) 대시보드 정적 파일.
  if (pathname === '/' || pathname === '/index.html') {
    return sendFile(res, path.join(__dirname, 'public', 'index.html'), 'text/html; charset=utf-8');
  }

  res.writeHead(404);
  res.end('not found');
});

server.listen(PORT, () => {
  console.log(`시뮬 스트림 서버 실행: http://localhost:${PORT}`);
  console.log(`  대시보드   http://localhost:${PORT}/`);
  console.log(`  SSE 스트림 http://localhost:${PORT}/stream`);
  console.log(`  ingest     POST http://localhost:${PORT}/ingest`);
});
