// 서버를 실제로 띄워 실행 인자 배선을 확인한다.
// 단위 테스트는 파서마다 다 통과했는데 정작 server.ts가 둘을 조합하는 지점이 깨져 있었다
// (--source가 앵커 파서에 막혀 서버가 아예 안 떴다). 조합을 보는 테스트가 없어 못 잡았다.

import * as assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server', 'server.ts');
const ANCHOR_ARGS = [
  '--main-anchor-id', 'phoneMain',
  '--sub-anchor-id', 'phoneSub',
  '--anchor-distance', '4',
  '--half-plane', 'positive',
];

interface Launch {
  code: number | null;
  output: string;
}

/** 서버를 띄우고 startup 로그가 다 나오면(또는 죽으면) 결과를 돌려준다. */
function launch(args: readonly string[], timeoutMs = 20000): Promise<Launch> {
  return new Promise((resolve, reject) => {
    // PORT=0으로 OS가 빈 포트를 잡게 해 다른 테스트·개발 서버와 부딪히지 않게 한다.
    const child = spawn(process.execPath, [SERVER, ...args], {
      env: { ...process.env, PORT: '0', FALL_AI: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      resolve({ code, output });
    };

    const timer = setTimeout(() => {
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`서버가 시간 내에 응답하지 않았다:\n${output}`));
    }, timeoutMs);

    // startup 로그의 마지막 줄("  소스       sim ...")이 나오면 배선 확인은 끝.
    // 사용법 본문에도 "소스"라는 낱말이 있으므로 줄머리 위치까지 맞춰야 헷갈리지 않는다.
    const STARTED = /\n\s*소스\s+(sim|live)\b/;
    const collect = (chunk: Buffer) => {
      output += chunk.toString();
      if (STARTED.test(output)) finish(null);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('exit', (code) => finish(code));
    child.on('error', reject);
  });
}

test('앵커 인자만 주면 sim 모드로 뜬다', async () => {
  const { output } = await launch(ANCHOR_ARGS);
  assert.match(output, /소스\s+sim/);
});

test('--source live로 실측 전용 모드로 뜬다', async () => {
  const { output } = await launch([...ANCHOR_ARGS, '--source', 'live']);
  assert.match(output, /소스\s+live/);
  assert.doesNotMatch(output, /실행 인자 오류/);
});

test('알 수 없는 인자면 사용법을 보여주고 종료한다', async () => {
  const { code, output } = await launch([...ANCHOR_ARGS, '--nope', 'x']);
  assert.equal(code, 1);
  assert.match(output, /알 수 없는 실행 인자: --nope/);
  assert.match(output, /--source/); // 사용법에 모든 옵션이 나와야 한다
});

test('--help는 사용법만 출력하고 정상 종료한다', async () => {
  const { code, output } = await launch(['--help']);
  assert.equal(code, 0);
  assert.match(output, /--source/);
});
