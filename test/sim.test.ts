// 낙상 주입 각본. 주입 버튼은 감지기를 거치지 않으므로(UI 검증용 트리거),
// 감지기가 내는 후보 -> 확진/해제 흐름을 시뮬레이터가 대신 재생해야 한다.

import * as assert from 'node:assert/strict';
import test from 'node:test';
import { Simulator, isFallScenario, type SimAlert, type SimMap } from '../server/sim.ts';

const MAP: SimMap = {
  bounds: { x: [0, 20], y: [0, 12] },
  zones: [{ id: 'r301', label: '301호', rect: [0, 0, 10, 6] }],
};

/** 각본이 끝날 때까지 방출된 경보를 모은다. */
function collect(sim: Simulator): SimAlert[] {
  const seen: SimAlert[] = [];
  sim.on('alert', (alert: SimAlert) => seen.push(alert));
  return seen;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('확진 각본은 후보 다음에 확진을 낸다', async () => {
  const sim = new Simulator(MAP);
  const seen = collect(sim);
  sim.injectFall('tag-101', 'confirm');

  assert.equal(seen.length, 1);
  assert.equal(seen[0].type, 'fall_candidate');
  assert.equal(seen[0].confidence, 'candidate');

  await sleep(5200);
  assert.equal(seen.length, 2);
  assert.equal(seen[1].type, 'fall_confirmed');
  assert.equal(seen[1].confidence, 'confirmed');
  sim.stop();
});

test('해제 각본은 후보 다음에 해제를 내고 태그를 다시 걷게 한다', async () => {
  const sim = new Simulator(MAP);
  const seen = collect(sim);
  sim.injectFall('tag-101', 'cancel');

  const tag = sim.tags.find((t) => t.id === 'tag-101')!;
  assert.equal(tag.fallen, true);

  await sleep(3200);
  assert.equal(seen.length, 2);
  assert.equal(seen[1].type, 'fall_canceled');
  assert.equal(seen[1].confidence, 'cleared');
  // 해제 사유가 "움직임 재개"이므로 마커도 다시 움직여야 화면이 말과 맞는다.
  assert.equal(tag.fallen, false);
  sim.stop();
});

test('후속 경보는 같은 태그를 가리키되 eventId는 새로 뽑는다', async () => {
  // 대시보드가 eventId로 중복을 거르므로(alert-state.js) 같은 ID면 후속이 통째로 무시된다.
  const sim = new Simulator(MAP);
  const seen = collect(sim);
  sim.injectFall('tag-102', 'cancel');
  await sleep(3200);

  assert.equal(seen[0].tagId, 'tag-102');
  assert.equal(seen[1].tagId, seen[0].tagId);
  assert.notEqual(seen[1].eventId, seen[0].eventId);
  assert.equal(seen[1].peakAccel, seen[0].peakAccel); // 같은 충격 사건이다
  sim.stop();
});

test('같은 태그에 다시 주입하면 이전 각본은 버린다', async () => {
  // 안 버리면 해제 뒤에 옛 확진이 날아와 대시보드가 해제된 경보를 되살린다.
  const sim = new Simulator(MAP);
  const seen = collect(sim);
  sim.injectFall('tag-101', 'confirm');
  sim.injectFall('tag-101', 'cancel');
  await sleep(3200);

  const types = seen.map((a) => a.type);
  assert.deepEqual(types, ['fall_candidate', 'fall_candidate', 'fall_canceled']);
  await sleep(2600); // 원래 확진 예정 시각을 지나도 조용해야 한다
  assert.equal(seen.length, 3);
  sim.stop();
});

test('다른 태그의 각본은 서로 간섭하지 않는다', async () => {
  const sim = new Simulator(MAP);
  const seen = collect(sim);
  sim.injectFall('tag-101', 'cancel');
  sim.injectFall('tag-102', 'cancel');
  await sleep(3200);

  const byTag = (id: string) => seen.filter((a) => a.tagId === id).map((a) => a.type);
  assert.deepEqual(byTag('tag-101'), ['fall_candidate', 'fall_canceled']);
  assert.deepEqual(byTag('tag-102'), ['fall_candidate', 'fall_canceled']);
  sim.stop();
});

test('stop()은 예약된 후속 경보를 취소한다', async () => {
  const sim = new Simulator(MAP);
  const seen = collect(sim);
  sim.injectFall('tag-101', 'cancel');
  sim.stop();
  await sleep(3200);
  assert.equal(seen.length, 1);
});

test('기본 각본은 확진이다', () => {
  const sim = new Simulator(MAP);
  const seen = collect(sim);
  sim.injectFall('tag-101');
  assert.equal(seen[0].type, 'fall_candidate');
  sim.stop();
});

test('알 수 없는 tagId는 첫 태그로 떨어진다', () => {
  const sim = new Simulator(MAP);
  const seen = collect(sim);
  sim.injectFall('없는태그');
  assert.equal(seen[0].tagId, sim.tags[0].id);
  sim.stop();
});

test('각본 이름을 검증한다', () => {
  assert.equal(isFallScenario('confirm'), true);
  assert.equal(isFallScenario('cancel'), true);
  assert.equal(isFallScenario('confirmed'), false);
  assert.equal(isFallScenario(''), false);
  assert.equal(isFallScenario(undefined), false);
});
