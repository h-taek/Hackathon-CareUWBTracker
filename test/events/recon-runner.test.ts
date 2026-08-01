import * as assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';

import { createEventStore } from '../../server/events/store.ts';
import { createAttachmentStore } from '../../server/events/attachments.ts';
import { createReconRunner, MIN_FRAMES, type RunCommand } from '../../server/events/recon/runner.ts';
import { framesDir, outputPly, type ReconStep } from '../../server/events/recon/steps.ts';
import type { EventRecord } from '../../server/events/recorder.ts';

function record(eventId: string): EventRecord {
  return {
    eventId,
    tagId: 'tag-a',
    ts: 5000,
    alert: { eventId, type: 'fall_detected', ts: 5000 },
    track: [],
    accel: [],
    attachments: [],
  };
}

/** 도구를 부르는 대신 시켰던 일을 흉내내는 실행기. 실제 ffmpeg·COLMAP·OpenSplat이 없어도 흐름을 다 본다. */
function fakeRun(options: {
  frames?: number;
  failAt?: string;
  producePly?: boolean;
  throwAt?: string;
} = {}): { run: RunCommand; calls: string[] } {
  const calls: string[] = [];
  const run: RunCommand = async (step: ReconStep, workDir, onOutput) => {
    calls.push(step.name);
    onOutput(`${step.name} 실행\n`);
    if (options.throwAt === step.name) throw new Error('실행 파일이 없다');
    if (options.failAt === step.name) return { code: 1 };

    if (step.name === 'frames') {
      const count = options.frames ?? MIN_FRAMES + 5;
      fs.mkdirSync(framesDir(workDir), { recursive: true });
      for (let i = 0; i < count; i += 1) {
        fs.writeFileSync(path.join(framesDir(workDir), `f${String(i).padStart(4, '0')}.jpg`), 'jpg');
      }
    }
    if (step.name === 'opensplat' && options.producePly !== false) {
      fs.writeFileSync(outputPly(workDir), 'ply본문');
    }
    return { code: 0 };
  };
  return { run, calls };
}

async function setup(runOptions: Parameters<typeof fakeRun>[0] = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-'));
  const store = createEventStore(path.join(root, 'events'));
  const attachments = createAttachmentStore(store);
  store.save(record('evt-1'));
  const video = await attachments.receive('evt-1', { kind: 'video' }, Readable.from([Buffer.from('영상')]));

  const logs: string[] = [];
  const { run, calls } = fakeRun(runOptions);
  const runner = createReconRunner({ store, attachments, run, onLog: (line) => logs.push(line) });
  return { store, attachments, runner, video, calls, logs, root };
}

test('업로드된 영상을 재구성해 .ply를 첨부로 붙인다', async () => {
  const { runner, attachments, video, calls } = await setup();

  runner.enqueue({ eventId: 'evt-1', attachmentId: video.attachmentId });
  await runner.idle();

  assert.deepEqual(calls, ['frames', 'colmap:extract', 'colmap:match', 'colmap:map', 'opensplat']);

  const source = attachments.get('evt-1', video.attachmentId)!;
  assert.equal(source.recon?.status, 'done');
  assert.ok(source.recon?.outputAttachmentId);
  assert.ok(source.recon?.finishedAt);

  const output = attachments.get('evt-1', source.recon!.outputAttachmentId!)!;
  assert.equal(output.kind, 'splat');
  assert.equal(output.sourceAttachmentId, video.attachmentId);
  assert.equal(fs.existsSync(attachments.absolutePathOf(output)), true);
});

test('돌기 시작하면 running으로 바뀐다', async () => {
  const { store, attachments, video } = await setup();
  const seen: string[] = [];
  const runner = createReconRunner({
    store,
    attachments,
    onLog: () => {},
    run: async (step, workDir) => {
      seen.push(attachments.get('evt-1', video.attachmentId)?.recon?.status ?? '?');
      if (step.name === 'frames') {
        fs.mkdirSync(framesDir(workDir), { recursive: true });
        for (let i = 0; i < 20; i += 1) fs.writeFileSync(path.join(framesDir(workDir), `f${i}.jpg`), 'x');
      }
      if (step.name === 'opensplat') fs.writeFileSync(outputPly(workDir), 'ply');
      return { code: 0 };
    },
  });

  runner.enqueue({ eventId: 'evt-1', attachmentId: video.attachmentId });
  await runner.idle();

  assert.deepEqual(seen, ['running', 'running', 'running', 'running', 'running']);
});

test('단계가 실패하면 failed로 남고 어디서 막혔는지 적힌다', async () => {
  const { runner, attachments, video, calls } = await setup({ failAt: 'colmap:map' });

  runner.enqueue({ eventId: 'evt-1', attachmentId: video.attachmentId });
  await runner.idle();

  const source = attachments.get('evt-1', video.attachmentId)!;
  assert.equal(source.recon?.status, 'failed');
  assert.match(source.recon?.error ?? '', /colmap:map/);
  assert.equal(calls.includes('opensplat'), false, '실패하면 뒷 단계는 안 돈다');
});

test('도구가 아예 없으면 실패로 남고 서버는 안 죽는다', async () => {
  const { runner, attachments, video } = await setup({ throwAt: 'frames' });

  runner.enqueue({ eventId: 'evt-1', attachmentId: video.attachmentId });
  await runner.idle();

  const source = attachments.get('evt-1', video.attachmentId)!;
  assert.equal(source.recon?.status, 'failed');
  assert.match(source.recon?.error ?? '', /실행 파일이 없다/);
});

test('프레임이 너무 적으면 COLMAP을 돌리기 전에 끊는다', async () => {
  // 어차피 못 푼다. 미리 끊어 30분을 아낀다.
  const { runner, attachments, video, calls } = await setup({ frames: 3 });

  runner.enqueue({ eventId: 'evt-1', attachmentId: video.attachmentId });
  await runner.idle();

  assert.deepEqual(calls, ['frames']);
  const source = attachments.get('evt-1', video.attachmentId)!;
  assert.equal(source.recon?.status, 'failed');
  assert.match(source.recon?.error ?? '', /3장/);
});

test('opensplat이 0으로 끝났는데 .ply가 없으면 성공으로 치지 않는다', async () => {
  const { runner, attachments, video } = await setup({ producePly: false });

  runner.enqueue({ eventId: 'evt-1', attachmentId: video.attachmentId });
  await runner.idle();

  const source = attachments.get('evt-1', video.attachmentId)!;
  assert.equal(source.recon?.status, 'failed');
  assert.match(source.recon?.error ?? '', /\.ply가 없다/);
});

test('로그가 작업 폴더에 남는다', async () => {
  const { runner, store, video } = await setup({ failAt: 'colmap:match' });

  runner.enqueue({ eventId: 'evt-1', attachmentId: video.attachmentId });
  await runner.idle();

  const logFile = path.join(store.eventDir('evt-1'), 'recon', video.attachmentId, 'recon.log');
  const text = fs.readFileSync(logFile, 'utf8');
  assert.match(text, /colmap:match/);
  assert.match(text, /실패/);
  assert.match(text, /\$ /, '실행한 명령줄이 그대로 남는다');
});

test('같은 첨부를 두 번 넣어도 한 번만 돈다', async () => {
  const { runner, video, calls } = await setup();

  assert.equal(runner.enqueue({ eventId: 'evt-1', attachmentId: video.attachmentId }), true);
  assert.equal(runner.enqueue({ eventId: 'evt-1', attachmentId: video.attachmentId }), false);
  await runner.idle();

  assert.equal(calls.filter((c) => c === 'opensplat').length, 1);
});

test('여러 건은 한 번에 하나씩만 돈다', async () => {
  // 3DGS 학습이 GPU를 통째로 쓴다. 겹치면 둘 다 느려지고 메모리가 터진다.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-'));
  const store = createEventStore(path.join(root, 'events'));
  const attachments = createAttachmentStore(store);
  store.save(record('evt-1'));
  store.save(record('evt-2'));
  const a = await attachments.receive('evt-1', { kind: 'video' }, Readable.from([Buffer.from('1')]));
  const b = await attachments.receive('evt-2', { kind: 'video' }, Readable.from([Buffer.from('2')]));

  let concurrent = 0;
  let peak = 0;
  const runner = createReconRunner({
    store,
    attachments,
    onLog: () => {},
    run: async (step, workDir) => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 1));
      if (step.name === 'frames') {
        fs.mkdirSync(framesDir(workDir), { recursive: true });
        for (let i = 0; i < 20; i += 1) fs.writeFileSync(path.join(framesDir(workDir), `f${i}.jpg`), 'x');
      }
      if (step.name === 'opensplat') fs.writeFileSync(outputPly(workDir), 'ply');
      concurrent -= 1;
      return { code: 0 };
    },
  });

  runner.enqueue({ eventId: 'evt-1', attachmentId: a.attachmentId });
  runner.enqueue({ eventId: 'evt-2', attachmentId: b.attachmentId });
  assert.equal(runner.size(), 2);
  await runner.idle();

  assert.equal(peak, 1, '동시에 두 건이 돌았다');
  assert.equal(attachments.get('evt-1', a.attachmentId)?.recon?.status, 'done');
  assert.equal(attachments.get('evt-2', b.attachmentId)?.recon?.status, 'done');
});

test('다시 걸면 앞선 시도의 작업 폴더를 지우고 새로 판다', async () => {
  // 안 지우면 COLMAP이 옛 database.db를 이어받아 엉뚱한 결과를 낸다.
  const { runner, store, video } = await setup({ failAt: 'colmap:map' });
  const workDir = path.join(store.eventDir('evt-1'), 'recon', video.attachmentId);

  runner.enqueue({ eventId: 'evt-1', attachmentId: video.attachmentId });
  await runner.idle();
  fs.writeFileSync(path.join(workDir, 'database.db'), '옛 데이터');

  runner.enqueue({ eventId: 'evt-1', attachmentId: video.attachmentId });
  await runner.idle();

  assert.equal(fs.existsSync(path.join(workDir, 'database.db')), false);
});

test('없는 첨부를 넣으면 조용히 건너뛴다', async () => {
  const { runner, logs } = await setup();

  runner.enqueue({ eventId: 'evt-1', attachmentId: 'att-없음' });
  await runner.idle();

  assert.ok(logs.some((line) => line.includes('없는 첨부')));
});

test('큐가 비면 current는 null이다', async () => {
  const { runner, video } = await setup();
  assert.equal(runner.current(), null);

  runner.enqueue({ eventId: 'evt-1', attachmentId: video.attachmentId });
  await runner.idle();
  assert.equal(runner.current(), null);
  assert.equal(runner.size(), 0);
});
