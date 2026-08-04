import test from 'node:test';
import * as assert from 'node:assert';
import { createSightings } from '../../server/tags/sightings.ts';

/** 시계를 손으로 돌린다 — 만료를 실제 시간으로 기다릴 수는 없다. */
function fake(start = 1_000_000) {
  let at = start;
  return { now: () => at, tick: (ms: number) => { at += ms; } };
}

test('처음 본 태그면 true, 그 뒤로는 false', () => {
  const s = createSightings();
  assert.strictEqual(s.note('tag-042'), true);
  assert.strictEqual(s.note('tag-042'), false, '로그를 프레임마다 찍으면 안 된다');
});

test('버린 프레임 수와 처음 본 시각을 센다', () => {
  const clock = fake();
  const s = createSightings({ now: clock.now });
  s.note('tag-042');
  clock.tick(5000);
  s.note('tag-042');
  const [found] = s.list();
  assert.strictEqual(found.frames, 2);
  assert.strictEqual(found.firstSeenAt, 1_000_000, '처음 시각은 안 바뀐다');
  assert.strictEqual(found.lastSeenAt, 1_005_000);
});

test('등록하면 목록에서 빠진다 — 더는 미등록이 아니다', () => {
  const s = createSightings();
  s.note('tag-042');
  s.forget('tag-042');
  assert.deepStrictEqual(s.list(), []);
});

test('조용해지면 스스로 사라진다 — 꺼서 가져간 태그가 남으면 안 된다', () => {
  const clock = fake();
  const s = createSightings({ expireMs: 60_000, now: clock.now });
  s.note('tag-042');
  clock.tick(59_000);
  assert.strictEqual(s.list().length, 1, '아직 살아 있다');
  clock.tick(2000);
  assert.strictEqual(s.list().length, 0);
});

test('사라졌다가 다시 켜지면 새로 잡힌다', () => {
  const clock = fake();
  const s = createSightings({ expireMs: 60_000, now: clock.now });
  s.note('tag-042');
  clock.tick(61_000);
  s.list();                       // 만료 처리
  assert.strictEqual(s.note('tag-042'), true, '다시 처음 본 것으로 친다');
});

test('여러 태그를 처음 잡힌 순서로 준다', () => {
  const clock = fake();
  const s = createSightings({ now: clock.now });
  s.note('tag-b');
  clock.tick(100);
  s.note('tag-a');
  assert.deepStrictEqual(s.list().map((x) => x.tagId), ['tag-b', 'tag-a']);
});
