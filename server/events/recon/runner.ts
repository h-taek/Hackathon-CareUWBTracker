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
  outputPly,
  projectDir,
  reconSteps,
  sparseDir,
  type ReconStep,
  type ReconTuning,
} from './steps.ts';

export interface ReconJob {
  eventId: string;
  attachmentId: string;
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

    const startedAt = now();
    options.attachments.patchRecon(job.eventId, job.attachmentId, {
      status: 'running',
      startedAt,
      error: undefined,
    });
    log(`[recon] 시작 ${job.eventId}/${job.attachmentId} → ${workDir}`);

    const appendLog = (chunk: string) => {
      try {
        fs.appendFileSync(logFile, chunk);
      } catch { /* 로그 못 쓴다고 재구성을 멈추지 않는다 */ }
    };

    const steps = reconSteps({ video, workDir }, tuning);
    for (const [index, step] of steps.entries()) {
      appendLog(`\n=== [${index + 1}/${steps.length}] ${step.name} — ${step.what}\n$ ${step.command} ${step.args.join(' ')}\n`);
      log(`[recon] ${job.attachmentId} ${index + 1}/${steps.length} ${step.name} — ${step.what}`);

      let result: { code: number | null };
      try {
        result = await run(step, workDir, appendLog);
      } catch (error: unknown) {
        return fail(job, step, `실행 실패: ${describe(error)}`, appendLog, startedAt);
      }
      if (result.code !== 0) {
        return fail(job, step, `${step.command} 종료코드 ${result.code}`, appendLog, startedAt);
      }

      // ffmpeg는 프레임을 frames/에 떨구는데 COLMAP은 project/images/를 본다.
      // 복사 대신 심볼릭 링크로 잇는다 — 수백 MB를 두 벌 갖고 있을 이유가 없다.
      if (step.name === 'frames') {
        const count = countFrames(workDir);
        appendLog(`프레임 ${count}장\n`);
        if (count < MIN_FRAMES) {
          return fail(job, step, `프레임이 ${count}장뿐이다(최소 ${MIN_FRAMES}장). 영상이 너무 짧거나 fps가 낮다`, appendLog, startedAt);
        }
        linkImages(workDir);
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
  const keys = ['fps', 'maxFrames', 'frameWidth', 'numIters', 'openSplatBin', 'colmapBin', 'ffmpegBin'] as const;
  const picked: Record<string, unknown> = {};
  for (const key of keys) {
    if (options[key] !== undefined) picked[key] = options[key];
  }
  return picked as Partial<ReconTuning>;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
