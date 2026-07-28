import * as assert from 'node:assert/strict';
import test from 'node:test';
import { positionFromIngest } from '../../server/positioning/from-ingest.ts';

const OPTIONS = Object.freeze({
  mainAnchorId: 'phoneMain',
  subAnchorId: 'phoneSub',
  anchorDistance: 4,
  halfPlane: 'positive' as const,
});

interface IngestRange {
  anchorId: string;
  distance: number;
}

function ingest(ranges: IngestRange[], overrides: Record<string, unknown> = {}) {
  return {
    tagId: 'tag-watch',
    ts: 123456789,
    ranges,
    accel: { x: 0, y: 0, z: 9.81 },
    source: 'ni',
    ...overrides,
  };
}

function assertClose(actual: number, expected: number, tolerance = 1e-9): void {
  assert.ok(Math.abs(actual - expected) <= tolerance);
}

test('앵커 배열 순서와 무관하게 ID로 거리를 찾아 position을 만든다', () => {
  const position = positionFromIngest(ingest([
    { anchorId: 'phoneSub', distance: Math.sqrt(13) },
    { anchorId: 'phoneMain', distance: Math.sqrt(5) },
  ]), OPTIONS)!;

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
  ], { source: 'sim' }), OPTIONS)!;

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

test('accel-only ingest(빈/없는 ranges)면 크래시 없이 좌표 계산을 보류한다', () => {
  assert.equal(positionFromIngest(ingest([]), OPTIONS), null);
  const noRanges: Record<string, unknown> = ingest([]);
  delete noRanges.ranges;
  assert.equal(positionFromIngest(noRanges as never, OPTIONS), null);
});

test('음수 반평면과 사용자 지정 오차 반경을 전달한다', () => {
  const position = positionFromIngest(ingest([
    { anchorId: 'phoneMain', distance: Math.sqrt(5) },
    { anchorId: 'phoneSub', distance: Math.sqrt(13) },
  ]), { ...OPTIONS, halfPlane: 'negative', xyError: 0.3, zError: 1.5 })!;

  assertClose(position.pos.y, -2);
  assert.deepEqual(position.err, { xy: 0.3, z: 1.5 });
});

test('앵커 설정 누락과 동일한 앵커 ID를 거부한다', () => {
  const payload = ingest([]);
  assert.throws(() => positionFromIngest(payload, undefined as never), /positioning options are required/);
  assert.throws(
    () => positionFromIngest(payload, { mainAnchorId: '', subAnchorId: 'phoneSub' } as never),
    /mainAnchorId must be a non-empty string/,
  );
  assert.throws(
    () => positionFromIngest(payload, { mainAnchorId: 'same', subAnchorId: 'same' } as never),
    /must be different/,
  );
});

test('정상해면 geom 필드를 안 싣는다', () => {
  const position = positionFromIngest(ingest([
    { anchorId: 'phoneMain', distance: Math.sqrt(5) },
    { anchorId: 'phoneSub', distance: Math.sqrt(13) },
  ]), OPTIONS)!;

  assert.equal(position.geom, undefined, '평상시 프레임에는 안 붙는다');
});

test('삼각측량이 클램프되면 geom으로 알린다', () => {
  // 앵커 간격 4m인데 두 거리 합이 0.73m — 교점이 없다(실측에서 나온 배치 불일치).
  const position = positionFromIngest(ingest([
    { anchorId: 'phoneMain', distance: 0.23 },
    { anchorId: 'phoneSub', distance: 0.5 },
  ]), OPTIONS)!;

  assert.equal(position.pos.y, 0);
  assert.equal(position.geom?.clamped, true);
  assertClose(position.geom!.error, 4 - 0.73, 1e-12);
});

// --- 1앵커 테스트 모드(--single-anchor-bearing) — 서브폰 없이 화면을 볼 때만 쓴다 ---

const SINGLE = Object.freeze({ ...OPTIONS, singleAnchorBearingDeg: 45 });

test('서브 앵커가 없어도 테스트 모드면 메인 거리 하나로 좌표를 만든다', () => {
  const position = positionFromIngest(ingest([
    { anchorId: 'phoneMain', distance: Math.SQRT2 },
  ]), SINGLE)!;

  // 45도에 거리 √2 → (1, 1). 거리가 늘면 같은 방향으로 그만큼 멀어진다.
  assertClose(position.pos.x, 1, 1e-12);
  assertClose(position.pos.y, 1, 1e-12);
  assert.equal(position.pos.z, 0);
  assert.deepEqual(position.accel, { x: 0, y: 0, z: 9.81 });
  assert.equal(position.source, 'uwb+imu');
});

test('1앵커 좌표에는 estimate 꼬리표를 달아 진짜 측위와 구분한다', () => {
  const single = positionFromIngest(ingest([
    { anchorId: 'phoneMain', distance: 3 },
  ]), SINGLE)!;
  assert.deepEqual(single.estimate, { mode: 'single-anchor', anchorId: 'phoneMain', bearingDeg: 45 });

  // 앵커 둘이 다 있으면 삼각측량이 이긴다 — 테스트 모드는 폴백일 뿐이다.
  const both = positionFromIngest(ingest([
    { anchorId: 'phoneMain', distance: Math.sqrt(5) },
    { anchorId: 'phoneSub', distance: Math.sqrt(13) },
  ]), SINGLE)!;
  assertClose(both.pos.x, 1);
  assertClose(both.pos.y, 2);
  assert.equal(both.estimate, undefined);
});

test('테스트 모드가 꺼져 있으면 서브 앵커 없는 프레임은 예전대로 보류한다', () => {
  assert.equal(positionFromIngest(ingest([
    { anchorId: 'phoneMain', distance: 3 },
  ]), OPTIONS), null);
});

test('메인 앵커 거리가 없거나 비정상이면 테스트 모드에서도 좌표를 안 만든다', () => {
  // 서브 거리만 온 프레임 — 기준이 되는 메인 거리가 없다.
  assert.equal(positionFromIngest(ingest([
    { anchorId: 'phoneSub', distance: 3 },
  ]), SINGLE), null);
  assert.equal(positionFromIngest(ingest([
    { anchorId: 'phoneMain', distance: Number.NaN },
  ]), SINGLE), null);
  assert.equal(positionFromIngest(ingest([
    { anchorId: 'phoneMain', distance: -1 },
  ]), SINGLE), null);
});

test('방위각 0도는 기준선 위, 음수각은 반대쪽 반평면에 놓는다', () => {
  const onAxis = positionFromIngest(ingest([
    { anchorId: 'phoneMain', distance: 2 },
  ]), { ...OPTIONS, singleAnchorBearingDeg: 0 })!;
  assertClose(onAxis.pos.x, 2, 1e-12);
  assertClose(onAxis.pos.y, 0, 1e-12);

  const below = positionFromIngest(ingest([
    { anchorId: 'phoneMain', distance: 2 },
  ]), { ...OPTIONS, singleAnchorBearingDeg: -90 })!;
  assertClose(below.pos.x, 0, 1e-12);
  assertClose(below.pos.y, -2, 1e-12);
});
