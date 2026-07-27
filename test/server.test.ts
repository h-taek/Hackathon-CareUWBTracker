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
      output += chunk.toString().normalize('NFC'); // 조합형/완성형 혼재 대비
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

// ── 주입 버튼이 실제 파이프라인을 통과하는가 ─────────────────────────────────────
// 여기서부터가 이 파일의 본론이다. 주입이 감지기를 거치지 않던 시절에는 화면에 뜨는 경보가
// 감지 성능과 무관했다. 지금은 서버를 띄우고 버튼을 눌러서, 나오는 경보가 감지기 판정인지
// (aiScore가 붙어 있는지) 확인한다.

interface Running {
  port: number;
  output: () => string;
  kill: () => void;
}

/** 서버를 띄운 채로 두고 실제 포트를 돌려준다. */
function start(args: readonly string[], env: Record<string, string> = {}): Promise<Running> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER, ...args], {
      env: { ...process.env, PORT: '0', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    let settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`서버가 안 떴다:\n${output}`));
    }, 30000);

    const collect = (chunk: Buffer) => {
      // 이 리포의 한글은 파일마다 조합형(NFD)과 완성형(NFC)이 섞여 있다. 서버가 찍는 글자가
      // 어느 쪽이든 테스트 정규식이 걸리도록 읽는 쪽에서 한 번 맞춘다.
      output += chunk.toString().normalize('NFC');
      const port = /localhost:(\d+)\/stream/.exec(output);
      if (port && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({
          port: Number(port[1]),
          output: () => output,
          kill: () => child.kill('SIGKILL'),
        });
      }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', reject);
  });
}

interface SseEvent { event: string; data: Record<string, unknown> }

/** /stream을 읽으며 stop()이 참을 돌려줄 때까지 이벤트를 모은다. */
async function collectStream(
  port: number,
  stop: (events: SseEvent[]) => boolean,
  timeoutMs = 30000,
): Promise<SseEvent[]> {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), timeoutMs);
  const events: SseEvent[] = [];
  try {
    const response = await fetch(`http://127.0.0.1:${port}/stream`, { signal: controller.signal });
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let cut = buffer.indexOf('\n\n');
      while (cut >= 0) {
        const frame = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const name = /^event: (.+)$/m.exec(frame);
        const payload = /^data: (.+)$/m.exec(frame);
        if (name && payload) events.push({ event: name[1], data: JSON.parse(payload[1]) });
        cut = buffer.indexOf('\n\n');
      }
      if (stop(events)) break;
    }
    controller.abort();
  } catch (error) {
    if ((error as Error).name !== 'AbortError') throw error;
  } finally {
    clearTimeout(deadline);
  }
  return events;
}

const alertsIn = (events: SseEvent[]) => events.filter((e) => e.event === 'alert');

test('낙상 클립을 주입하면 감지기가 감지 이벤트를 낸다', async () => {
  const server = await start([...ANCHOR_ARGS, '--source', 'live']);
  try {
    const clips = await (await fetch(`http://127.0.0.1:${server.port}/clips`)).json();
    assert.ok(Array.isArray(clips) && clips.length >= 1);
    assert.ok(clips.some((c: { id: string }) => c.id === 'fall-detected'));
    assert.equal(clips[0].samples, undefined, '목록에 원신호를 실으면 안 된다');

    const stream = collectStream(server.port, (events) => alertsIn(events).length >= 1);
    await new Promise((r) => setTimeout(r, 300)); // 구독이 붙고 나서 주입한다

    const started = await (await fetch(
      `http://127.0.0.1:${server.port}/inject-fall?tagId=tag-101&clip=fall-detected`,
    )).json();
    assert.equal(started.ok, true);
    assert.equal(started.clipId, 'fall-detected');
    assert.ok(started.frames > 150, '샘플 수가 AI 채점창보다 많아야 한다');

    const events = await stream;
    const alerts = alertsIn(events);
    // 감지는 한 단계다. 승격 이벤트가 따라오면 안 된다.
    assert.deepEqual(alerts.map((a) => a.data.type), ['fall_detected']);

    const candidate = alerts[0].data;
    // aiScore가 붙어 있다는 건 LightGBM 채점을 거쳤다는 뜻이다. 각본 재생이면 없는 값이다.
    assert.equal(typeof candidate.aiScore, 'number');
    assert.ok((candidate.aiScore as number) > 0.5);
    assert.equal(candidate.tagId, 'tag-101');
    assert.equal(candidate.trigger, 'imu_accel');
    assert.ok((candidate.peakAccel as number) > 2.5, '충격 피크는 감지기가 잰 값이다');
    assert.ok(candidate.zone, '구역 라벨이 붙어야 한다');
    assert.ok(candidate.pos, '삼각측량을 거친 좌표가 붙어야 한다');

    // 측위도 같이 흘렀는가 — live 모드인데 좌표가 나온다면 주입 프레임이 ingest 경로를 탄 것이다.
    const positions = events.filter((e) => e.event === 'position' && e.data.tagId === 'tag-101');
    assert.ok(positions.length > 50, `측위 프레임이 ${positions.length}건뿐이다`);
  } finally {
    server.kill();
  }
});

test('헛경보 클립은 AI가 기각해 경보가 안 나간다', async () => {
  const server = await start([...ANCHOR_ARGS, '--source', 'live']);
  try {
    const stream = collectStream(server.port, () => false, 13000);
    await new Promise((r) => setTimeout(r, 300));
    const started = await (await fetch(
      `http://127.0.0.1:${server.port}/inject-fall?tagId=tag-101&clip=false-alarm`,
    )).json();
    assert.equal(started.ok, true);

    const events = await stream;
    assert.deepEqual(alertsIn(events).map((a) => a.data.type), [], '경보가 나가면 안 된다');
    // 기각은 스트림에 안 나가므로 로그가 유일한 흔적이다. 이게 없으면 감지기가 죽은 것과 구분이 안 된다.
    assert.match(server.output(), /\[fall\] 기각 tag-101 .*낙상 아님으로 판정/);
  } finally {
    server.kill();
  }
});

test('모르는 클립·태그는 400으로 거절한다', async () => {
  const server = await start(ANCHOR_ARGS);
  try {
    const base = `http://127.0.0.1:${server.port}/inject-fall`;
    const badClip = await fetch(`${base}?tagId=tag-101&clip=nope`);
    assert.equal(badClip.status, 400);
    assert.match((await badClip.json()).error, /알 수 없는 클립: nope/);

    const badTag = await fetch(`${base}?tagId=nope&clip=fall-detected`);
    assert.equal(badTag.status, 400);
    assert.match((await badTag.json()).error, /알 수 없는 태그/);
  } finally {
    server.kill();
  }
});
