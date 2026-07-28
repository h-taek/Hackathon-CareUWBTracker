import * as assert from 'node:assert/strict';
import test from 'node:test';
import { triangulateTwoAnchors } from '../../server/positioning/triangulate.ts';

function assertClose(actual: number, expected: number, tolerance = 1e-9, message?: string): void {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    message ?? `expected ${actual} to be within ${tolerance} of ${expected}`,
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

test('정상해에는 클램프 표시가 붙지 않는다', () => {
  const position = triangulateTwoAnchors({ rA: Math.sqrt(5), rB: Math.sqrt(13), d: 4 });
  assert.equal(position.clamped, false);
  assert.equal(position.clampError, 0);
});

test('기준선 위 접점(교점 1개)은 클램프가 아니다', () => {
  // rA + rB == d: 원 두 개가 딱 한 점에서 만난다. 해가 있으므로 경고 대상이 아니다.
  const position = triangulateTwoAnchors({ rA: 1, rB: 3, d: 4 });
  assert.equal(position.y, 0);
  assert.equal(position.clamped, false, '접점은 정상해다');
  assert.equal(position.clampError, 0);
});

test('두 원이 떨어져 있으면 모자란 거리를 clampError로 알린다', () => {
  // 실측 사례: 앵커를 4m로 설정했는데 태그가 두 폰에서 0.23m / 0.50m로 잡혔다.
  // 거리 합 0.73m < 앵커 간격 4m라 교점이 아예 없다 → 3.27m 모자람.
  const position = triangulateTwoAnchors({ rA: 0.23, rB: 0.5, d: 4, halfPlane: 'negative' });
  // negative 반평면이라 -0이 나온다(로그의 `-0.00`이 이것). 부호 없는 0과 같은 값으로 본다.
  assertClose(position.y, 0, 0, 'spec 03 클램프는 그대로 유지한다');
  assert.equal(position.clamped, true);
  assertClose(position.clampError, 4 - (0.23 + 0.5), 1e-12);
});

test('한 원이 다른 원을 품으면 넘친 거리를 clampError로 알린다', () => {
  // |rA - rB| = 9 > d = 4 → 작은 원이 큰 원 안에 완전히 들어가 교점이 없다.
  const position = triangulateTwoAnchors({ rA: 1, rB: 10, d: 4 });
  assert.equal(position.clamped, true);
  assertClose(position.clampError, 9 - 4, 1e-12);
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
