import * as assert from 'node:assert/strict';
import test from 'node:test';
import {
  ANCHOR_FLAGS,
  ANCHOR_OPTION_LINES,
  parseAnchorConfig,
} from '../../server/config/anchor.ts';

const VALID_ARGS = [
  '--main-anchor-id', 'phoneMain',
  '--sub-anchor-id', 'phoneSub',
  '--anchor-distance', '4.5',
  '--half-plane', 'positive',
];

test('필수 앵커 실행 인자를 파싱한다', () => {
  assert.deepEqual(parseAnchorConfig(VALID_ARGS), {
    mainAnchorId: 'phoneMain',
    subAnchorId: 'phoneSub',
    anchorDistance: 4.5,
    halfPlane: 'positive',
  });
});

test('--flag=value 형식과 negative 반평면을 지원한다', () => {
  assert.deepEqual(parseAnchorConfig([
    '--main-anchor-id=main',
    '--sub-anchor-id=sub',
    '--anchor-distance=3',
    '--half-plane=negative',
  ]), {
    mainAnchorId: 'main',
    subAnchorId: 'sub',
    anchorDistance: 3,
    halfPlane: 'negative',
  });
});

test('누락되거나 값이 없는 실행 인자를 거부한다', () => {
  assert.throws(() => parseAnchorConfig([]), /--main-anchor-id/);
  assert.throws(
    () => parseAnchorConfig(['--main-anchor-id', '--sub-anchor-id', 'sub']),
    /값이 필요합니다: --main-anchor-id/,
  );
});

test('알 수 없거나 중복된 실행 인자를 거부한다', () => {
  assert.throws(() => parseAnchorConfig([...VALID_ARGS, '--unknown', 'x']), /알 수 없는/);
  assert.throws(
    () => parseAnchorConfig([...VALID_ARGS, '--main-anchor-id', 'other']),
    /중복되었습니다/,
  );
});

test('두 앵커 ID가 같으면 거부한다', () => {
  assert.throws(
    () => parseAnchorConfig(VALID_ARGS.map((value) => value === 'phoneSub' ? 'phoneMain' : value)),
    /ID는 달라야/,
  );
});

test('앵커 거리는 0보다 큰 유한한 숫자만 허용한다', () => {
  for (const distance of ['0', '-1', 'NaN', 'Infinity']) {
    const args = VALID_ARGS.map((value) => value === '4.5' ? distance : value);
    assert.throws(() => parseAnchorConfig(args), /0보다 큰 유한한 숫자/);
  }
});

test('반평면은 positive 또는 negative만 허용한다', () => {
  const args = VALID_ARGS.map((value) => value === 'positive' ? 'left' : value);
  assert.throws(() => parseAnchorConfig(args), /positive 또는 negative/);
});

test('사용법 조각과 소유 플래그 목록을 노출한다', () => {
  assert.match(ANCHOR_OPTION_LINES, /--anchor-distance/);
  // 목록이 두 곳으로 갈라지면 cli.ts의 argv 분배가 조용히 어긋난다.
  assert.deepEqual([...ANCHOR_FLAGS].sort(), [
    '--anchor-distance', '--half-plane', '--main-anchor-id', '--sub-anchor-id',
  ]);
  for (const flag of ANCHOR_FLAGS) assert.match(ANCHOR_OPTION_LINES, new RegExp(flag));
});
