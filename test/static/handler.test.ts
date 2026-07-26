import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as path from 'node:path';

import { createStaticHandler } from '../../server/static/handler.ts';

const publicRoot = path.join(import.meta.dirname, '..', '..', 'server', 'public');

// 실제 소켓으로 왕복시킨다. 헤더 누락은 mock 응답으로는 잘 안 잡힌다.
async function request(
  pathname: string,
  headers: http.OutgoingHttpHeaders = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
  const serveStatic = createStaticHandler(publicRoot);
  const server = http.createServer((req, res) => {
    if (serveStatic(req, res, new URL(req.url ?? '/', 'http://x').pathname)) return;
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as { port: number };

  try {
    return await new Promise((resolve, reject) => {
      const req = http.get({ port, path: pathname, headers }, (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
      });
      req.on('error', reject);
    });
  } finally {
    server.close();
  }
}

// 이 헤더가 빠지면 SharedArrayBuffer가 사라지고 스플랫 뷰어가 느린 정렬 경로로 조용히 내려간다.
test('정적 응답에 교차출처 격리 헤더가 실린다', async () => {
  const { status, headers } = await request('/');
  assert.equal(status, 200);
  assert.equal(headers['cross-origin-opener-policy'], 'same-origin');
  assert.equal(headers['cross-origin-embedder-policy'], 'require-corp');
});

test('304 재검증 응답에도 격리 헤더가 실린다', async () => {
  const first = await request('/');
  const lastModified = first.headers['last-modified'];
  assert.ok(lastModified);

  const { status, headers } = await request('/', { 'If-Modified-Since': lastModified });
  assert.equal(status, 304);
  assert.equal(headers['cross-origin-opener-policy'], 'same-origin');
  assert.equal(headers['cross-origin-embedder-policy'], 'require-corp');
});

test('없는 경로는 정적 핸들러를 통과해 404로 떨어진다', async () => {
  const { status } = await request('/nope.txt');
  assert.equal(status, 404);
});
