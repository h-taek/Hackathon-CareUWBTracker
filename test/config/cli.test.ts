import * as assert from 'node:assert/strict';
import test from 'node:test';
import {
  SERVER_CONFIG_USAGE,
  parseServerConfig,
  wantsHelp,
} from '../../server/config/cli.ts';

const ANCHOR_ARGS = [
  '--main-anchor-id', 'phoneMain',
  '--sub-anchor-id', 'phoneSub',
  '--anchor-distance', '4',
  '--half-plane', 'positive',
];

const ANCHOR = {
  mainAnchorId: 'phoneMain',
  subAnchorId: 'phoneSub',
  anchorDistance: 4,
  halfPlane: 'positive',
};

test('소스를 생략하면 sim이다', () => {
  assert.deepEqual(parseServerConfig(ANCHOR_ARGS), { anchor: ANCHOR, source: 'sim' });
});

// 회귀 방지: 앵커 파서가 argv 전체를 심판하던 시절 --source는 "알 수 없는 실행 인자"로
// 막혀 서버가 뜨지도 못했다. 문서 3곳(server/README, plan/06, PROGRESS)은 된다고 적혀 있었다.
test('앵커 인자와 --source를 함께 받는다', () => {
  assert.deepEqual(
    parseServerConfig([...ANCHOR_ARGS, '--source', 'live']),
    { anchor: ANCHOR, source: 'live' },
  );
  assert.deepEqual(
    parseServerConfig(['--source=live', ...ANCHOR_ARGS]),
    { anchor: ANCHOR, source: 'live' },
  );
});

test('인자 순서가 섞여도 소유자별로 나눠 해석한다', () => {
  assert.deepEqual(
    parseServerConfig([
      '--main-anchor-id', 'phoneMain',
      '--source', 'live',
      '--sub-anchor-id', 'phoneSub',
      '--anchor-distance', '4',
      '--half-plane', 'positive',
    ]),
    { anchor: ANCHOR, source: 'live' },
  );
});

test('알 수 없는 인자는 한 곳에서 거절한다', () => {
  assert.throws(() => parseServerConfig([...ANCHOR_ARGS, '--nope', 'x']), /알 수 없는 실행 인자: --nope/);
  assert.throws(() => parseServerConfig([...ANCHOR_ARGS, 'garbage']), /알 수 없는 실행 인자: garbage/);
});

test('--source 오타를 조용히 sim으로 흘리지 않는다', () => {
  assert.throws(() => parseServerConfig([...ANCHOR_ARGS, '--source', 'liv']), /sim 또는 live/);
  assert.throws(() => parseServerConfig([...ANCHOR_ARGS, '--source=LIVE']), /sim 또는 live/);
});

test('--source 값 누락과 중복을 거부한다', () => {
  assert.throws(() => parseServerConfig([...ANCHOR_ARGS, '--source']), /값이 필요합니다: --source/);
  assert.throws(
    () => parseServerConfig([...ANCHOR_ARGS, '--source', 'sim', '--source', 'live']),
    /중복되었습니다: --source/,
  );
});

test('앵커 인자 오류는 그대로 전달된다', () => {
  assert.throws(() => parseServerConfig(['--source', 'live']), /--main-anchor-id/);
  assert.throws(
    () => parseServerConfig([...ANCHOR_ARGS.slice(0, 4), '--anchor-distance', '--source', 'live']),
    /값이 필요합니다: --anchor-distance/,
  );
});

test('도움말과 사용법은 모든 옵션을 담는다', () => {
  assert.equal(wantsHelp(['--help']), true);
  assert.equal(wantsHelp(['-h']), true);
  assert.equal(wantsHelp(ANCHOR_ARGS), false);
  for (const flag of ['--main-anchor-id', '--sub-anchor-id', '--anchor-distance', '--half-plane', '--source']) {
    assert.match(SERVER_CONFIG_USAGE, new RegExp(flag));
  }
});
