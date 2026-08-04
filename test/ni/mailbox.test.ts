import test from 'node:test';
import * as assert from 'node:assert';
import {
  createTokenMailbox,
  parseTokenMessage,
  isPeerId,
} from '../../server/ni/mailbox.ts';

/** 시계를 손으로 돌린다 — 만료를 실제 시간으로 기다릴 수는 없다. */
function fake(start = 1_000_000) {
  let at = start;
  return { now: () => at, tick: (ms: number) => { at += ms; } };
}

const msg = (from: string, to: string, token = 'dG9rZW4=') => ({ from, to, token });

test('놓은 토큰을 받는이 앞으로 찾아온다', () => {
  const box = createTokenMailbox();
  box.put(msg('tag-watch', 'phoneSub'));
  assert.deepStrictEqual(box.take('phoneSub').map((t) => t.from), ['tag-watch']);
  assert.deepStrictEqual(box.take('phoneMain'), [], '남의 우편함은 비어 있다');
});

test('가져가도 지워지지 않는다 — 응답 한 번 놓쳤다고 토큰이 사라지면 안 된다', () => {
  const box = createTokenMailbox();
  box.put(msg('tag-watch', 'phoneSub'));
  box.take('phoneSub');
  assert.strictEqual(box.take('phoneSub').length, 1, '두 번째 조회에도 그대로 있다');
});

test('같은 보낸이가 다시 놓으면 덮어쓴다 — 묵은 토큰이 남으면 죽은 세션을 붙잡는다', () => {
  const clock = fake();
  const box = createTokenMailbox({ now: clock.now });
  box.put(msg('tag-watch', 'phoneSub', '옛토큰'));
  clock.tick(2000);
  box.put(msg('tag-watch', 'phoneSub', '새토큰'));
  const found = box.take('phoneSub');
  assert.strictEqual(found.length, 1, '두 통이 쌓이지 않는다');
  assert.strictEqual(found[0].token, '새토큰');
});

test('보낸이가 다르면 따로 쌓이고 놓인 순서로 준다', () => {
  const clock = fake();
  const box = createTokenMailbox({ now: clock.now });
  box.put(msg('phoneSub', 'tag-watch'));
  clock.tick(100);
  box.put(msg('phoneMain', 'tag-watch'));
  assert.deepStrictEqual(box.take('tag-watch').map((t) => t.from), ['phoneSub', 'phoneMain']);
});

test('갱신이 끊기면 만료돼 사라진다 — 꺼진 폰의 토큰을 계속 물면 안 된다', () => {
  const clock = fake();
  const box = createTokenMailbox({ expireMs: 15_000, now: clock.now });
  box.put(msg('tag-watch', 'phoneSub'));
  clock.tick(14_000);
  assert.strictEqual(box.take('phoneSub').length, 1, '아직 살아 있다');
  clock.tick(2000);
  assert.strictEqual(box.take('phoneSub').length, 0);
  assert.strictEqual(box.size(), 0, '빈 우편함은 통째로 정리된다');
});

test('보내는 쪽이 계속 놓으면 만료되지 않는다', () => {
  const clock = fake();
  const box = createTokenMailbox({ expireMs: 15_000, now: clock.now });
  for (let i = 0; i < 20; i++) {
    box.put(msg('tag-watch', 'phoneSub'));
    clock.tick(1500);   // 앱의 재전송 주기
  }
  assert.strictEqual(box.take('phoneSub').length, 1);
});

test('역할 ID 모양을 검사한다', () => {
  assert.ok(isPeerId('phoneMain'));
  assert.ok(isPeerId('tag-watch'));
  assert.ok(!isPeerId('phone Main'), '공백은 안 된다');
  assert.ok(!isPeerId(''));
  assert.ok(!isPeerId('../etc'), '경로 문자는 안 된다');
});

test('본문 검증 — 모양이 맞아야 받는다', () => {
  assert.deepStrictEqual(parseTokenMessage(msg('a', 'b')), { from: 'a', to: 'b', token: 'dG9rZW4=' });
  assert.strictEqual(parseTokenMessage(null), null);
  assert.strictEqual(parseTokenMessage({ from: 'a', to: 'b' }), null, 'token이 없다');
  assert.strictEqual(parseTokenMessage({ from: 'a', to: 'b', token: '' }), null, '빈 토큰');
  assert.strictEqual(parseTokenMessage({ from: 'a b', to: 'c', token: 'x' }), null, '이상한 보낸이');
  assert.strictEqual(
    parseTokenMessage({ from: 'a', to: 'b', token: 'x'.repeat(8193) }), null, '상한을 넘는 토큰');
});
