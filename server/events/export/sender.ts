// 반출 전송(spec system 03 §7.2·§7.4).
//
// 파기가 이벤트를 지우기 직전에 `collect`를 부르고, 한 바퀴가 끝나면 `flushSoon`을 부른다.
// 이 파일이 쥐는 것은 둘이다 — **무엇을 큐에 넣을지**와 **언제 다시 걸지**.
//
// 두 가지를 여기서 못 박는다.
//
//  1) **인증은 헤더에, 반출물은 본문에.** 받는 서버가 아무나 못 보내게 하려면 시설을
//     인증해야 하는데 토큰이 곧 시설 식별자다(legal §9.4 표). 헤더에 두면 전송 계층에서만
//     쓰이고, 학습셋으로 저장되는 본문에는 시설을 가리키는 값이 남지 않는다.
//  2) **반출이 실패해도 파기는 진행한다.** collect는 던지지 않는다 — 여기서 예외가 새면
//     전송 장애가 법정 파기 의무(개인정보보호법 제21조①)를 막는다.

import * as fs from 'node:fs';

import type { EventRecord } from '../recorder.ts';
import { toSample } from './sample.ts';
import { createExportQueue, type ExportQueue, type ExportState } from './queue.ts';

export interface SenderConfig {
  /** 없으면 전송하지 않고 큐만 쌓는다. **기본이 off다.** */
  url: string;
  token: string;
  /** 첫 재시도까지의 간격. 실패마다 두 배가 된다. */
  backoffBaseMs: number;
  backoffMaxMs: number;
  requestTimeoutMs: number;
  /**
   * 큐를 들여다보는 주기.
   *
   * **백오프는 깨워 주는 쪽이 있어야 뜻이 있다.** 전송을 파기 루프에서만 걸면 뽑을 것이
   * 있을 때만 큐가 비워진다 — 수집 서버가 하루 죽었다 살아나도 다음 파기(최대 24시간
   * 뒤)까지 밀린 배치가 그대로 앉아 있다. 실서버 재기동으로 실제로 확인한 자리다.
   */
  retryIntervalMs: number;
}

export const SENDER_DEFAULTS: SenderConfig = {
  url: '',
  token: '',
  backoffBaseMs: 60_000,
  backoffMaxMs: 6 * 3_600_000,
  requestTimeoutMs: 30_000,
  retryIntervalMs: 10 * 60_000,
};

export interface ExporterOptions extends Partial<SenderConfig> {
  queue: ExportQueue;
  now?: () => number;
  fetch?: typeof globalThis.fetch;
  onLog?: (line: string) => void;
}

export interface Exporter {
  /** 레코드에서 표본을 뽑아 큐에 넣는다. **절대 던지지 않는다.** */
  collect(record: EventRecord): void;
  /** 대기 중인 배치를 보낸다. 백오프 중이거나 URL이 없으면 아무것도 안 한다. */
  flush(): Promise<void>;
  /** 결과를 안 기다리는 flush. 파기 루프가 부른다. */
  flushSoon(): void;
  /** 기동 시 1회 + 주기 재시도를 건다(spec system 03 §7.4). */
  start(): void;
  stop(): void;
  state(): ExportState;
  config: SenderConfig;
}

export function createExporter(options: ExporterOptions): Exporter {
  const config: SenderConfig = { ...SENDER_DEFAULTS, ...stripUndefined(options) };
  const { queue } = options;
  const now = options.now ?? Date.now;
  const doFetch = options.fetch ?? globalThis.fetch;
  const log = options.onLog ?? ((line: string) => console.log(line));
  let running = false;
  let timer: NodeJS.Timeout | null = null;

  function collect(record: EventRecord): void {
    try {
      const state = queue.state();
      const result = toSample(record);
      if (!result.ok) {
        if (result.reason === 'unjudged') state.skippedUnjudged += 1;
        else state.skippedTooShort += 1;
        queue.saveState(state);
        return;
      }
      queue.append(result.sample, now());
      state.totalQueued += 1;
      queue.saveState(state);
    } catch (error: unknown) {
      // 큐를 못 써도 파기는 계속돼야 한다. 표본 한 건이 파기 의무보다 무겁지 않다.
      log(`[export] 표본 적재 실패 ${record.eventId} — ${describe(error)}`);
    }
  }

  async function flush(): Promise<void> {
    if (!config.url) return; // 큐만 쌓는 모드
    if (running) return; // 앞선 전송이 아직 안 끝났다 — 같은 배치를 두 번 보내지 않는다
    const at = now();
    let state = queue.state();
    if (state.nextAttemptAt !== undefined && at < state.nextAttemptAt) return;

    const batches = queue.batches();
    if (batches.length === 0) return;

    running = true;
    try {
      for (const file of batches) {
        const outcome = await postBatch(file);
        state = queue.state();
        if (outcome.ok) {
          const lines = countLines(file);
          queue.markSent(file);
          state.failures = 0;
          state.lastSentAt = now();
          state.totalSent += lines;
          delete state.nextAttemptAt;
          delete state.lastError;
          queue.saveState(state);
          log(`[export] ${lines}건 전송`);
          continue;
        }
        // 4xx도 재시도한다. 토큰이 틀린 것뿐일 수 있고, 버리면 되돌릴 방법이 없다.
        state.failures += 1;
        state.lastError = outcome.error;
        state.nextAttemptAt = now() + backoffMs(state.failures);
        queue.saveState(state);
        log(`[export] 전송 실패(${state.failures}회) — ${outcome.error}`
          + ` · 다음 시도 ${Math.round(backoffMs(state.failures) / 60_000)}분 뒤`);
        break; // 한 배치가 막히면 뒤도 막힌다. 순서를 지킨다
      }
      // 보낸 것은 이미 익명정보라 파기 대상이 아니다. 이 정리는 디스크 회수 목적이다.
      queue.sweepSent(now());
    } finally {
      running = false;
    }
  }

  async function postBatch(file: string): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      const body = fs.readFileSync(file);
      const response = await doFetch(config.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-ndjson',
          ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
        },
        body,
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      });
      if (response.ok) return { ok: true };
      return { ok: false, error: `HTTP ${response.status}` };
    } catch (error: unknown) {
      return { ok: false, error: describe(error) };
    }
  }

  function backoffMs(failures: number): number {
    const grown = config.backoffBaseMs * 2 ** Math.max(0, failures - 1);
    return Math.min(grown, config.backoffMaxMs);
  }

  function start(): void {
    if (!config.url || timer) return;
    void flush(); // 기동 시 1회. 지난 실행에서 못 보낸 배치가 여기서 나간다
    timer = setInterval(() => { void flush(); }, config.retryIntervalMs);
    timer.unref?.(); // 재시도 타이머가 프로세스를 붙잡지 않게
  }

  function stop(): void {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  return {
    collect,
    flush,
    flushSoon: () => { void flush(); },
    start,
    stop,
    state: () => queue.state(),
    config,
  };
}

export interface ExportEnvOptions extends Partial<SenderConfig> {
  dir: string;
  keepDays: number;
}

export function exportOptionsFromEnv(
  dataDir: string,
  env: Record<string, string | undefined> = process.env,
): ExportEnvOptions {
  const keepDays = Number(env.EXPORT_KEEP_DAYS);
  return {
    dir: env.EXPORT_DIR || `${dataDir}/export`,
    keepDays: Number.isFinite(keepDays) && keepDays > 0 ? keepDays : 7,
    url: env.EXPORT_URL || '',
    token: env.EXPORT_TOKEN || '',
  };
}

/** 서버가 쓰는 조립 한 줄. 큐와 전송을 한 번에 세운다. */
export function createExporterFromEnv(
  dataDir: string,
  env: Record<string, string | undefined> = process.env,
): Exporter {
  const { dir, keepDays, ...sender } = exportOptionsFromEnv(dataDir, env);
  return createExporter({ queue: createExportQueue(dir, keepDays), ...sender });
}

function countLines(file: string): number {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.length > 0).length;
  } catch {
    return 0;
  }
}

function stripUndefined(options: ExporterOptions): Partial<SenderConfig> {
  const picked: Partial<SenderConfig> = {};
  for (const key of ['url', 'token', 'backoffBaseMs', 'backoffMaxMs', 'requestTimeoutMs', 'retryIntervalMs'] as const) {
    if (options[key] !== undefined) (picked as Record<string, unknown>)[key] = options[key];
  }
  return picked;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
