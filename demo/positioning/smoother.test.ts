'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createPositionSmoother } = require('./smoother.ts');

function position(tagId: string, x: number, y = 0, z = 0) {
  return {
    tagId,
    ts: x,
    pos: { x, y, z },
    source: 'uwb+imu',
  };
}

test('첫 좌표는 지연 없이 그대로 반환한다', () => {
  const smoother = createPositionSmoother(3);
  assert.deepEqual(smoother.observe(position('tag-a', 3, 6, 0)), position('tag-a', 3, 6, 0));
});

test('윈도우가 차는 동안 좌표 산술평균을 반환한다', () => {
  const smoother = createPositionSmoother(3);
  smoother.observe(position('tag-a', 1, 2, 0));
  const result = smoother.observe(position('tag-a', 3, 4, 2));

  assert.deepEqual(result.pos, { x: 2, y: 3, z: 1 });
  assert.equal(result.ts, 3);
  assert.equal(result.source, 'uwb+imu');
});

test('윈도우를 넘으면 가장 오래된 좌표를 제외한다', () => {
  const smoother = createPositionSmoother(2);
  smoother.observe(position('tag-a', 1));
  smoother.observe(position('tag-a', 3));
  const result = smoother.observe(position('tag-a', 7));

  assert.equal(result.pos.x, 5);
});

test('태그별 윈도우를 독립적으로 유지한다', () => {
  const smoother = createPositionSmoother(2);
  smoother.observe(position('tag-a', 0));
  smoother.observe(position('tag-b', 100));

  assert.equal(smoother.observe(position('tag-a', 2)).pos.x, 1);
  assert.equal(smoother.observe(position('tag-b', 104)).pos.x, 102);
});

test('입력 객체와 원본 pos를 변경하지 않는다', () => {
  const smoother = createPositionSmoother(2);
  const input = position('tag-a', 2);
  smoother.observe(position('tag-a', 0));
  const result = smoother.observe(input);

  assert.notEqual(result, input);
  assert.notEqual(result.pos, input.pos);
  assert.deepEqual(input.pos, { x: 2, y: 0, z: 0 });
});

test('태그 하나 또는 전체 상태를 초기화한다', () => {
  const smoother = createPositionSmoother(2);
  smoother.observe(position('tag-a', 0));
  smoother.observe(position('tag-b', 100));
  smoother.reset('tag-a');

  assert.equal(smoother.observe(position('tag-a', 4)).pos.x, 4);
  assert.equal(smoother.observe(position('tag-b', 104)).pos.x, 102);

  smoother.reset();
  assert.equal(smoother.observe(position('tag-b', 200)).pos.x, 200);
});

test('잘못된 윈도우와 좌표를 거부한다', () => {
  assert.throws(() => createPositionSmoother(0), /positive integer/);
  assert.throws(() => createPositionSmoother(1.5), /positive integer/);

  const smoother = createPositionSmoother();
  assert.throws(() => smoother.observe(position('', 1)), /tagId/);
  assert.throws(() => smoother.observe(position('tag-a', Number.NaN)), /pos.x/);
});
