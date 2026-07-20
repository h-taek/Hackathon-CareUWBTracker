'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { formatIngestLine } = require('./ingest-log');

const OPTS = { mainAnchorId: 'phoneMain', subAnchorId: 'phoneSub', gravity: 9.80665 };

function payload(overrides = {}) {
  return {
    tagId: 'tag-watch',
    ts: 0, // 1970-01-01T00:00:00Z 근방(로컬 타임존 무관하게 time 필드가 렌더되는지만 확인)
    ranges: [],
    accel: { x: 0, y: 0, z: 9.80665 },
    source: 'ni',
    ...overrides,
  };
}

test('accel-only(빈 ranges)면 두 슬롯을 -로, pos를 (-,-)로, accel-only 표기한다', () => {
  const line = formatIngestLine(payload(), null, OPTS);
  assert.match(line, /phoneMain=- phoneSub=-/);
  assert.match(line, /\(accel-only\)/);
  assert.match(line, /pos=\(-, -\)/);
  assert.match(line, /\|a\|=9\.81 m\/s² \(1\.00g\)/);
});

test('메인만 있으면 서브는 -로 남고 pos는 여전히 (-,-)', () => {
  const line = formatIngestLine(
    payload({ ranges: [{ anchorId: 'phoneMain', distance: 1.234 }] }), null, OPTS);
  assert.match(line, /phoneMain=1\.23m phoneSub=-/);
  assert.doesNotMatch(line, /accel-only/);
  assert.match(line, /pos=\(-, -\)/);
});

test('두 앵커 + position이면 pos에 좌표를 찍는다', () => {
  const position = { pos: { x: 1, y: 2, z: 0 } };
  const line = formatIngestLine(
    payload({ ranges: [
      { anchorId: 'phoneMain', distance: 1 },
      { anchorId: 'phoneSub', distance: 2 },
    ] }), position, OPTS);
  assert.match(line, /phoneMain=1\.00m phoneSub=2\.00m/);
  assert.match(line, /pos=\(1\.00, 2\.00\)/);
});

test('예상 밖 앵커는 두 슬롯 뒤에 덧붙인다', () => {
  const line = formatIngestLine(
    payload({ ranges: [{ anchorId: 'phoneThird', distance: 3 }] }), null, OPTS);
  assert.match(line, /phoneMain=- phoneSub=- phoneThird=3\.00m/);
});
