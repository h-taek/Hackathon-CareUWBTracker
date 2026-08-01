import * as assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';

import { createEventStore } from '../../server/events/store.ts';
import { createAttachmentStore } from '../../server/events/attachments.ts';
import { createReconRunner, MIN_FRAMES, type RunCommand } from '../../server/events/recon/runner.ts';
import { RECON_DEFAULTS, framesDir, modelDir, outputPly, type ReconStep } from '../../server/events/recon/steps.ts';
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

/** COLMAP 이진 파일 흉내 — 머리 8바이트가 항목 수(uint64 LE)다. */
function writeModel(workDir: string, images: number, points: number): void {
  const dir = modelDir(workDir);
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, count] of [['images.bin', images], ['points3D.bin', points]] as const) {
    const buffer = Buffer.alloc(64);
    buffer.writeBigUInt64LE(BigInt(count), 0);
    fs.writeFileSync(path.join(dir, file), buffer);
  }
}

/** 도구를 부르는 대신 시켰던 일을 흉내내는 실행기. 실제 ffmpeg·COLMAP·OpenSplat이 없어도 흐름을 다 본다. */
function fakeRun(options: {
  frames?: number;
  failAt?: string;
  producePly?: boolean;
  throwAt?: string;
  /** COLMAP이 자세를 푼 장수. 기본은 뽑은 프레임 전부 */
  registered?: number;
  points?: number;
} = {}): { run: RunCommand; calls: string[] } {
  const calls: string[] = [];
  const frameCount = options.frames ?? MIN_FRAMES + 5;
  const run: RunCommand = async (step: ReconStep, workDir, onOutput) => {
    calls.push(step.name);
    onOutput(`${step.name} 실행\n`);
    if (options.throwAt === step.name) throw new Error('실행 파일이 없다');
    if (options.failAt === step.name) return { code: 1 };

    // ffprobe는 길이(초)를 표준출력으로 낸다. 실행기가 이걸 파싱해 추출 간격을 정한다.
    if (step.name === 'probe') { onOutput('60.0\n'); return { code: 0 }; }

    if (step.name === 'frames') {
      fs.mkdirSync(framesDir(workDir), { recursive: true });
      for (let i = 0; i < frameCount; i += 1) {
        fs.writeFileSync(path.join(framesDir(workDir), `f${String(i).padStart(4, '0')}.jpg`), 'jpg');
      }
    }
    if (step.name === 'colmap:map') {
      writeModel(workDir, options.registered ?? frameCount, options.points ?? 5000);
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

  assert.deepEqual(calls, ['probe', 'frames', 'colmap:extract', 'colmap:match', 'colmap:map', 'opensplat']);

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
      if (step.name === 'probe') { return { code: 0 }; }
      seen.push(attachments.get('evt-1', video.attachmentId)?.recon?.status ?? '?');
      if (step.name === 'frames') {
        fs.mkdirSync(framesDir(workDir), { recursive: true });
        for (let i = 0; i < 20; i += 1) fs.writeFileSync(path.join(framesDir(workDir), `f${i}.jpg`), 'x');
      }
      if (step.name === 'colmap:map') writeModel(workDir, 20, 5000);
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

  assert.deepEqual(calls, ['probe', 'frames']);
  const source = attachments.get('evt-1', video.attachmentId)!;
  assert.equal(source.recon?.status, 'failed');
  assert.match(source.recon?.error ?? '', /3장/);
});

test('COLMAP이 자세를 거의 못 풀면 학습을 시작하지 않는다', async () => {
  // 실측(2026-08-01): 178장 중 2장만 등록됐는데 COLMAP이 종료코드 0으로 끝나,
  // OpenSplat이 카메라 2대짜리로 "성공"하고 쓸모없는 .ply가 status=done으로 남았다.
  const { runner, attachments, video, calls } = await setup({ frames: 178, registered: 2, points: 46 });

  runner.enqueue({ eventId: 'evt-1', attachmentId: video.attachmentId });
  await runner.idle();

  assert.equal(calls.includes('opensplat'), false, '못 쓸 모델로 학습을 돌리지 않는다');
  const source = attachments.get('evt-1', video.attachmentId)!;
  assert.equal(source.recon?.status, 'failed');
  assert.match(source.recon?.error ?? '', /자세를 거의 못 풀었다/);
  assert.equal(source.recon?.outputAttachmentId, undefined);
});

test('등록 장수와 점 수가 로그에 남는다', async () => {
  const { runner, store, video } = await setup({ frames: 100, registered: 90, points: 7000 });

  runner.enqueue({ eventId: 'evt-1', attachmentId: video.attachmentId });
  await runner.idle();

  const text = fs.readFileSync(
    path.join(store.eventDir('evt-1'), 'recon', video.attachmentId, 'recon.log'), 'utf8',
  );
  assert.match(text, /등록 90\/100장 · 점 7000개/);
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
      if (step.name === 'colmap:map') writeModel(workDir, 20, 5000);
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

test('실행마다 넘긴 설정이 서버 기본값을 덮고 기록에 남는다', async () => {
  // 같은 영상을 설정만 바꿔 여러 번 돌리므로, 어떤 설정이 어떤 결과를 냈는지가 남아야 한다.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recon-'));
  const store = createEventStore(path.join(root, 'events'));
  const attachments = createAttachmentStore(store);
  store.save(record('evt-1'));
  const video = await attachments.receive('evt-1', { kind: 'video' }, Readable.from([Buffer.from('영상')]));

  const seen: string[] = [];
  const runner = createReconRunner({
    store, attachments, onLog: () => {}, targetFrames: 300, numIters: 2000,
    run: async (step, workDir) => {
      seen.push(step.args.join(' '));
      if (step.name === 'frames') {
        fs.mkdirSync(framesDir(workDir), { recursive: true });
        for (let i = 0; i < 20; i += 1) fs.writeFileSync(path.join(framesDir(workDir), `f${i}.jpg`), 'x');
      }
      if (step.name === 'colmap:map') writeModel(workDir, 20, 5000);
      if (step.name === 'opensplat') fs.writeFileSync(outputPly(workDir), 'ply');
      return { code: 0 };
    },
  });

  runner.enqueue({ eventId: 'evt-1', attachmentId: video.attachmentId, tuning: { targetFrames: 120, numIters: 300 } });
  await runner.idle();

  assert.ok(seen.some((a) => a.includes('-frames:v 120')), '넘긴 장수가 ffmpeg 인자에 들어간다');
  assert.ok(seen.some((a) => a.includes('-n 300')), '넘긴 학습 횟수가 opensplat 인자에 들어간다');
  const recon = attachments.get('evt-1', video.attachmentId)?.recon;
  assert.equal(recon?.tuning?.targetFrames, 120);
  assert.equal(recon?.tuning?.numIters, 300);
  assert.equal(recon?.tuning?.frameWidth, RECON_DEFAULTS.frameWidth, '안 넘긴 값은 서버 기본값이다');
});

test('진행 단계와 지표가 기록에 실린다 — 화면이 이걸로 표시한다', async () => {
  const { runner, attachments, video } = await setup({ frames: 100, registered: 90, points: 7000 });

  runner.enqueue({ eventId: 'evt-1', attachmentId: video.attachmentId });
  await runner.idle();

  const recon = attachments.get('evt-1', video.attachmentId)!.recon!;
  assert.equal(recon.frames, 100);
  assert.equal(recon.registeredImages, 90);
  assert.equal(recon.points, 7000);
  assert.equal(recon.step, 'opensplat', '마지막으로 돌던 단계가 남는다');
});
