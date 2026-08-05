// 서버를 실제로 띄워 실행 인자 배선을 확인한다.
// 단위 테스트는 파서마다 다 통과했는데 정작 server.ts가 둘을 조합하는 지점이 깨져 있었다
// (--source가 앵커 파서에 막혀 서버가 아예 안 떴다). 조합을 보는 테스트가 없어 못 잡았다.

import * as assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server', 'server.ts');

/**
 * 이 테스트가 띄우는 서버는 **자기 데이터 폴더**를 쓴다.
 *
 * 안 그러면 개발 기기의 `server/data/`를 그대로 물어서, (1) 테스트가 남의 명부에 이미
 * 적혀 있던 태그 덕에 통과하고(새 클론·다른 기기에서는 깨진다), (2) `npm test`를 돌릴
 * 때마다 진짜 사고 기록·확인자료에 테스트 이벤트가 쌓인다. 둘 다 실제로 있던 일이다.
 */
function isolatedEnv(): Record<string, string> {
  return { DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'server-test-')) };
}
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
      env: { ...process.env, PORT: '0', FALL_AI: '0', ...isolatedEnv() },
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
      env: { ...process.env, PORT: '0', ...isolatedEnv(), ...env },
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

/**
 * 명부에서 관제사를 하나 골라 세션 쿠키를 얻는다.
 *
 * **기록을 바꾸는 동작은 식별 없이 안 된다**(spec operation 03 §4). 예전에는 확인자료의
 * 행위자가 `'operator'` 고정값이라 이 절차가 없었다.
 */
async function openSession(port: number): Promise<string> {
  const { roster } = await (await fetch(`http://127.0.0.1:${port}/session`)).json();
  assert.ok(roster?.length > 0, '명부가 비어 있으면 아무도 못 들어간다');
  const res = await fetch(`http://127.0.0.1:${port}/session?operatorId=${roster[0].id}`, { method: 'POST' });
  assert.equal((await res.json()).ok, true, '관제사 선택 실패');
  const cookie = res.headers.get('set-cookie');
  assert.ok(cookie, '세션 쿠키가 안 왔다');
  return cookie.split(';')[0];
}

interface AuditLine { kind: string; actor: string; detail: string; tagId?: string }

/** 확인자료를 통째로 읽는다. 날짜별 파일이라 자정을 걸치면 두 개다. */
function readAudit(dataDir: string): AuditLine[] {
  const dir = path.join(dataDir, 'audit');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .flatMap((name) => fs.readFileSync(path.join(dir, name), 'utf8').split('\n'))
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as AuditLine);
}

test('식별 없이는 기록을 바꾸는 동작이 401이다', async () => {
  // **live 모드다.** 시뮬은 배경 태그를 `system`으로 자동 등록해서 명부가 비어 있지 않다.
  const server = await start([...ANCHOR_ARGS, '--source', 'live']);
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const blocked = await fetch(`${base}/tags/register?tagId=tag-101&label=${encodeURIComponent('김OO')}`, {
      method: 'POST',
    });
    assert.equal(blocked.status, 401);
    assert.equal((await blocked.json()).error, 'operator_required');

    // 막혔으면 명부가 그대로여야 한다 — 401을 주면서 등록은 되는 게 제일 나쁘다.
    assert.deepEqual(await (await fetch(`${base}/tags`)).json(), [], '401인데 명부가 바뀌었다');

    // 현장 영상 등록과 재구성 실행도 사건 기록을 바꾸는 조작이다. 게이트가 라우트보다
    // 앞서므로 없는 사건을 대도 401이 먼저 나온다.
    const upload = await fetch(`${base}/incidents/evt-none/attachments?kind=video`, {
      method: 'POST',
      body: 'x',
    });
    assert.equal(upload.status, 401, '영상 등록이 식별 없이 열려 있다');
    const rerun = await fetch(`${base}/incidents/evt-none/attachments/att-1/recon`, { method: 'POST' });
    assert.equal(rerun.status, 401, '재구성 실행이 식별 없이 열려 있다');

    // **조회와 측위는 막지 않는다.** 식별은 조작의 조건이지 감지의 조건이 아니다.
    assert.equal((await fetch(`${base}/tags`)).status, 200);
    assert.equal((await fetch(`${base}/events`)).status, 200);
    const ingest = await fetch(`${base}/ingest`, { method: 'POST', body: '{}' });
    assert.notEqual(ingest.status, 401, '측위 경로에 게이트가 걸리면 낙상을 놓친다');
  } finally {
    server.kill();
  }
});

test('관제사를 고르면 확인자료에 그 ID가 남는다', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-actor-'));
  // live 모드라 명부가 비어서 시작한다 — 확인자료의 `태그 등록`은 우리가 만든 한 줄뿐이다.
  const server = await start([...ANCHOR_ARGS, '--source', 'live'], { DATA_DIR: dataDir });
  try {
    await assignTag(server.port, 'tag-101', '301호 김OO');
    const lines = readAudit(dataDir);

    // 접속기록(개인정보보호법 시행령 제30조①5호)
    const login = lines.find((l) => l.detail.startsWith('관제 화면 접속'));
    assert.ok(login, '접속이 확인자료에 안 남았다');
    assert.match(login.actor, /^op-\d+$/);

    // 그리고 그 사람이 한 일
    const register = lines.find((l) => l.detail.startsWith('태그 등록'));
    assert.ok(register, '태그 등록이 확인자료에 안 남았다');
    assert.equal(register.actor, login.actor, '누가 등록했는지가 접속한 사람과 같아야 한다');
    assert.equal(register.tagId, 'tag-101');
    assert.notEqual(register.actor, 'operator', '고정값이 다시 들어오면 안 된다');
  } finally {
    server.kill();
  }
});

test('명부에서 지우면 그 관제사의 세션이 그 자리에서 끊긴다', async () => {
  const server = await start(ANCHOR_ARGS);
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const { roster } = await (await fetch(`${base}/session`)).json();
    const cookie = await openSession(server.port);
    const me = roster[0].id;

    const removed = await fetch(`${base}/operators/remove?operatorId=${me}`, {
      method: 'POST',
      headers: { cookie },
    });
    assert.equal((await removed.json()).sessionClosed, true);

    // 명부에서 내린 사람이 남은 교대 시간 동안 계속 판정하면 안 된다.
    const after = await fetch(`${base}/tags/release?tagId=tag-101`, { method: 'POST', headers: { cookie } });
    assert.equal(after.status, 401);
    // 다시 고를 수도 없다.
    const relogin = await fetch(`${base}/session?operatorId=${me}`, { method: 'POST' });
    assert.equal(relogin.status, 409);
  } finally {
    server.kill();
  }
});

test('명부 수정은 세션 없이도 되고, 그 사실이 확인자료에 남는다', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-roster-'));
  const server = await start(ANCHOR_ARGS, { DATA_DIR: dataDir });
  try {
    const base = `http://127.0.0.1:${server.port}`;
    // 처음에는 아무도 명부에 없을 수 있다. 식별을 요구하면 누구도 못 들어간다.
    const added = await fetch(`${base}/operators/add?name=${encodeURIComponent('박간호')}`, { method: 'POST' });
    assert.equal(added.status, 200);
    const { operator } = await added.json();
    assert.equal(operator.name, '박간호');

    const line = readAudit(dataDir).find((l) => l.detail.startsWith('관제사 명부 추가'));
    assert.ok(line, '명부 수정이 확인자료에 안 남았다');
    assert.equal(line.actor, 'unidentified', '식별 없이 한 일이라는 사실이 드러나야 한다');

    // 같은 이름은 두 번 안 들어간다 — 드롭다운에서 구분이 안 된다.
    const dup = await fetch(`${base}/operators/add?name=${encodeURIComponent('박간호')}`, { method: 'POST' });
    assert.equal(dup.status, 409);
  } finally {
    server.kill();
  }
});

/**
 * 주입할 태그를 먼저 명부에 올린다. **live 모드 명부는 비어서 시작한다** — 시뮬 배경 태그를
 * 자동 등록하는 건 sim 모드뿐이라, 등록 없이 주입하면 ingest 관문이 프레임을 통째로 버린다
 * (그게 반납=수집 중단의 설계다). 예전엔 개발 기기에 남아 있던 명부 파일 덕에 이 줄 없이도
 * 통과했다.
 */
async function assignTag(port: number, tagId: string, label = '테스트 대상'): Promise<void> {
  const cookie = await openSession(port);
  const res = await fetch(
    `http://127.0.0.1:${port}/tags/register?tagId=${tagId}&label=${encodeURIComponent(label)}`,
    { method: 'POST', headers: { cookie } },
  );
  assert.equal((await res.json()).ok, true, `${tagId} 등록 실패`);
}

test('낙상 클립을 주입하면 감지기가 감지 이벤트를 낸다', async () => {
  const server = await start([...ANCHOR_ARGS, '--source', 'live']);
  try {
    await assignTag(server.port, 'tag-101');
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
    await assignTag(server.port, 'tag-101');
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

// ── 학습 데이터 반출 버튼이 실제 파이프라인을 타는가 ────────────────────────────
// 주입 버튼과 같은 이유로 여기 있다. 버튼이 제 코드를 따로 갖고 있으면 화면에서 도는 것과
// 제품이 도는 것이 달라진다. 서버를 띄우고 눌러서, 나가는 것이 익명화를 거친 표본인지 본다.

/** 받은 본문을 모아 두는 최소 수신 서버. tools/export-sink.ts와 같은 자리를 테스트 안에 둔다. */
function sink(): Promise<{ url: string; bodies: string[]; close: () => void }> {
  const bodies: string[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      bodies.push(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"received":true}\n');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        url: `http://127.0.0.1:${port}/samples`,
        bodies,
        close: () => server.close(),
      });
    });
  });
}

/** 판정이 붙은 감지 이벤트를 이벤트 폴더에 직접 심는다. 화면이 보는 그 목록이 된다. */
function seedEvent(dataDir: string, eventId: string, outcome: string): void {
  const folder = path.join(dataDir, 'events', eventId);
  fs.mkdirSync(folder, { recursive: true });
  const ts = Date.now() - 60_000;
  fs.writeFileSync(path.join(folder, 'record.json'), JSON.stringify({
    eventId,
    tagId: 'tag-101',
    ts,
    alert: {
      eventId, tagId: 'tag-101', ts, type: 'fall_detected',
      peakAccel: 3.8, freefall: true, aiScore: 0.9,
      floor: '2F', zone: '화장실(여)', pos: { x: 3.1, y: 4.2 },
    },
    track: [{ ts, x: 3.1, y: 4.2 }],
    accel: Array.from({ length: 30 }, (_, i) => ({ ts: ts + i * 20, x: 0.1 * i, y: 0.2, z: 9.8 })),
    attachments: [],
    outcome,
    ...(outcome === 'detected' ? {} : { resolvedAt: ts + 1000, resolvedBy: 'op-1' }),
  }), 'utf8');
}

test('반출 버튼은 이벤트 로그를 익명화해 실제 전송 경로로 보낸다', async () => {
  const collector = await sink();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-btn-'));
  seedEvent(dataDir, 'evt-fall', 'confirmed');
  seedEvent(dataDir, 'evt-false', 'false_alarm');
  seedEvent(dataDir, 'evt-none', 'detected'); // 판정이 없어 표본이 될 수 없다

  const server = await start([...ANCHOR_ARGS, '--source', 'live'], {
    DATA_DIR: dataDir,
    EXPORT_URL: collector.url,
    EXPORT_TOKEN: 'facility-secret',
  });
  try {
    const base = `http://127.0.0.1:${server.port}`;

    // 데이터를 시설 밖으로 내보내는 동작이다. 누가 눌렀는지가 남아야 한다.
    assert.equal((await fetch(`${base}/export/run`, { method: 'POST' })).status, 401);

    const cookie = await openSession(server.port);
    const body = await (await fetch(`${base}/export/run`, { method: 'POST', headers: { cookie } })).json();
    assert.equal(body.ok, true);
    assert.equal(body.queued, 2, '판정된 둘만 나가야 한다');
    assert.equal(body.skipped, 1);
    assert.equal(body.pending, 0, '전송까지 끝나야 한다');

    assert.equal(collector.bodies.length, 1);
    const lines = collector.bodies[0].trim().split('\n');
    assert.equal(lines.length, 2);
    assert.deepEqual(lines.map((l) => JSON.parse(l).label).sort(), [0, 1]);

    // **버튼을 거쳐도 익명화는 같은 코드다.** 여기가 무너지면 화면에서만 안전해 보인다.
    for (const leak of ['tag-101', 'evt-fall', 'evt-false', '화장실', '2F', 'pos', 'track', 'op-1']) {
      assert.ok(!collector.bodies[0].includes(leak), `반출물에 ${leak}가 남아 있다`);
    }
    assert.ok(!collector.bodies[0].includes('facility-secret'), '토큰이 본문에 새면 안 된다');

    // 이벤트는 그대로 남는다 — 반출은 파기가 아니다.
    const { events } = await (await fetch(`${base}/events`)).json();
    assert.equal(events.length, 3, '반출이 기록을 지우면 안 된다');

    const trace = readAudit(dataDir).filter((l) => l.detail.includes('학습 표본 수동 반출'));
    assert.equal(trace.length, 1);
    assert.match(trace[0].actor, /^op-/);
  } finally {
    server.kill();
    collector.close();
  }
});
