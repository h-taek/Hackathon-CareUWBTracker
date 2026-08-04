import test from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createOperatorRegistry,
  normalizeOperatorName,
  isValidOperatorId,
  DEFAULT_OPERATOR_NAMES,
} from '../../server/operators/registry.ts';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'operators-test-'));
}

test('명부가 비어 있으면 기본값을 깔고 파일로 남긴다', () => {
  const dir = tmpDir();
  const reg = createOperatorRegistry(dir);
  assert.strictEqual(reg.active().length, DEFAULT_OPERATOR_NAMES.length);
  assert.strictEqual(reg.active()[0].name, DEFAULT_OPERATOR_NAMES[0]);
  // 제출본을 받은 사람이 준비 없이 띄워도 들어갈 수 있어야 한다.
  assert.ok(fs.existsSync(reg.file), '기본값은 파일로 남아야 재기동해도 같다');
});

test('ID는 서버가 매긴다 — 이름을 키로 쓰지 않는다', () => {
  const reg = createOperatorRegistry(tmpDir(), { seed: [] });
  const first = reg.add('김간호', 'unidentified');
  const second = reg.add('이간호', 'unidentified');
  assert.strictEqual(first?.operatorId, 'op-1');
  assert.strictEqual(second?.operatorId, 'op-2');
  assert.strictEqual(first?.addedBy, 'unidentified');
});

test('같은 이름을 두 번 넣을 수 없다 — 드롭다운에서 구분이 안 된다', () => {
  const reg = createOperatorRegistry(tmpDir(), { seed: [] });
  assert.ok(reg.add('김간호', 'op-1'));
  assert.strictEqual(reg.add('김간호', 'op-1'), null);
});

test('지운 사람과 같은 이름은 다시 들어올 수 있다', () => {
  const reg = createOperatorRegistry(tmpDir(), { seed: [] });
  const gone = reg.add('김간호', 'op-1');
  reg.remove(gone!.operatorId, 'op-1');
  const again = reg.add('김간호', 'op-1');
  assert.ok(again, '동명이인이 새로 올 수 있다');
  // 다른 사람이므로 ID가 달라야 한다 — 옛 확인자료가 새 사람을 가리키면 안 된다.
  assert.notStrictEqual(again?.operatorId, gone?.operatorId);
});

test('삭제해도 파일에는 남아 이름 대조가 계속 된다', () => {
  const dir = tmpDir();
  const reg = createOperatorRegistry(dir, { seed: [] });
  const entry = reg.add('김간호', 'op-1')!;
  const removed = reg.remove(entry.operatorId, 'op-1');

  assert.ok(removed?.removedAt, '삭제 시각이 남는다');
  assert.strictEqual(removed?.removedBy, 'op-1');
  assert.strictEqual(reg.isActive(entry.operatorId), false);
  assert.strictEqual(reg.active().length, 0, '명부에서는 내려간다');
  assert.strictEqual(reg.get(entry.operatorId)?.name, '김간호', '확인자료 대조용으로 남는다');
  assert.strictEqual(reg.list().length, 1);
});

test('지운 번호를 재사용하지 않는다', () => {
  const reg = createOperatorRegistry(tmpDir(), { seed: [] });
  const first = reg.add('김간호', 'op-1')!;
  reg.remove(first.operatorId, 'op-1');
  // 재사용하면 옛 확인자료의 op-1이 새 사람을 가리킨다.
  assert.strictEqual(reg.add('이간호', 'op-1')?.operatorId, 'op-2');
});

test('이미 지운 사람을 또 지우면 시각이 안 흔들린다', () => {
  const reg = createOperatorRegistry(tmpDir(), { seed: [] });
  const entry = reg.add('김간호', 'op-1')!;
  const first = reg.remove(entry.operatorId, 'op-1');
  assert.strictEqual(reg.remove(entry.operatorId, 'op-1'), null);
  assert.strictEqual(reg.get(entry.operatorId)?.removedAt, first?.removedAt);
});

test('재기동해도 삭제가 풀리지 않는다', () => {
  const dir = tmpDir();
  const before = createOperatorRegistry(dir, { seed: ['김간호', '이간호'] });
  before.remove('op-1', 'op-2');

  const after = createOperatorRegistry(dir, { seed: [] });
  assert.strictEqual(after.isActive('op-1'), false);
  assert.deepStrictEqual(after.active().map((o) => o.operatorId), ['op-2']);
});

test('이름 검증은 빈 값과 과한 길이만 막는다', () => {
  assert.strictEqual(normalizeOperatorName('  김간호  '), '김간호');
  assert.strictEqual(normalizeOperatorName('   '), null);
  assert.strictEqual(normalizeOperatorName('가'.repeat(21)), null);
  assert.strictEqual(normalizeOperatorName(42), null);
});

test('ID 검증은 서버가 매긴 형식만 받는다', () => {
  assert.strictEqual(isValidOperatorId('op-1'), true);
  assert.strictEqual(isValidOperatorId('op-0'), false);
  assert.strictEqual(isValidOperatorId('김간호'), false, '한글 이름을 ID로 쓰지 않는다');
  assert.strictEqual(isValidOperatorId('../etc'), false);
});
