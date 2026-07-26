// 좌표 → 앵커 거리. 삼각측량과 왕복이 맞아야 주입 클립이 제자리에 찍힌다.

import * as assert from 'node:assert/strict';
import test from 'node:test';

import { rangesForPoint, type AnchorGeometry } from '../../server/positioning/to-ranges.ts';
import { triangulateTwoAnchors } from '../../server/positioning/triangulate.ts';

const GEOMETRY: AnchorGeometry = {
  mainAnchorId: 'phoneMain',
  subAnchorId: 'phoneSub',
  anchorDistance: 4,
  halfPlane: 'positive',
};

function roundTrip(point: { x: number; y: number }, geometry = GEOMETRY) {
  const [main, sub] = rangesForPoint(point, geometry);
  return triangulateTwoAnchors({
    rA: main.distance,
    rB: sub.distance,
    d: geometry.anchorDistance,
    halfPlane: geometry.halfPlane,
  });
}

test('만든 거리를 삼각측량에 넣으면 원래 좌표가 나온다', () => {
  // 거리는 mm 자리에서 끊는다(실측 프레임과 자릿수를 맞추려고). 그래서 왕복이 딱 떨어지지는
  // 않는다 — 아래 "먼 자리" 테스트가 그 오차가 어디서 커지는지 못 박아 둔다.
  for (const point of [{ x: 3, y: 2 }, { x: 0.5, y: 7.25 }, { x: 12, y: 1 }, { x: 4, y: 4 }]) {
    const back = roundTrip(point);
    assert.ok(Math.abs(back.x - point.x) < 0.05, `x ${back.x} != ${point.x}`);
    assert.ok(Math.abs(back.y - point.y) < 0.05, `y ${back.y} != ${point.y}`);
  }
});

test('앵커 가까이서는 mm 단위까지 맞는다', () => {
  const back = roundTrip({ x: 2, y: 3 });
  assert.ok(Math.abs(back.x - 2) < 0.002);
  assert.ok(Math.abs(back.y - 3) < 0.002);
});

test('앵커에서 멀고 기준선에 가까운 자리는 오차가 커진다 — 2앵커 기하의 성질이다', () => {
  // y = sqrt(rA^2 - x^2)라, 태그가 앵커 선분에서 멀어지고 기준선에 붙을수록 큰 수끼리
  // 빼게 되어 거리 오차가 좌표 오차로 증폭된다. mm 오차가 cm로 벌어진다.
  // 데모에서 낙상 지점을 앵커 근처로 잡아야 하는 이유이기도 하다.
  const near = roundTrip({ x: 2, y: 3 });
  const far = roundTrip({ x: 12, y: 1 });
  assert.ok(Math.abs(far.y - 1) > Math.abs(near.y - 3));
  assert.ok(Math.abs(far.y - 1) < 0.05, '그래도 맵 축척(20m)에서는 무시할 만한 크기다');
});

test('앵커 ID가 설정 그대로 실린다 — from-ingest가 ID로 골라 쓴다', () => {
  const [main, sub] = rangesForPoint({ x: 3, y: 2 }, GEOMETRY);
  assert.equal(main.anchorId, 'phoneMain');
  assert.equal(sub.anchorId, 'phoneSub');
});

test('메인 앵커는 원점, 서브는 (d,0) 기준으로 잰다', () => {
  const [main, sub] = rangesForPoint({ x: 3, y: 4 }, GEOMETRY);
  assert.equal(main.distance, 5);           // hypot(3,4)
  assert.equal(sub.distance, 4.123);        // hypot(3-4,4)
});

test('negative 반평면이면 기준선 아래로 접어 넣는다', () => {
  const geometry = { ...GEOMETRY, halfPlane: 'negative' as const };
  const back = roundTrip({ x: 3, y: 2 }, geometry);
  assert.ok(Math.abs(back.x - 3) < 0.002);
  assert.ok(Math.abs(back.y + 2) < 0.002, '부호가 뒤집혀 나와야 한다');
});

test('반평면 밖 좌표를 줘도 왕복이 깨지지 않는다', () => {
  // 삼각측량은 교점 두 개 중 하나만 되돌려 준다. 접어 넣지 않으면 마커가 기준선 너머로 튄다.
  const back = roundTrip({ x: 3, y: -2 }, GEOMETRY);
  assert.ok(Math.abs(back.y - 2) < 0.002);
});

test('앵커 거리가 0 이하면 던진다', () => {
  assert.throws(() => rangesForPoint({ x: 1, y: 1 }, { ...GEOMETRY, anchorDistance: 0 }), RangeError);
});

test('좌표가 유한하지 않으면 던진다', () => {
  assert.throws(() => rangesForPoint({ x: NaN, y: 1 }, GEOMETRY), RangeError);
});
