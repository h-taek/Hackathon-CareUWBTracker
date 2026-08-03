import * as assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyJudgment,
  isIncident,
  isJudgment,
  outcomeOf,
  undoDeadline,
  wantsIncident,
  type OutcomeFields,
} from '../../server/events/outcome.ts';

const HOUR = 3_600_000;
const UNDO = 24 * HOUR;

test('outcome이 없는 옛 레코드는 detected로 읽는다', () => {
  assert.equal(outcomeOf({}), 'detected');
  assert.equal(outcomeOf(null), 'detected');
  assert.equal(outcomeOf({ outcome: 'confirmed' }), 'confirmed');
  // 스키마 밖의 값이 파일에 들어 있어도 화면이 깨지면 안 된다.
  assert.equal(outcomeOf({ outcome: 'nonsense' } as unknown as OutcomeFields), 'detected');
});

test('사건 목록에 뜨는 것은 confirmed뿐이다', () => {
  assert.equal(isIncident({ outcome: 'confirmed' }), true);
  for (const outcome of ['detected', 'false_alarm'] as const) {
    assert.equal(isIncident({ outcome }), false, `${outcome}은 사건이 아니다`);
  }
});

test('관제사가 낼 수 있는 값은 둘뿐이다 — detected는 판정 전 상태다', () => {
  assert.equal(isJudgment('confirmed'), true);
  assert.equal(isJudgment('false_alarm'), true);
  assert.equal(isJudgment('detected'), false);
  assert.equal(isJudgment('unjudged'), false, '폐기된 값이라 판정으로 안 받는다');
});

test('판정 전에는 언제든 판정할 수 있다', () => {
  const late = 1000 + 100 * 24 * HOUR; // 백 일 뒤라도
  const result = applyJudgment({}, 'confirmed', 'operator', late, UNDO);

  assert.equal(result.ok, true);
  assert.equal(result.patch?.outcome, 'confirmed');
  assert.equal(result.patch?.resolvedAt, late);
  assert.deepEqual(result.patch?.outcomeHistory, [
    { at: late, from: 'detected', to: 'confirmed', by: 'operator' },
  ]);
});

test('번복 창 안이면 뒤집힌다', () => {
  const judged: OutcomeFields = { outcome: 'confirmed', resolvedAt: 1000 };
  const result = applyJudgment(judged, 'false_alarm', 'operator', 1000 + 23 * HOUR, UNDO);

  assert.equal(result.ok, true);
  assert.equal(result.patch?.outcome, 'false_alarm');
  // 번복 시각이 새 기준점이 된다 — 다음 번복 창이 여기서 다시 24시간이다.
  assert.equal(result.patch?.resolvedAt, 1000 + 23 * HOUR);
});

test('번복 창을 넘기면 막는다 — 그때는 이미 지워진 것이 있다', () => {
  const judged: OutcomeFields = { outcome: 'false_alarm', resolvedAt: 1000 };
  const result = applyJudgment(judged, 'confirmed', 'operator', 1000 + UNDO + 1, UNDO);

  assert.equal(result.ok, false);
  assert.match(result.reason, /24시간/);
  assert.equal(result.patch, undefined);
});

test('사건 사본을 만들어야 하는 상태는 confirmed뿐이다', () => {
  assert.equal(wantsIncident('confirmed'), true);
  assert.equal(wantsIncident('false_alarm'), false);
  assert.equal(wantsIncident('detected'), false);
});

test('같은 판정을 다시 내는 것은 막는다', () => {
  const result = applyJudgment({ outcome: 'confirmed', resolvedAt: 1000 }, 'confirmed', 'operator', 1100, UNDO);
  assert.equal(result.ok, false);
});

test('판정 시각이 없으면 번복 창을 계산할 수 없다고 막는다', () => {
  const broken: OutcomeFields = { outcome: 'confirmed' };
  assert.equal(undoDeadline(broken, UNDO), null);

  const result = applyJudgment(broken, 'false_alarm', 'operator', 5000, UNDO);
  assert.equal(result.ok, false);
  assert.match(result.reason, /판정 시각/);
});

test('이력은 쌓이고 앞의 것을 덮어쓰지 않는다', () => {
  let fields: OutcomeFields = {};
  const first = applyJudgment(fields, 'false_alarm', 'operator', 1000, UNDO);
  fields = { ...fields, ...first.patch };
  const second = applyJudgment(fields, 'confirmed', 'nurse', 2000, UNDO);

  assert.deepEqual(second.patch?.outcomeHistory, [
    { at: 1000, from: 'detected', to: 'false_alarm', by: 'operator' },
    { at: 2000, from: 'false_alarm', to: 'confirmed', by: 'nurse' },
  ]);
});

test('번복은 사건 사본을 지우는 일이라 창 밖에서는 막힌다', () => {
  // 창을 무한정 열어두면 3년짜리 사고 기록이 언제든 사라질 수 있게 된다.
  const judged: OutcomeFields = { outcome: 'confirmed', resolvedAt: 1000 };
  assert.equal(applyJudgment(judged, 'false_alarm', 'operator', 1000 + UNDO - 1, UNDO).ok, true);
  assert.equal(applyJudgment(judged, 'false_alarm', 'operator', 1000 + UNDO + 1, UNDO).ok, false);
});
