// 재구성 실행기(R-3·R-4). steps.ts가 만든 명령을 순서대로 돌리고 결과를 이벤트에 붙인다.
//
// 한 번에 한 건만 돌린다. 3DGS 학습은 GPU를 통째로 쓰므로 두 건이 겹치면 둘 다 느려지고
// 메모리가 터진다. 나머지는 큐에서 기다린다.
//
// 서버 요청-응답 밖에서 돈다. 업로드 응답은 즉시 나가고, 진행은 `recon.status`로만 보인다
// (spec 03 §6.2). 재구성이 30분이 걸리든 2시간이 걸리든 관제는 영향을 받지 않는다.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

import type { Attachment, AttachmentStore } from '../attachments.ts';
import type { EventStore } from '../store.ts';
import {
  RECON_DEFAULTS,
  framesDir,
  modelDir,
  outputPly,
  projectDir,
  parseDuration,
  probeStep,
  reconSteps,
  sparseDir,
  type ReconStep,
  type ReconTuning,
} from './steps.ts';
import { judgeModel, pickBestModel, promoteModel, readModelStats } from './model.ts';
import { parseProgress, type StepProgress } from './progress.ts';

export interface ReconJob {
  eventId: string;
  attachmentId: string;
  /** 이 실행에만 쓸 설정. 서버 기본값 위에 덮인다. 화면이 실행마다 넘긴다. */
  tuning?: Partial<ReconTuning>;
}

export interface ReconRunnerOptions extends Partial<ReconTuning> {
  store: EventStore;
  attachments: AttachmentStore;
  /** 명령 실행. 테스트가 여기를 갈아끼워 도구 없이 흐름을 검증한다. */
  run?: RunCommand;
  now?: () => number;
  onLog?: (line: string) => void;
}

export type RunCommand = (
  step: ReconStep,
  workDir: string,
  onOutput: (chunk: string) => void,
) => Promise<{ code: number | null }>;

export interface ReconRunner {
  /** 큐에 넣는다. 이미 대기·진행 중이면 false. */
  enqueue(job: ReconJob): boolean;
  /** 현재 큐 길이(진행 중인 1건 포함) */
  size(): number;
  /** 진행 중인 작업. 없으면 null */
  current(): ReconJob | null;
  /** 큐가 빌 때까지 기다린다(테스트·종료용) */
  idle(): Promise<void>;
}

export function createReconRunner(options: ReconRunnerOptions): ReconRunner {
  const tuning: ReconTuning = { ...RECON_DEFAULTS, ...stripUndefined(options) };
  const run = options.run ?? spawnCommand;
  const now = options.now ?? Date.now;
  const log = options.onLog ?? ((line: string) => console.log(line));

  const queue: ReconJob[] = [];
  let active: ReconJob | null = null;
  let draining: Promise<void> | null = null;

  function enqueue(job: ReconJob): boolean {
    const known = (entry: ReconJob) =>
      entry.eventId === job.eventId && entry.attachmentId === job.attachmentId;
    if (active && known(active)) return false;
    if (queue.some(known)) return false;

    queue.push(job);
    log(`[recon] 대기열 추가 ${job.eventId}/${job.attachmentId} (대기 ${queue.length}건)`);
    if (!draining) draining = drain().finally(() => { draining = null; });
    return true;
  }

  async function drain(): Promise<void> {
    while (queue.length > 0) {
      active = queue.shift()!;
      try {
        await runOne(active);
      } catch (error: unknown) {
        // runOne이 이미 실패를 레코드에 남긴다. 여기까지 온 건 그것마저 실패한 경우다.
        log(`[recon] ⚠ ${active.eventId}/${active.attachmentId} 처리 중 예외: ${describe(error)}`);
      }
      active = null;
    }
  }

  async function runOne(job: ReconJob): Promise<void> {
    const attachment = options.attachments.get(job.eventId, job.attachmentId);
    if (!attachment) {
      log(`[recon] ⚠ 없는 첨부 ${job.eventId}/${job.attachmentId} — 건너뛴다`);
      return;
    }

    const video = options.attachments.absolutePathOf(attachment);
    const workDir = path.join(options.store.eventDir(job.eventId), 'recon', job.attachmentId);
    const logFile = path.join(workDir, 'recon.log');

    // 이전 시도의 찌꺼기가 남아 있으면 COLMAP이 옛 database.db를 그대로 이어받아
    // 엉뚱한 결과를 낸다. 작업 폴더는 매번 새로 판다.
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.mkdirSync(framesDir(workDir), { recursive: true });
    fs.mkdirSync(sparseDir(projectDir(workDir)), { recursive: true });

    // 서버 기본값 위에 이번 실행 설정을 덮는다.
    const jobTuning: ReconTuning = { ...tuning, ...(job.tuning ?? {}) };

    const startedAt = now();
    options.attachments.patchRecon(job.eventId, job.attachmentId, {
      status: 'running',
      startedAt,
      // 다시 걸 때 앞선 시도의 결과가 남아 있으면 화면이 헷갈린다. 전부 지우고 시작한다.
      error: undefined,
      finishedAt: undefined,
      outputAttachmentId: undefined,
      registeredImages: undefined,
      points: undefined,
      frames: undefined,
      step: 'frames',
      stepIndex: 1,
      stepCount: 5,
      progress: undefined,
      tuning: {
        targetFrames: jobTuning.targetFrames,
        frameWidth: jobTuning.frameWidth,
        numIters: jobTuning.numIters,
        useGpu: jobTuning.useGpu,
      },
    });
    log(`[recon] 시작 ${job.eventId}/${job.attachmentId} → ${workDir}`);
    log(`[recon] ${job.attachmentId} 설정 ${jobTuning.targetFrames}장`
      + ` · 가로 ${jobTuning.frameWidth > 0 ? `${jobTuning.frameWidth}px` : '원본'}`
      + ` · 학습 ${jobTuning.numIters}회 · COLMAP ${jobTuning.useGpu ? 'GPU' : 'CPU'}`);

    const appendLog = (chunk: string) => {
      try {
        fs.appendFileSync(logFile, chunk);
      } catch { /* 로그 못 쓴다고 재구성을 멈추지 않는다 */ }
    };

    // 프레임을 영상 전체에 고르게 펴려면 길이를 먼저 알아야 한다.
    // 실패해도 멈추지 않는다 — 폴백 fps로 뽑고 그 사실을 로그에 남긴다.
    const probe = probeStep({ video, workDir }, jobTuning);
    let durationSec: number | null = null;
    appendLog(`\n=== [0/5] ${probe.name} — ${probe.what}\n$ ${probe.command} ${probe.args.join(' ')}\n`);
    try {
      let probed = '';
      const result = await run(probe, workDir, (chunk) => { probed += chunk; appendLog(chunk); });
      if (result.code === 0) durationSec = parseDuration(probed);
    } catch { /* ffprobe가 없어도 재구성 자체는 돌아야 한다 */ }
    appendLog(durationSec ? `영상 길이 ${durationSec.toFixed(1)}초\n` : '길이를 못 쟀다 — 폴백 간격으로 뽑는다\n');

    const steps = reconSteps({ video, workDir }, jobTuning, durationSec);
    let frameCount = 0;
    for (const [index, step] of steps.entries()) {
      appendLog(`\n=== [${index + 1}/${steps.length}] ${step.name} — ${step.what}\n$ ${step.command} ${step.args.join(' ')}\n`);
      log(`[recon] ${job.attachmentId} ${index + 1}/${steps.length} ${step.name} — ${step.what}`);
      options.attachments.patchRecon(job.eventId, job.attachmentId, {
        step: step.name,
        stepIndex: index + 1,
        stepCount: steps.length,
        progress: undefined,
      });

      // 도구가 진행을 찍는 대로 레코드에 반영하되, 초당 한 번으로 묶는다.
      // OpenSplat은 30000회면 3000줄을 뱉는데 그때마다 record.json을 쓰면 디스크만 간다.
      let lastWriteAt = 0;
      let pending: StepProgress | null = null;
      const onOutput = (chunk: string) => {
        appendLog(chunk);
        const parsed = parseProgress(step.name, chunk, {
          targetFrames: jobTuning.targetFrames,
          frameCount,
          numIters: jobTuning.numIters,
        });
        if (!parsed) return;
        pending = parsed;
        const at = now();
        if (at - lastWriteAt < PROGRESS_WRITE_INTERVAL_MS) return;
        lastWriteAt = at;
        options.attachments.patchRecon(job.eventId, job.attachmentId, { progress: pending });
      };

      let result: { code: number | null };
      try {
        result = await run(step, workDir, onOutput);
        // 마지막 값은 간격에 걸려 빠질 수 있다. 끝난 뒤 한 번 더 쓴다.
        if (pending) options.attachments.patchRecon(job.eventId, job.attachmentId, { progress: pending });
      } catch (error: unknown) {
        return fail(job, step, `실행 실패: ${describe(error)}`, appendLog, startedAt);
      }
      if (result.code !== 0) {
        return fail(job, step, `${step.command} 종료코드 ${result.code}`, appendLog, startedAt);
      }

      // ffmpeg는 프레임을 frames/에 떨구는데 COLMAP은 project/images/를 본다.
      // 복사 대신 심볼릭 링크로 잇는다 — 수백 MB를 두 벌 갖고 있을 이유가 없다.
      if (step.name === 'frames') {
        frameCount = countFrames(workDir);
        appendLog(`프레임 ${frameCount}장\n`);
        options.attachments.patchRecon(job.eventId, job.attachmentId, { frames: frameCount });
        if (frameCount < MIN_FRAMES) {
          return fail(job, step, `프레임이 ${frameCount}장뿐이다(최소 ${MIN_FRAMES}장). 영상이 너무 짧거나 fps가 낮다`, appendLog, startedAt);
        }
        linkImages(workDir);
      }

      // COLMAP은 자세를 거의 못 풀어도 종료코드 0으로 끝난다. 여기서 안 막으면
      // 카메라 2대짜리 모델로 학습이 "성공"하고 쓸모없는 .ply가 나온다.
      if (step.name === 'colmap:map') {
        // COLMAP은 자세가 한 덩어리로 안 풀리면 서브모델을 여러 개 만들고 **완성 순서로**
        // 번호를 매긴다. `0`이 제일 큰 모델이라는 보장이 없다 — 제일 큰 것을 골라 0으로 올린다.
        const sparse = sparseDir(projectDir(workDir));
        const choice = pickBestModel(sparse);
        if (choice.candidates.length > 1) {
          const seen = choice.candidates.map((c) => `${c.name}:${c.registeredImages}장`).join(' ');
          appendLog(`서브모델 ${choice.candidates.length}개(${seen}) → ${choice.name} 채택\n`);
        }
        if (choice.name) promoteModel(sparse, choice.name);

        const verdict = judgeModel(readModelStats(modelDir(workDir)), frameCount);
        appendLog(`등록 ${verdict.registeredImages}/${frameCount}장 · 점 ${verdict.points}개\n`);
        options.attachments.patchRecon(job.eventId, job.attachmentId, {
          registeredImages: verdict.registeredImages,
          points: verdict.points,
        });
        if (!verdict.ok) return fail(job, step, verdict.reason, appendLog, startedAt);
        log(`[recon] ${job.attachmentId} 자세 ${verdict.registeredImages}/${frameCount}장 · 점 ${verdict.points}개`);
      }
    }

    const ply = outputPly(workDir);
    if (!fs.existsSync(ply)) {
      return fail(
        job,
        steps[steps.length - 1],
        'opensplat이 0으로 끝났는데 .ply가 없다',
        appendLog,
        startedAt,
      );
    }

    // 산출물을 이벤트 폴더로 올려 첨부로 등록한다. 작업 폴더는 로그·중간물 보관용으로 남긴다.
    const output: Attachment = options.attachments.attachLocalFile(
      job.eventId,
      { kind: 'splat', originalName: 'scene.ply', sourceAttachmentId: job.attachmentId },
      ply,
    );
    options.attachments.patchRecon(job.eventId, job.attachmentId, {
      status: 'done',
      finishedAt: now(),
      outputAttachmentId: output.attachmentId,
      error: undefined,
    });

    const elapsed = Math.round((now() - startedAt) / 1000);
    appendLog(`\n완료 — ${output.attachmentId} (${elapsed}초)\n`);
    log(`[recon] ✅ 완료 ${job.eventId}/${job.attachmentId} → ${output.attachmentId} (${elapsed}초, ${Math.round(output.bytes / 1024)}KB)`);
  }

  function fail(
    job: ReconJob,
    step: ReconStep,
    message: string,
    appendLog: (chunk: string) => void,
    startedAt: number,
  ): void {
    const error = `${step.name}: ${message}`;
    appendLog(`\n실패 — ${error}\n`);
    options.attachments.patchRecon(job.eventId, job.attachmentId, {
      status: 'failed',
      finishedAt: now(),
      error,
    });
    const elapsed = Math.round((now() - startedAt) / 1000);
    log(`[recon] ⚠ 실패 ${job.eventId}/${job.attachmentId} — ${error} (${elapsed}초). 전문은 recon/${job.attachmentId}/recon.log`);
  }

  async function idle(): Promise<void> {
    while (draining) await draining;
  }

  return { enqueue, size: () => queue.length + (active ? 1 : 0), current: () => active, idle };
}

/** 이만큼도 안 나오면 COLMAP이 어차피 못 푼다. 미리 끊어 30분을 아낀다. */
export const MIN_FRAMES = 10;

/** 진행을 레코드에 쓰는 최소 간격(ms). 화면 폴링이 3초라 1초면 충분하다. */
export const PROGRESS_WRITE_INTERVAL_MS = 1000;

function countFrames(workDir: string): number {
  try {
    return fs.readdirSync(framesDir(workDir)).filter((n) => n.endsWith('.jpg')).length;
  } catch {
    return 0;
  }
}

/** frames/ → project/images/ 를 링크로 잇는다. 이미 있으면 그대로 둔다. */
function linkImages(workDir: string): void {
  const target = path.join(projectDir(workDir), 'images');
  if (fs.existsSync(target)) return;
  fs.symlinkSync(framesDir(workDir), target);
}

function spawnCommand(
  step: ReconStep,
  workDir: string,
  onOutput: (chunk: string) => void,
): Promise<{ code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(step.command, step.args, { cwd: workDir, stdio: ['ignore', 'pipe', 'pipe'] });
    const collect = (chunk: Buffer) => onOutput(chunk.toString());
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', reject); // 도구가 아예 없을 때 여기로 온다
    child.on('close', (code) => resolve({ code }));
  });
}

function stripUndefined(options: ReconRunnerOptions): Partial<ReconTuning> {
  const keys = [
    'targetFrames', 'frameWidth', 'numIters', 'useGpu',
    'openSplatBin', 'colmapBin', 'ffmpegBin', 'ffprobeBin',
  ] as const;
  const picked: Record<string, unknown> = {};
  for (const key of keys) {
    if (options[key] !== undefined) picked[key] = options[key];
  }
  return picked as Partial<ReconTuning>;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
