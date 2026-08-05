// 반출 큐 검사(spec system 03 §7.3).

import * as assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createExportQueue, dayOf } from '../../server/events/export/queue.ts';
import type { TrainingSample } from '../../server/events/export/sample.ts';

const T0 = Date.parse('2026-08-05T09:00:00Z');
const DAY = 86_400_000;

function bench(keepDays = 7) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'export-'));
  return { root, queue: createExportQueue(root, keepDays) };
}

function sample(label: 0 | 1 = 1): TrainingSample {
  return { dt: [0, 20], ax: [0, 0], ay: [0, 0], az: [9.8, 9.9], label };
}

test('표본은 그날 배치에 한 줄씩 붙는다', () => {
  const { queue } = bench();
  queue.append(sample(1), T0);
  queue.append(sample(0), T0 + 1000);

  const batches = queue.batches();
  assert.equal(batches.length, 1, '같은 날이면 파일 하나다');
  assert.equal(path.basename(batches[0]), '2026-08-05.jsonl');

  const lines = fs.readFileSync(batches[0], 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]).label, 1);
  assert.deepEqual(JSON.parse(lines[1]).label, 0);
});

test('날이 바뀌면 배치가 갈리고 오래된 것부터 나온다', () => {
  const { queue } = bench();
  queue.append(sample(), T0 + DAY);
  queue.append(sample(), T0);

  assert.deepEqual(queue.batches().map((f) => path.basename(f)), ['2026-08-05.jsonl', '2026-08-06.jsonl']);
});

test('보낸 배치는 sent로 옮겨진다', () => {
  const { queue } = bench();
  queue.append(sample(), T0);
  const [file] = queue.batches();

  queue.markSent(file);
  assert.deepEqual(queue.batches(), [], 'pending에서 사라진다');
  assert.ok(fs.existsSync(path.join(queue.sentDir, '2026-08-05.jsonl')));
});

test('같은 날 두 번째 배치는 덮어쓰지 않고 이어 붙인다', () => {
  const { queue } = bench();
  queue.append(sample(1), T0);
  queue.markSent(queue.batches()[0]);

  queue.append(sample(0), T0 + 1000); // 같은 날 다시 쌓인다
  queue.markSent(queue.batches()[0]);

  const kept = fs.readFileSync(path.join(queue.sentDir, '2026-08-05.jsonl'), 'utf8').trim().split('\n');
  assert.equal(kept.length, 2, '먼저 보낸 것이 사라지지 않는다');
});

test('sent는 보관 일수가 지나면 정리된다 — 파일 시각이 아니라 이름의 날짜로 본다', () => {
  const { queue } = bench(7);
  queue.append(sample(), T0 - 10 * DAY);
  queue.append(sample(), T0);
  for (const file of queue.batches()) queue.markSent(file);

  assert.equal(queue.sweepSent(T0), 1);
  assert.deepEqual(fs.readdirSync(queue.sentDir), ['2026-08-05.jsonl']);
});

test('state는 없으면 0에서 시작하고 깨져도 동작을 안 막는다', () => {
  const { root, queue } = bench();
  assert.deepEqual(queue.state().totalSent, 0);

  queue.saveState({ ...queue.state(), totalSent: 3 });
  assert.equal(queue.state().totalSent, 3);

  fs.writeFileSync(path.join(root, 'state.json'), '{ 반쪽', 'utf8');
  assert.equal(queue.state().totalSent, 0, '깨진 파일은 누계만 잃는다');
});

test('배치 이름 규칙 밖의 파일은 전송 대상이 아니다', () => {
  const { queue } = bench();
  queue.append(sample(), T0);
  fs.writeFileSync(path.join(queue.pendingDir, 'notes.txt'), 'hello', 'utf8');

  assert.deepEqual(queue.batches().map((f) => path.basename(f)), ['2026-08-05.jsonl']);
});

test('배치 이름은 UTC 날짜다 — 파일 이름으로 시설 시간대를 흘리지 않는다', () => {
  assert.equal(dayOf(Date.parse('2026-08-05T23:30:00Z')), '2026-08-05');
});
