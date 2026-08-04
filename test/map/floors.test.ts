// 층 모델 — 맵 선언 검증과 앵커→층 매핑(spec system 03 §5.1·§5.2).
//
// 검증을 시작할 때 다 끝내는 이유가 여기 테스트의 절반이다. **틀린 층으로 도는 서버가
// 가장 나쁘다** — 사고 기록에 그 층이 박히고 나중에 되돌릴 방법이 없다.

import * as assert from 'node:assert/strict';
import test from 'node:test';

import { parseFacilityMap, createFloorIndex, MapConfigError } from '../../server/map/floors.ts';
import { applyZonePolicy } from '../../server/lib/privacy.ts';
import { zoneAt } from '../../server/lib/zone.ts';

const floor = (id: string, anchors: string[], zones: unknown[]) => ({
  id, name: `${id}층`, plan: `/${id}.svg`, anchors, zones,
});

const DOC = {
  name: '시험 시설',
  bounds: { x: [0, 32], y: [0, 20] },
  floors: [
    floor('F1', ['a1', 'b1'], [
      { id: 'z1', label: '101호', rect: [0, 10, 10, 10] },
      { id: 'w1', label: '화장실', rect: [0, 0, 5, 5], privacy: true },
    ]),
    floor('F2', ['a2', 'b2'], [
      { id: 'z2', label: '201호', rect: [0, 10, 10, 10] },
      { id: 'r2', label: '휴게실', rect: [0, 0, 5, 5] },
    ]),
  ],
};

const parsed = () => parseFacilityMap(structuredClone(DOC));

// ── 검증 ──────────────────────────────────────────────────

test('층이 없는 맵은 거부한다 — 맵은 층의 배열이다', () => {
  assert.throws(() => parseFacilityMap({ bounds: DOC.bounds }), MapConfigError);
  assert.throws(() => parseFacilityMap({ bounds: DOC.bounds, floors: [] }), MapConfigError);
});

// 같은 앵커가 두 층에 적혀 있으면 그 앵커가 잡은 프레임이 어느 층인지 정할 수 없다.
test('같은 앵커가 두 층에 적히면 거부한다', () => {
  const doc = structuredClone(DOC);
  doc.floors[1]!.anchors = ['a1', 'b2'];
  assert.throws(() => parseFacilityMap(doc), /a1.*F1.*F2|F1.*F2/);
});

test('층 id 중복·빈 zones·rect 형식을 거부한다', () => {
  const dupId = structuredClone(DOC);
  dupId.floors[1]!.id = 'F1';
  assert.throws(() => parseFacilityMap(dupId), MapConfigError);

  const noZones = structuredClone(DOC);
  noZones.floors[0]!.zones = [];
  assert.throws(() => parseFacilityMap(noZones), MapConfigError);

  const badRect = structuredClone(DOC);
  (badRect.floors[0]!.zones[0] as { rect: unknown }).rect = [1, 2, 3];
  assert.throws(() => parseFacilityMap(badRect), MapConfigError);
});

test('hazards는 없어도 되고, 있으면 구역과 같은 형식이다', () => {
  const map = parsed();
  assert.deepEqual(map.floors[0]!.hazards, []);

  const withHazard = structuredClone(DOC) as Record<string, unknown>;
  (withHazard.floors as Record<string, unknown>[])[0]!.hazards = [
    { id: 'h1', label: '계단', rect: [0, 0, 1, 1] },
  ];
  assert.equal(parseFacilityMap(withHazard).floors[0]!.hazards.length, 1);
});

// ── 앵커 → 층 ──────────────────────────────────────────────

test('앵커 ID로 층을 찾는다. 모르는 앵커면 null', () => {
  const index = createFloorIndex(parsed());
  assert.equal(index.byAnchor('a2')?.id, 'F2');
  assert.equal(index.byAnchor('없는앵커'), null);
  assert.equal(index.byId('F1')?.id, 'F1');
  assert.equal(index.byId('F9'), null);
});

test('프레임의 앵커 거리에서 층을 뽑는다', () => {
  const index = createFloorIndex(parsed());
  assert.equal(index.ofRanges([{ anchorId: 'a2' }, { anchorId: 'b2' }])?.id, 'F2');
  // 모르는 앵커만 실린 프레임은 층이 없다 — 서버는 이 프레임을 버린다.
  assert.equal(index.ofRanges([{ anchorId: 'zzz' }]), null);
  assert.equal(index.ofRanges([]), null);
  assert.equal(index.ofRanges(undefined), null);
});

test('실행 인자 앵커가 어느 층에도 없으면 시작을 막는다', () => {
  const index = createFloorIndex(parsed());
  assert.equal(index.requireAnchorPair('a1', 'b1').id, 'F1');
  assert.throws(() => index.requireAnchorPair('없는앵커', 'b1'), /메인 앵커/);
  assert.throws(() => index.requireAnchorPair('a1', '없는앵커'), /서브 앵커/);
});

// 쌍이 갈리면 실측 프레임이 어느 층 것인지 정할 수 없다.
test('앵커 쌍이 서로 다른 층이면 시작을 막는다', () => {
  const index = createFloorIndex(parsed());
  assert.throws(() => index.requireAnchorPair('a1', 'b2'), /서로 다른 층/);
});

// ── 판정이 층을 넘지 않는다 ─────────────────────────────────

test('같은 좌표가 층에 따라 다른 구역으로 판정된다', () => {
  const map = parsed();
  const [f1, f2] = map.floors;
  assert.equal(zoneAt(f1!, 5, 15), '101호');
  assert.equal(zoneAt(f2!, 5, 15), '201호');
});

// 이게 무너지면 있지도 않은 사생활 구역이 생긴다 — 2층 휴게실에 있는 사람의 좌표가
// 1층 화장실 사각형 때문에 지워진다.
test('1층 사생활 구역이 2층 좌표를 지우지 않는다', () => {
  const map = parsed();
  const [f1, f2] = map.floors;
  const frame = { tagId: 'tag-1', pos: { x: 2, y: 2 } };

  const onF1 = applyZonePolicy(f1!, structuredClone(frame));
  assert.equal(onF1.privacy, true);
  assert.equal(onF1.pos, null);

  const onF2 = applyZonePolicy(f2!, structuredClone(frame));
  assert.equal(onF2.privacy, false);
  assert.deepEqual(onF2.pos, { x: 2, y: 2 });
  assert.equal(onF2.zone, '휴게실');
});
