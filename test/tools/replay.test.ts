import * as assert from 'node:assert/strict';
import test from 'node:test';
import { ReplayPlayer, parseNdjson } from '../../tools/replay.ts';

test('빈 줄과 주석을 제외하고 NDJSON을 파싱한다', () => {
  const records = parseNdjson([
    '# recorded ingest',
    '',
    '{"tagId":"tag-watch","ts":100}',
    '{"tagId":"tag-watch","ts":120}',
  ].join('\n'));

  assert.deepEqual(records, [
    { tagId: 'tag-watch', ts: 100 },
    { tagId: 'tag-watch', ts: 120 },
  ]);
});

test('잘못된 NDJSON의 줄 번호를 알린다', () => {
  assert.throws(
    () => parseNdjson('{"ts":0}\nnot-json'),
    /invalid NDJSON at line 2/,
  );
});

test('시간 역순인 레코드를 거부한다', () => {
  assert.throws(
    () => parseNdjson('{"ts":20}\n{"ts":10}'),
    /timestamp is earlier/,
  );
});

test('타임스탬프 간격과 배속에 맞춰 레코드를 재생한다', () => {
  const scheduled: { callback: () => void; delay: number }[] = [];
  const emitted: number[] = [];
  let ended = false;
  const schedule = (callback: () => void, delay: number): number => {
    scheduled.push({ callback, delay });
    return scheduled.length;
  };
  const player = new ReplayPlayer(
    [{ ts: 100 }, { ts: 120 }, { ts: 170 }],
    { speed: 2, schedule },
  );

  player.play((record) => emitted.push(record.ts), () => { ended = true; });
  assert.equal(scheduled[0].delay, 0);

  scheduled[0].callback();
  assert.equal(scheduled[1].delay, 10);

  scheduled[1].callback();
  assert.equal(scheduled[2].delay, 25);

  scheduled[2].callback();
  assert.deepEqual(emitted, [100, 120, 170]);
  assert.equal(ended, true);
});
