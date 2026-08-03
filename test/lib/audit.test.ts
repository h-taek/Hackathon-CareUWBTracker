import * as assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createAuditLog, createCollectTracker, type AuditEntry } from '../../server/lib/audit.ts';

function bench(start = 1_700_000_000_000) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-'));
  const entries: AuditEntry[] = [];
  let clock = start;
  const log = createAuditLog(path.join(dir, 'audit'), {
    now: () => clock,
    onEntry: (e) => entries.push(e),
  });
  return { log, entries, dir: path.join(dir, 'audit'), tick: (ms: number) => { clock += ms; }, at: () => clock };
}

function linesOf(dir: string): AuditEntry[] {
  return fs.readdirSync(dir)
    .flatMap((name) => fs.readFileSync(path.join(dir, name), 'utf8').split('\n'))
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as AuditEntry);
}

test('기록은 날짜별 JSONL로 이어붙는다', () => {
  const { log, dir } = bench();
  log.record({ kind: 'use', tagId: 'tag-1', actor: 'system', detail: '낙상 감지' });
  log.record({ kind: 'access', actor: 'operator', detail: 'evt-1 판정' });

  const lines = linesOf(dir);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].kind, 'use');
  assert.equal(lines[1].actor, 'operator');
  assert.equal(fs.readdirSync(dir).length, 1, '하루치가 파일 하나다');
});

test('수집은 세션 단위다 — 프레임마다 남기지 않는다', () => {
  const { log, entries, tick } = bench();
  const tracker = createCollectTracker(log, { idleMs: 30_000, now: () => Date.now() });

  // 50Hz로 200프레임이 들어와도 개시 한 줄이다.
  for (let i = 0; i < 200; i++) tracker.touch('tag-1');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].detail, '측위 수집 개시');

  tick(45_000);
  tracker.flush();
  assert.equal(entries.length, 2);
  assert.match(entries[1].detail, /측위 수집 종료 · 45초/);
});

test('조용해진 태그의 세션은 다른 태그가 들어올 때 닫힌다', () => {
  const { log, entries } = bench();
  let clock = 0;
  const tracker = createCollectTracker(log, { idleMs: 1000, now: () => clock });

  tracker.touch('tag-1');
  clock = 2000;
  tracker.touch('tag-2'); // tag-1이 1초 넘게 조용했다

  const closed = entries.filter((e) => e.detail.startsWith('측위 수집 종료'));
  assert.equal(closed.length, 1);
  assert.equal(closed[0].tagId, 'tag-1');
});

test('열린 세션을 다시 열지 않는다', () => {
  const { log, entries } = bench();
  log.openCollect('tag-1');
  log.openCollect('tag-1');
  assert.equal(entries.length, 1);
});

test('안 열린 세션을 닫으라고 해도 아무 일도 안 일어난다', () => {
  const { log, entries } = bench();
  log.closeCollect('tag-없음');
  assert.equal(entries.length, 0);
});

test('좌표를 담을 자리가 스키마에 없다 — 확인자료는 처리 사실이지 위치값이 아니다', () => {
  const { log, dir } = bench();
  log.record({ kind: 'collect', tagId: 'tag-1', actor: 'system', detail: '측위 수집 개시' });

  const [line] = linesOf(dir);
  assert.deepEqual(Object.keys(line).sort(), ['actor', 'at', 'detail', 'kind', 'tagId']);
  assert.equal('pos' in line, false);
  assert.equal('x' in line, false);
});

test('디렉터리를 못 만들어도 서버는 안 죽는다', () => {
  // 파일 자리에 폴더를 만들려 하면 실패한다. 확인자료를 못 써도 관제는 계속 돌아야 한다.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-fail-'));
  const blocked = path.join(root, 'blocked');
  fs.writeFileSync(blocked, 'not a directory');
  const log = createAuditLog(blocked);

  assert.doesNotThrow(() => log.record({ kind: 'use', actor: 'system', detail: 'x' }));
});
