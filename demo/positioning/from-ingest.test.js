'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { positionFromIngest } = require('./from-ingest');

const OPTIONS = Object.freeze({
  mainAnchorId: 'phoneMain',
  subAnchorId: 'phoneSub',
  anchorDistance: 4,
  halfPlane: 'positive',
});

function ingest(ranges, overrides = {}) {
  return {
    tagId: 'tag-watch',
    ts: 123456789,
    ranges,
    accel: { x: 0, y: 0, z: 9.81 },
    source: 'ni',
    ...overrides,
  };
}

function assertClose(actual, expected, tolerance = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= tolerance);
}

test('앵커 배열 순서와 무관하게 ID로 거리를 찾아 position을 만든다', () => {
  const position = positionFromIngest(ingest([
    { anchorId: 'phoneSub', distance: Math.sqrt(13) },
    { anchorId: 'phoneMain', distance: Math.sqrt(5) },
  ]), OPTIONS);

  assertClose(position.pos.x, 1);
  assertClose(position.pos.y, 2);
  assert.equal(position.pos.z, 0);
  assert.deepEqual(position.err, { xy: 0.2, z: 1.2 });
  assert.deepEqual(position.accel, { x: 0, y: 0, z: 9.81 });
  assert.equal(position.source, 'uwb+imu');
});

test('sim ingest는 position의 source도 sim으로 유지한다', () => {
  const position = positionFromIngest(ingest([
    { anchorId: 'phoneMain', distance: Math.sqrt(5) },
    { anchorId: 'phoneSub', distance: Math.sqrt(13) },
  ], { source: 'sim' }), OPTIONS);

  assert.equal(position.source, 'sim');
});

test('필요한 앵커가 하나라도 없으면 좌표 계산을 보류한다', () => {
  assert.equal(positionFromIngest(ingest([
    { anchorId: 'phoneMain', distance: 1 },
  ]), OPTIONS), null);
  assert.equal(positionFromIngest(ingest([
    { anchorId: 'unknown', distance: 1 },
    { anchorId: 'phoneMain', distance: 1 },
  ]), OPTIONS), null);
});

test('음수 반평면과 사용자 지정 오차 반경을 전달한다', () => {
  const position = positionFromIngest(ingest([
    { anchorId: 'phoneMain', distance: Math.sqrt(5) },
    { anchorId: 'phoneSub', distance: Math.sqrt(13) },
  ]), { ...OPTIONS, halfPlane: 'negative', xyError: 0.3, zError: 1.5 });

  assertClose(position.pos.y, -2);
  assert.deepEqual(position.err, { xy: 0.3, z: 1.5 });
});

test('앵커 설정 누락과 동일한 앵커 ID를 거부한다', () => {
  const payload = ingest([]);
  assert.throws(() => positionFromIngest(payload), /positioning options are required/);
  assert.throws(
    () => positionFromIngest(payload, { mainAnchorId: '', subAnchorId: 'phoneSub' }),
    /mainAnchorId must be a non-empty string/,
  );
  assert.throws(
    () => positionFromIngest(payload, { mainAnchorId: 'same', subAnchorId: 'same' }),
    /must be different/,
  );
});
