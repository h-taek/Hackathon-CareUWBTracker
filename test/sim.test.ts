// 시뮬레이터는 배경 태그를 걷게 하는 일만 한다.
// 경보를 만드는 곳은 감지기 하나뿐이고, 시뮬은 거기에 관여하지 않는다.
// (예전에는 시뮬이 각본대로 경보를 지어냈다. 그때 화면에 뜨던 경보는 감지기 성능과
//  아무 상관이 없었고, 그래서 데모가 무엇을 증명하는지 말할 수 없는 상태였다.)

import * as assert from 'node:assert/strict';
import test from 'node:test';

import { Simulator, type SimMap } from '../server/sim.ts';

// 배경 태그 명단이 F1~F4를 쓰므로 시험 맵도 네 층을 연다. 통행 구역을 층마다 다른
// 자리에 둬서, 태그가 자기 층 밖으로 나가지 않는지 좌표만 보고 가릴 수 있게 했다.
const MAP: SimMap = {
  bounds: { x: [0, 20], y: [0, 12] },
  floors: [
    { id: 'F1', name: '1층', plan: '/f1.svg', anchors: ['a1', 'b1'], hazards: [],
      zones: [{ id: 'z_f1', label: '101호', rect: [0, 0, 4, 12], walkable: true }] },
    { id: 'F2', name: '2층', plan: '/f2.svg', anchors: ['a2', 'b2'], hazards: [],
      zones: [{ id: 'z_f2', label: '201호', rect: [4, 0, 4, 12], walkable: true }] },
    { id: 'F3', name: '3층', plan: '/f3.svg', anchors: ['a3', 'b3'], hazards: [],
      zones: [{ id: 'z_f3', label: '301호', rect: [8, 0, 4, 12], walkable: true }] },
    { id: 'F4', name: '4층', plan: '/f4.svg', anchors: ['a4', 'b4'], hazards: [],
      zones: [{ id: 'z_f4', label: '로비', rect: [12, 0, 4, 12], walkable: true }] },
  ],
};

/** 그 층의 통행 구역 x 범위. 태그가 자기 층 안에 있는지 보는 데 쓴다. */
const FLOOR_X: Record<string, [number, number]> = {
  F1: [0, 4], F2: [4, 8], F3: [8, 12], F4: [12, 16],
};

test('시뮬은 경보를 내지 않는다 — 경보는 감지기만 낸다', () => {
  const sim = new Simulator(MAP);
  const alerts: unknown[] = [];
  sim.on('alert', (alert: unknown) => alerts.push(alert));

  for (let i = 0; i < 200; i += 1) sim.step(0.2);
  assert.equal(alerts.length, 0);
  sim.stop();
});

test('step은 태그마다 측위 좌표를 방출한다', () => {
  const sim = new Simulator(MAP);
  const positions: { tagId: string }[] = [];
  sim.on('position', (p: unknown) => positions.push(p as { tagId: string }));

  sim.step(0.2);
  assert.equal(positions.length, sim.tags.length);
  assert.deepEqual(
    [...new Set(positions.map((p) => p.tagId))].sort(),
    sim.tags.map((t) => t.id).sort(),
  );
  sim.stop();
});

test('freeze한 태그는 방출도 이동도 멈춘다', () => {
  const sim = new Simulator(MAP);
  const target = sim.tags[0];
  const before = { x: target.x, y: target.y };
  sim.freeze(target.id);

  const emitted: { tagId: string }[] = [];
  sim.on('position', (p: unknown) => emitted.push(p as { tagId: string }));
  for (let i = 0; i < 50; i += 1) sim.step(0.2);

  // 주입 중에는 주입기가 그 태그의 좌표를 만든다. 시뮬이 같이 방출하면 마커를 서로 뺏는다.
  assert.equal(emitted.filter((p) => p.tagId === target.id).length, 0);
  assert.equal(target.x, before.x);
  assert.equal(target.y, before.y);
  assert.ok(emitted.some((p) => p.tagId === sim.tags[1].id), '나머지 태그는 그대로 돈다');
  sim.stop();
});

test('unfreeze하면 다시 걷는다', () => {
  const sim = new Simulator(MAP);
  const target = sim.tags[0];
  sim.freeze(target.id);
  sim.step(0.2);
  sim.unfreeze(target.id);

  const emitted: { tagId: string }[] = [];
  sim.on('position', (p: unknown) => emitted.push(p as { tagId: string }));
  sim.step(0.2);
  assert.equal(emitted.filter((p) => p.tagId === target.id).length, 1);
  sim.stop();
});

test('positionOf는 태그가 서 있는 자리를 준다 — 주입기가 UWB 거리를 만들 기준점', () => {
  const sim = new Simulator(MAP);
  const target = sim.tags[0];
  assert.deepEqual(sim.positionOf(target.id), { x: target.x, y: target.y });
  assert.equal(sim.positionOf('없는태그'), null);
  sim.stop();
});

test('태그는 맵 경계 안에 머문다', () => {
  const sim = new Simulator(MAP);
  for (let i = 0; i < 500; i += 1) sim.step(0.2);
  for (const tag of sim.tags) {
    assert.ok(tag.x >= 0 && tag.x <= 20, `x=${tag.x}`);
    assert.ok(tag.y >= 0 && tag.y <= 12, `y=${tag.y}`);
  }
  sim.stop();
});

// ── 층 ────────────────────────────────────────────────────

test('태그가 층에 나뉘고, 방출 프레임에 그 층이 실린다', () => {
  const sim = new Simulator(MAP);
  const byFloor = new Map<string, number>();
  for (const tag of sim.tags) byFloor.set(tag.floor, (byFloor.get(tag.floor) ?? 0) + 1);
  assert.deepEqual([...byFloor.keys()].sort(), ['F1', 'F2', 'F3', 'F4']);

  const emitted: { tagId: string; floor: string }[] = [];
  sim.on('position', (p: unknown) => emitted.push(p as { tagId: string; floor: string }));
  sim.step(0.2);
  for (const frame of emitted) {
    const tag = sim.tags.find((t) => t.id === frame.tagId)!;
    assert.equal(frame.floor, tag.floor, `${frame.tagId}의 층이 프레임과 다르다`);
  }
  sim.stop();
});

// 층을 넘어 걸으면 없는 기능(층간 이동)을 흉내내게 되고, 그 층 도면에 없는 자리에
// 마커가 찍힌다. 목표 지점을 자기 층 walkable에서만 뽑는 것이 그걸 막는다.
test('태그는 자기 층 통행 구역 밖으로 나가지 않는다', () => {
  const sim = new Simulator(MAP);
  for (let i = 0; i < 500; i += 1) sim.step(0.2);
  for (const tag of sim.tags) {
    const [x0, x1] = FLOOR_X[tag.floor]!;
    assert.ok(tag.x >= x0 - 0.5 && tag.x <= x1 + 0.5,
      `${tag.id}(${tag.floor})가 x=${tag.x}로 자기 층을 벗어났다`);
  }
  sim.stop();
});

test('floorIdOf는 주입기가 그 층 앵커를 고를 근거를 준다', () => {
  const sim = new Simulator(MAP);
  const target = sim.tags[0];
  assert.equal(sim.floorIdOf(target.id), target.floor);
  assert.equal(sim.floorIdOf('없는태그'), null);
  sim.stop();
});

// 맵에 없는 층을 가리키는 태그는 갈 곳이 없어 좌표가 안 나온다. 올리지 않는 것이 맞다.
test('맵에 없는 층의 태그는 올리지 않는다', () => {
  const sim = new Simulator({ bounds: MAP.bounds, floors: [MAP.floors[0]!] });
  assert.deepEqual([...new Set(sim.tags.map((t) => t.floor))], ['F1']);
  assert.ok(sim.tags.length > 0);
  sim.stop();
});

test('stop 뒤에는 타이머가 남지 않는다', () => {
  const sim = new Simulator(MAP);
  sim.start(50);
  sim.stop();
  assert.equal(sim.timer, null);
});
