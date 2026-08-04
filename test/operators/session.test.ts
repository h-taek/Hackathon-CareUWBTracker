import test from 'node:test';
import * as assert from 'node:assert';
import {
  createSessionStore,
  readCookie,
  sessionCookie,
  clearedSessionCookie,
  SESSION_COOKIE,
  SESSION_TTL_MS,
} from '../../server/operators/session.ts';

/** 시계를 손으로 돌린다. 만료를 실제 3시간 기다릴 수는 없다. */
function clock(start = 1_000_000) {
  let at = start;
  return { now: () => at, advance: (ms: number) => { at += ms; } };
}

test('세션 수명은 3시간이고 발급 시각부터 잰다', () => {
  const time = clock();
  const store = createSessionStore({ now: time.now });
  const session = store.open('op-1');
  assert.strictEqual(session.expiresAt - session.openedAt, SESSION_TTL_MS);
});

test('만료되면 사라지고 확인자료에 남는다', () => {
  const time = clock();
  const expired: string[] = [];
  const store = createSessionStore({
    now: time.now,
    ttlMs: 1000,
    onExpire: (s) => expired.push(s.operatorId),
  });
  const session = store.open('op-1');

  time.advance(999);
  assert.strictEqual(store.get(session.sid)?.operatorId, 'op-1');
  assert.deepStrictEqual(expired, [], '아직 살아 있다');

  time.advance(1);
  assert.strictEqual(store.get(session.sid), null);
  assert.deepStrictEqual(expired, ['op-1'], '만료도 처리 행위다');
  // 두 번 세면 확인자료에 같은 만료가 두 줄 남는다.
  assert.strictEqual(store.get(session.sid), null);
  assert.deepStrictEqual(expired, ['op-1']);
});

test('조용히 있어도 만료된다 — 조회가 수명을 늘리지 않는다', () => {
  const time = clock();
  const store = createSessionStore({ now: time.now, ttlMs: 1000 });
  const session = store.open('op-1');
  time.advance(600);
  assert.ok(store.get(session.sid), '아직 살아 있다');
  time.advance(600); // 마지막 조회로부터는 600ms뿐이지만 발급으로부터는 1200ms다
  assert.strictEqual(store.get(session.sid), null);
});

test('교대 종료는 그 세션만 끊는다', () => {
  const store = createSessionStore();
  const first = store.open('op-1');
  const second = store.open('op-2');
  assert.strictEqual(store.close(first.sid)?.operatorId, 'op-1');
  assert.strictEqual(store.get(first.sid), null);
  assert.ok(store.get(second.sid), '남의 세션은 건드리지 않는다');
});

test('명부에서 지우면 그 관제사의 세션이 끊긴다', () => {
  const store = createSessionStore();
  const session = store.open('op-1');
  const other = store.open('op-2');
  // 안 끊으면 명부에서 내린 사람이 남은 교대 시간 동안 계속 판정한다.
  assert.strictEqual(store.closeOperator('op-1')?.sid, session.sid);
  assert.strictEqual(store.get(session.sid), null);
  assert.ok(store.get(other.sid));
  assert.strictEqual(store.closeOperator('op-9'), null);
});

test('없는 쿠키·빈 쿠키로는 세션을 못 얻는다', () => {
  const store = createSessionStore();
  store.open('op-1');
  assert.strictEqual(store.get(null), null);
  assert.strictEqual(store.get(''), null);
  assert.strictEqual(store.get('아무거나'), null);
});

test('쿠키 헤더에서 세션만 골라낸다', () => {
  assert.strictEqual(readCookie(`a=1; ${SESSION_COOKIE}=abc; b=2`, SESSION_COOKIE), 'abc');
  assert.strictEqual(readCookie('a=1', SESSION_COOKIE), null);
  assert.strictEqual(readCookie(undefined, SESSION_COOKIE), null);
  assert.strictEqual(readCookie(`${SESSION_COOKIE}=`, SESSION_COOKIE), null);
});

test('쿠키는 스크립트가 읽지 못한다', () => {
  const value = sessionCookie('abc', 3000);
  // 행위자는 서버가 정한다. 화면이 쿠키를 읽고 고쳐 보내면 그 자체가 위조 통로다.
  assert.match(value, /HttpOnly/);
  assert.match(value, /SameSite=Lax/);
  assert.match(value, /Max-Age=3\b/);
  // 시설 내부망 http로 뜨는 서버라 Secure를 붙이면 쿠키가 아예 안 실린다.
  assert.doesNotMatch(value, /Secure/);
  assert.match(clearedSessionCookie(), /Max-Age=0/);
});
