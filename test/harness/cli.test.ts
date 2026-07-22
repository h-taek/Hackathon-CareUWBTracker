import * as assert from 'node:assert/strict';
import test from 'node:test';
import { parseArgs, runGenerate } from '../../harness/cli.ts';
import type { ReplayRecord } from '../../harness/replay.ts';

test('generate CLI 옵션을 파싱한다', () => {
  assert.deepEqual(
    parseArgs(['generate', '--hz', '25', '--anchor-distance', '5', '--count', '10', '--fall-after', '2']),
    { command: 'generate', hz: 25, anchorDistance: 5, count: 10, fallAfter: 2, url: undefined },
  );
});

test('replay CLI 옵션을 파싱한다', () => {
  assert.deepEqual(
    parseArgs(['replay', 'sample.ndjson', '--speed', '2', '--url', 'http://localhost:8080/ingest']),
    { command: 'replay', file: 'sample.ndjson', speed: 2, url: 'http://localhost:8080/ingest' },
  );
});

test('알 수 없는 옵션과 잘못된 숫자를 거부한다', () => {
  assert.throws(() => parseArgs(['generate', '--unknown', '1']), /unknown option/);
  assert.throws(() => parseArgs(['generate', '--hz', '0']), /must be a positive number/);
  assert.throws(() => parseArgs(['generate', '--count', '1.5']), /must be an integer/);
});

test('유한 generate 실행이 지정된 개수만큼 즉시 종료된다', () => {
  const records: ReplayRecord[] = [];
  runGenerate({ command: 'generate', hz: 50, anchorDistance: 4, count: 1, fallAfter: 0 }, (record) => records.push(record));

  assert.equal(records.length, 1);
  assert.equal(records[0].source, 'sim');
  assert.deepEqual(records[0].accel, { x: 0.1, y: 0.1, z: 0.2 });
});
