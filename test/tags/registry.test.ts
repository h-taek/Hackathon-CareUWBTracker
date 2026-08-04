import test from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createTagRegistry, normalizeLabel, isValidTagId } from '../../server/tags/registry.ts';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'registry-test-'));
}

test('등록하면 수집 대상이 된다', () => {
  const reg = createTagRegistry(tmpDir());
  assert.strictEqual(reg.isActive('tag-101'), false, '등록 전에는 수집하지 않는다');
  reg.register('tag-101', '301호 김OO', 'operator');
  assert.strictEqual(reg.isActive('tag-101'), true);
  assert.strictEqual(reg.get('tag-101')?.label, '301호 김OO');
});

test('반납하면 그 순간부터 수집 대상이 아니다', () => {
  const reg = createTagRegistry(tmpDir());
  reg.register('tag-101', '김OO', 'operator');
  const released = reg.release('tag-101', 'operator');
  assert.ok(released?.releasedAt, '반납 시각이 남는다');
  assert.strictEqual(released?.releasedBy, 'operator');
  assert.strictEqual(reg.isActive('tag-101'), false);
});

test('이미 반납한 태그를 또 반납하면 아무 일도 안 일어난다', () => {
  const reg = createTagRegistry(tmpDir());
  reg.register('tag-101', '김OO', 'operator');
  const first = reg.release('tag-101', 'operator');
  assert.strictEqual(reg.release('tag-101', 'operator'), null);
  // 두 번째 호출이 시각을 덮어쓰면 안 된다 — 확인자료의 반납 시각이 흔들린다.
  assert.strictEqual(reg.get('tag-101')?.releasedAt, first?.releasedAt);
});

test('없는 태그는 반납할 수 없다', () => {
  const reg = createTagRegistry(tmpDir());
  assert.strictEqual(reg.release('tag-999', 'operator'), null);
});

test('반납한 태그를 다시 등록하면 새 배정으로 되살아난다', () => {
  const reg = createTagRegistry(tmpDir());
  reg.register('tag-101', '김OO', 'operator');
  reg.release('tag-101', 'operator');
  reg.register('tag-101', '이OO', 'operator');
  assert.strictEqual(reg.isActive('tag-101'), true);
  assert.strictEqual(reg.get('tag-101')?.releasedAt, undefined);
  assert.strictEqual(reg.get('tag-101')?.label, '이OO');
});

test('반납분은 목록에 남고 활성 명부에서는 빠진다', () => {
  const reg = createTagRegistry(tmpDir());
  reg.register('tag-101', '김OO', 'operator');
  reg.register('tag-102', '이OO', 'operator');
  reg.release('tag-101', 'operator');
  assert.deepStrictEqual(reg.active().map((t) => t.tagId), ['tag-102']);
  assert.deepStrictEqual(reg.list().map((t) => t.tagId), ['tag-101', 'tag-102']);
});

test('재기동해도 반납 상태가 유지된다 — 안 그러면 반납한 태그가 되살아난다', () => {
  const dir = tmpDir();
  const first = createTagRegistry(dir);
  first.register('tag-101', '김OO', 'operator');
  first.register('tag-102', '이OO', 'operator');
  first.release('tag-101', 'operator');

  const reopened = createTagRegistry(dir);
  assert.strictEqual(reopened.isActive('tag-101'), false);
  assert.strictEqual(reopened.isActive('tag-102'), true);
  assert.strictEqual(reopened.get('tag-101')?.releasedBy, 'operator');
});

test('명부 파일이 없으면 빈 상태로 시작한다', () => {
  const reg = createTagRegistry(path.join(tmpDir(), '없는폴더'));
  assert.deepStrictEqual(reg.list(), []);
});

test('표시명은 공백을 다듬고 빈 값·과길이를 거절한다', () => {
  assert.strictEqual(normalizeLabel('  301호 김OO  '), '301호 김OO');
  assert.strictEqual(normalizeLabel(''), null);
  assert.strictEqual(normalizeLabel('   '), null);
  assert.strictEqual(normalizeLabel('가'.repeat(41)), null);
  assert.strictEqual(normalizeLabel(42), null);
});

test('태그 ID는 좁게 받는다', () => {
  assert.strictEqual(isValidTagId('tag-101'), true);
  assert.strictEqual(isValidTagId('tag_101'), true);
  assert.strictEqual(isValidTagId('../etc/passwd'), false);
  assert.strictEqual(isValidTagId(''), false);
  assert.strictEqual(isValidTagId(null), false);
});

test('시뮬 장부와 실기기 장부는 서로를 보지 못한다', () => {
  // 실기기 검증 중에 명부가 "수집 중 3명"이라고 거짓말하던 자리다. 시뮬로 띄우면
  // 배경 태그가 자동 등록되는데, 장부가 한 파일이면 그게 파일에 남아 다음 live 기동에도 뜬다.
  const dir = tmpDir();
  const sim = createTagRegistry(dir, { fileName: 'registry.sim.json' });
  sim.register('tag-101', '김OO', 'system');
  sim.register('tag-102', '이OO', 'system');

  const live = createTagRegistry(dir, { fileName: 'registry.live.json' });
  assert.deepStrictEqual(live.list(), [], '실기기 장부는 비어서 시작한다');
  assert.strictEqual(live.isActive('tag-101'), false, '시뮬 태그는 수집 대상이 아니다');

  // 반대 방향도 막혀야 한다 — 실기기에서 배정한 워치가 시뮬 장부에 새면 안 된다.
  live.register('tag-watch', '301호 김OO', 'operator');
  const simAgain = createTagRegistry(dir, { fileName: 'registry.sim.json' });
  assert.deepStrictEqual(simAgain.list().map((t) => t.tagId), ['tag-101', 'tag-102']);
});

test('같은 장부는 다시 열어도 그대로 읽힌다 — 나누는 것은 파일이지 지속성이 아니다', () => {
  const dir = tmpDir();
  const first = createTagRegistry(dir, { fileName: 'registry.live.json' });
  first.register('tag-watch', '301호 김OO', 'operator');
  first.release('tag-watch', 'operator');

  const again = createTagRegistry(dir, { fileName: 'registry.live.json' });
  assert.strictEqual(again.get('tag-watch')?.releasedBy, 'operator');
  assert.strictEqual(again.isActive('tag-watch'), false, '재기동으로 반납이 풀리면 안 된다');
});
