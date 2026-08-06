import test from 'node:test';
import * as assert from 'node:assert';
import { applyZonePolicy, isPrivacyFrame } from '../../server/lib/privacy.ts';
import type { ZoneMap } from '../../server/lib/zone.ts';

const map: ZoneMap = { zones: [
  { id: 'z_hall', label: '서측 복도', rect: [4.0, 7.0, 3.0, 5.0], walkable: true },
  { id: 'z_wc', label: '화장실(여)', rect: [0.5, 10.0, 3.3, 2.7], privacy: true },
] };

const frame = (x: number, y: number): Record<string, unknown> => ({
  tagId: 'tag-101',
  ts: 1_700_000_000_000,
  pos: { x, y, z: 1.0 },
  accel: { x: 0.1, y: 0.2, z: 9.8 },
  source: 'uwb+imu',
});

test('일반 구역은 좌표를 그대로 두고 구역명을 붙인다', () => {
  const out = applyZonePolicy(map, frame(5, 9) as never);
  assert.deepStrictEqual(out.pos, { x: 5, y: 9, z: 1.0 });
  assert.strictEqual(out.zone, '서측 복도');
  assert.strictEqual(out.privacy, false);
});

test('사생활 구역은 좌표를 지우고 구역명만 남긴다', () => {
  const out = applyZonePolicy(map, frame(2, 11) as never);
  assert.strictEqual(out.pos, null);
  assert.strictEqual(out.zone, '화장실(여)');
  assert.strictEqual(out.privacy, true);
});

test('사생활 구역에서도 가속도와 태그·시각은 남는다 — 낙상은 여기서도 잡아야 한다', () => {
  const out = applyZonePolicy(map, frame(2, 11) as never);
  assert.deepStrictEqual(out.accel, { x: 0.1, y: 0.2, z: 9.8 });
  assert.strictEqual(out.tagId, 'tag-101');
  assert.strictEqual(out.ts, 1_700_000_000_000);
});

test('좌표를 되짚을 수 있는 값도 함께 지운다 — 앵커 거리 둘이면 그 자리가 다시 나온다', () => {
  const withRanges = {
    ...frame(2, 11),
    ranges: [{ anchorId: 'phoneMain', distance: 3.2 }, { anchorId: 'phoneSub', distance: 4.1 }],
    geom: { clamped: true, error: 0.4 },
    estimate: { mode: 'single-anchor', anchorId: 'phoneMain', bearingDeg: 45 },
  };
  const out = applyZonePolicy(map, withRanges as never);
  for (const key of ['ranges', 'geom', 'estimate']) {
    assert.ok(!(key in out), `${key}가 남았다 — 좌표를 되짚을 수 있다`);
  }
});

test('일반 프레임에도 privacy를 명시한다 — 화면이 프레임을 누적 병합한다', () => {
  // 화장실 -> 복도 순서로 흘렸을 때 복도 프레임이 privacy를 안 실으면
  // 화면에는 직전의 true가 그대로 남아 마커가 영영 안 돌아온다.
  const inside = applyZonePolicy(map, frame(2, 11) as never);
  const outside = applyZonePolicy(map, frame(5, 9) as never);
  const merged = { ...inside, ...outside };
  assert.strictEqual(merged.privacy, false);
  assert.deepStrictEqual(merged.pos, { x: 5, y: 9, z: 1.0 });
});

test('어느 구역에도 없으면 미지정이고 좌표는 남는다', () => {
  const out = applyZonePolicy(map, frame(30, 1) as never);
  assert.strictEqual(out.zone, '미지정');
  assert.strictEqual(out.privacy, false);
  assert.deepStrictEqual(out.pos, { x: 30, y: 1, z: 1.0 });
});

test('isPrivacyFrame은 좌표 유실과 사생활 폐기를 가른다', () => {
  assert.strictEqual(isPrivacyFrame(applyZonePolicy(map, frame(2, 11) as never)), true);
  assert.strictEqual(isPrivacyFrame(applyZonePolicy(map, frame(5, 9) as never)), false);
  assert.strictEqual(isPrivacyFrame(null), false);           // 측위 실패(좌표 없음)
  assert.strictEqual(isPrivacyFrame({ pos: null }), false);  // 앵커 부족으로 보류된 프레임
});
