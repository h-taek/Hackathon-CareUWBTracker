import * as assert from 'node:assert/strict';
import test from 'node:test';
import { takeFlags } from '../../server/config/argv.ts';

test('소유한 플래그와 값만 가져가고 나머지는 남긴다', () => {
  const split = takeFlags(
    ['--main-anchor-id', 'A', '--source', 'live', '--half-plane', 'positive'],
    ['--main-anchor-id', '--half-plane'],
  );
  assert.deepEqual(split.taken, ['--main-anchor-id', 'A', '--half-plane', 'positive']);
  assert.deepEqual(split.rest, ['--source', 'live']);
});

test('--flag=value 형식은 한 토큰으로 가져간다', () => {
  const split = takeFlags(['--source=live', '--half-plane=positive'], ['--source']);
  assert.deepEqual(split.taken, ['--source=live']);
  assert.deepEqual(split.rest, ['--half-plane=positive']);
});

test('값이 빠진 플래그는 뒤 플래그를 삼키지 않는다', () => {
  // --anchor-distance의 값 누락은 앵커 파서가 알리고, --source는 제 소유자에게 가야 한다.
  const split = takeFlags(['--anchor-distance', '--source', 'live'], ['--anchor-distance']);
  assert.deepEqual(split.taken, ['--anchor-distance']);
  assert.deepEqual(split.rest, ['--source', 'live']);
});

test('마지막 위치의 값 없는 플래그도 안전하게 처리한다', () => {
  const split = takeFlags(['--source'], ['--source']);
  assert.deepEqual(split.taken, ['--source']);
  assert.deepEqual(split.rest, []);
});

test('플래그가 아닌 토큰은 그대로 남긴다', () => {
  const split = takeFlags(['garbage', '--source', 'sim'], ['--source']);
  assert.deepEqual(split.taken, ['--source', 'sim']);
  assert.deepEqual(split.rest, ['garbage']);
});
