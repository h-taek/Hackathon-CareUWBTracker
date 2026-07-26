// 시뮬레이터는 배경 태그를 걷게 하는 일만 한다.
// 경보를 만드는 곳은 감지기 하나뿐이고, 시뮬은 거기에 관여하지 않는다.
// (예전에는 시뮬이 각본대로 경보를 지어냈다. 그때 화면에 뜨던 경보는 감지기 성능과
//  아무 상관이 없었고, 그래서 데모가 무엇을 증명하는지 말할 수 없는 상태였다.)

import * as assert from 'node:assert/strict';
import test from 'node:test';

import { Simulator, type SimMap } from '../server/sim.ts';

const MAP: SimMap = {
  bounds: { x: [0, 20], y: [0, 12] },
  zones: [{ id: 'r301', label: '301호', rect: [0, 0, 10, 6] }],
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

test('stop 뒤에는 타이머가 남지 않는다', () => {
  const sim = new Simulator(MAP);
  sim.start(50);
  sim.stop();
  assert.equal(sim.timer, null);
});
