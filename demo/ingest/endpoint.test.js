'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { handleIngest } = require('./endpoint');

function validPayload(overrides = {}) {
  return {
    tagId: 'tag-watch',
    ts: 123456789,
    ranges: [
      { anchorId: 'phoneMain', distance: 1.23 },
      { anchorId: 'phoneSub', distance: 2.34 },
    ],
    accel: { x: 0, y: 0, z: 9.81 },
    source: 'sim',
    ...overrides,
  };
}

async function withServer(options, run) {
  const server = http.createServer((req, res) => handleIngest(req, res, options));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    await run(`http://127.0.0.1:${address.port}/ingest`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('정상 ingest를 콜백에 넘기고 202를 반환한다', async () => {
  const received = [];
  await withServer({ onIngest: (payload) => received.push(payload) }, async (url) => {
    const payload = validPayload();
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { ok: true });
    assert.deepEqual(received, [payload]);
  });
});

test('스키마 오류를 issues와 함께 400으로 반환한다', async () => {
  await withServer({}, async (url) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validPayload({
        tagId: '',
        ranges: [
          { anchorId: 'phoneMain', distance: 1 },
          { anchorId: 'phoneSub', distance: 2 },
          { anchorId: 'phoneThird', distance: 3 },
        ],
      })),
    });
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.error, 'invalid_ingest');
    assert.ok(body.issues.includes('tagId must be a non-empty string'));
    assert.ok(body.issues.includes('ranges must be an array of at most two anchors'));
  });
});

test('잘못된 JSON과 Content-Type을 각각 400, 415로 반환한다', async () => {
  await withServer({}, async (url) => {
    const invalidJson = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{bad-json}',
    });
    assert.equal(invalidJson.status, 400);
    assert.equal((await invalidJson.json()).error, 'invalid_json');

    const text = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: '{}',
    });
    assert.equal(text.status, 415);
    assert.equal((await text.json()).error, 'unsupported_media_type');
  });
});

test('POST가 아닌 메서드는 Allow 헤더와 405를 반환한다', async () => {
  await withServer({}, async (url) => {
    const response = await fetch(url);
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'POST');
  });
});
