// 반출 전송 검사(spec system 03 §7.4).

import * as assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createExporter } from '../../server/events/export/sender.ts';
import { createExportQueue } from '../../server/events/export/queue.ts';
import type { EventRecord } from '../../server/events/recorder.ts';

const T0 = Date.parse('2026-08-05T09:00:00Z');

interface Call { url: string; headers: Record<string, string>; body: string }

function bench(overrides: Record<string, unknown> = {}, replies: number[] = [200]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sender-'));
  const queue = createExportQueue(root);
  const calls: Call[] = [];
  let at = T0;
  let reply = 0;

  const exporter = createExporter({
    queue,
    url: 'https://collector.example/samples',
    token: 'secret-token',
    now: () => at,
    onLog: () => {},
    fetch: (async (url: string, init: Record<string, unknown>) => {
      calls.push({
        url: String(url),
        headers: init.headers as Record<string, string>,
        body: String(init.body),
      });
      const status = replies[Math.min(reply++, replies.length - 1)];
      return { ok: status >= 200 && status < 300, status } as Response;
    }) as unknown as typeof globalThis.fetch,
    ...overrides,
  });

  return { queue, exporter, calls, advance: (ms: number) => { at += ms; }, root };
}

function record(fields: Partial<EventRecord> = {}): EventRecord {
  return {
    eventId: 'evt-1',
    tagId: 'tag-101',
    ts: T0,
    alert: { tagId: 'tag-101', peakAccel: 3.8, zone: '화장실(여)' },
    track: [{ ts: T0, x: 1, y: 2 }],
    accel: Array.from({ length: 20 }, (_, i) => ({ ts: T0 + i * 20, x: 0, y: 0, z: 9.8 })),
    attachments: [],
    outcome: 'confirmed',
    resolvedAt: T0,
    ...fields,
  };
}

test('2xx면 배치가 sent로 넘어가고 누계가 는다', async () => {
  const { exporter, queue, calls } = bench();
  exporter.collect(record());
  await exporter.flush();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://collector.example/samples');
  assert.deepEqual(queue.batches(), []);
  assert.equal(queue.state().totalSent, 1);
  assert.equal(queue.state().failures, 0);
});

test('인증은 헤더로 가고 본문에는 시설을 가리키는 값이 없다', async () => {
  const { exporter, calls } = bench();
  exporter.collect(record());
  await exporter.flush();

  assert.equal(calls[0].headers.Authorization, 'Bearer secret-token');
  assert.equal(calls[0].headers['Content-Type'], 'application/x-ndjson');
  assert.ok(!calls[0].body.includes('secret-token'), '토큰이 본문에 새면 안 된다');
  assert.ok(!calls[0].body.includes('tag-101'));
  assert.ok(!calls[0].body.includes('화장실'));
});

test('실패하면 배치를 붙잡고 백오프가 커진다', async () => {
  const { exporter, queue, calls, advance } = bench({ backoffBaseMs: 60_000 }, [500]);
  exporter.collect(record());

  await exporter.flush();
  assert.equal(queue.batches().length, 1, '실패한 배치는 pending에 남는다');
  assert.equal(queue.state().failures, 1);
  assert.equal(queue.state().nextAttemptAt, T0 + 60_000);

  await exporter.flush();
  assert.equal(calls.length, 1, '백오프 중에는 안 건다');

  advance(60_001);
  await exporter.flush();
  assert.equal(calls.length, 2);
  assert.equal(queue.state().failures, 2);
  assert.equal(queue.state().nextAttemptAt, T0 + 60_001 + 120_000, '두 배가 된다');
});

test('백오프는 상한에서 멈춘다', async () => {
  const { exporter, queue, advance } = bench({ backoffBaseMs: 60_000, backoffMaxMs: 300_000 }, [500]);
  exporter.collect(record());

  let at = T0;
  for (const expected of [60_000, 120_000, 240_000, 300_000, 300_000]) {
    await exporter.flush();
    assert.equal(queue.state().nextAttemptAt! - at, expected);
    advance(expected + 1);
    at += expected + 1;
  }
});

test('4xx도 버리지 않는다 — 토큰이 틀린 것뿐일 수 있다', async () => {
  const { exporter, queue } = bench({}, [401]);
  exporter.collect(record());
  await exporter.flush();

  assert.equal(queue.batches().length, 1);
  assert.equal(queue.state().lastError, 'HTTP 401');
});

test('URL이 없으면 전송하지 않고 큐만 쌓는다', async () => {
  const { exporter, queue, calls } = bench({ url: '' });
  exporter.collect(record());
  await exporter.flush();

  assert.equal(calls.length, 0);
  assert.equal(queue.batches().length, 1);
});

test('판정 없는 레코드는 큐에 안 들어가고 건수만 센다', () => {
  const { exporter, queue } = bench();
  exporter.collect(record({ outcome: 'detected' }));

  assert.deepEqual(queue.batches(), []);
  assert.equal(queue.state().skippedUnjudged, 1);
  assert.equal(queue.state().totalQueued, 0);
});

test('큐를 못 써도 collect는 던지지 않는다 — 파기를 막으면 안 된다', () => {
  const { exporter, root } = bench();
  // 큐 폴더 자리에 파일을 둬서 mkdir을 막는다.
  fs.rmSync(root, { recursive: true, force: true });
  fs.writeFileSync(root, 'not a directory', 'utf8');

  assert.doesNotThrow(() => exporter.collect(record()));
});

test('기동하면 지난 실행에서 못 보낸 배치가 나간다', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sender-boot-'));
  const queue = createExportQueue(root);
  // 지난 실행이 남긴 자리를 그대로 만든다 — 401로 막혔고 백오프도 지났다.
  queue.append({ dt: [0, 20], ax: [0, 0], ay: [0, 0], az: [9.8, 9.9], label: 1 }, T0);
  queue.saveState({ ...queue.state(), failures: 1, lastError: 'HTTP 401', nextAttemptAt: T0 - 1 });

  const calls: string[] = [];
  const exporter = createExporter({
    queue,
    url: 'https://collector.example/samples',
    now: () => T0,
    onLog: () => {},
    fetch: (async () => {
      calls.push('sent');
      return { ok: true, status: 200 } as Response;
    }) as unknown as typeof globalThis.fetch,
  });

  // **파기가 한 건도 안 돌아도 나가야 한다.** 뽑을 것이 있을 때만 큐를 비우면
  // 수집 서버가 죽었다 살아나도 다음 파기까지 밀린 배치가 앉아 있다.
  exporter.start();
  await new Promise((resolve) => setImmediate(resolve));
  exporter.stop();

  assert.deepEqual(calls, ['sent']);
  assert.deepEqual(queue.batches(), []);
});

test('URL이 없으면 기동해도 타이머를 안 건다', () => {
  const { exporter, calls } = bench({ url: '' });
  exporter.start();
  exporter.stop();
  assert.equal(calls.length, 0);
});

test('전송이 던져도 큐는 그대로 남는다', async () => {
  const { exporter, queue } = bench({
    fetch: (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof globalThis.fetch,
  });
  exporter.collect(record());
  await exporter.flush();

  assert.equal(queue.batches().length, 1);
  assert.equal(queue.state().lastError, 'ECONNREFUSED');
});
