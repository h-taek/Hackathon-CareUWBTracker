import * as assert from 'node:assert/strict';
import test from 'node:test';
import { triangulateTwoAnchors } from '../../demo/positioning/triangulate.ts';

function assertClose(actual: number, expected: number, tolerance = 1e-9): void {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `expected ${actual} to be within ${tolerance} of ${expected}`,
  );
}

test('알려진 1사분면 좌표를 두 거리로 복원한다', () => {
  const position = triangulateTwoAnchors({
    rA: Math.sqrt(5),
    rB: Math.sqrt(13),
    d: 4,
    halfPlane: 'positive',
  });

  assertClose(position.x, 1);
  assertClose(position.y, 2);
});

test('negative 반평면이면 같은 교점의 y 부호를 뒤집는다', () => {
  const position = triangulateTwoAnchors({
    rA: Math.sqrt(5),
    rB: Math.sqrt(13),
    d: 4,
    halfPlane: 'negative',
  });

  assertClose(position.x, 1);
  assertClose(position.y, -2);
});

test('앵커 기준선 위의 좌표를 계산한다', () => {
  const position = triangulateTwoAnchors({ rA: 2, rB: 2, d: 4 });
  assertClose(position.x, 2);
  assert.equal(position.y, 0);
});

test('측정 오차로 y 제곱이 음수면 spec 03에 따라 0으로 클램프한다', () => {
  const position = triangulateTwoAnchors({ rA: 1, rB: 10, d: 4 });
  assertClose(position.x, -10.375);
  assert.equal(position.y, 0);
});

test('잘못된 거리·앵커 간격·반평면을 거부한다', () => {
  assert.throws(
    () => triangulateTwoAnchors({ rA: -1, rB: 1, d: 4 }),
    /rA must be a non-negative finite number/,
  );
  assert.throws(
    () => triangulateTwoAnchors({ rA: 1, rB: Infinity, d: 4 }),
    /rB must be a non-negative finite number/,
  );
  assert.throws(
    () => triangulateTwoAnchors({ rA: 1, rB: 1, d: 0 }),
    /d must be a positive finite number/,
  );
  assert.throws(
    () => triangulateTwoAnchors({ rA: 1, rB: 1, d: 4, halfPlane: 'left' as never }),
    /halfPlane must be positive or negative/,
  );
});
