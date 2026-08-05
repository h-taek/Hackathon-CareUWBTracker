// 반출 큐(spec system 03 §7.3).
//
//   <dir>/pending/<YYYY-MM-DD>.jsonl   아직 못 보낸 표본. 한 줄 한 표본
//   <dir>/sent/<YYYY-MM-DD>.jsonl      보낸 것. 디스크 회수용으로만 남긴다
//   <dir>/state.json                   마지막 전송·연속 실패·누계
//
// **파일 하나가 배치 하나다.** 보내고 나면 이름만 바꾼다 — 이동이 원자적이라 중간에
// 죽어도 두 번 보내거나 잃지 않는다.
//
// DB를 두지 않는 이유는 store.ts와 같다. 한 번 쓰고 안 고치고, 사람이 열어 볼 수 있어야
// 한다 — 무엇이 시설 밖으로 나가는지는 눈으로 확인할 수 있어야 하는 종류의 것이다.

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { TrainingSample } from './sample.ts';

export interface ExportState {
  /** 마지막으로 2xx를 받은 시각. */
  lastSentAt?: number;
  /** 연속 실패 횟수. 백오프 간격이 여기서 나온다. */
  failures: number;
  /** 이 시각 전에는 다시 걸지 않는다. */
  nextAttemptAt?: number;
  lastError?: string;
  totalQueued: number;
  totalSent: number;
  /** 판정이 없어 못 뽑은 건수. 관제사가 안 본 만큼이다. */
  skippedUnjudged: number;
  /** 창이 안 차서 못 뽑은 건수. */
  skippedTooShort: number;
}

export const EMPTY_STATE: ExportState = {
  failures: 0,
  totalQueued: 0,
  totalSent: 0,
  skippedUnjudged: 0,
  skippedTooShort: 0,
};

export interface ExportQueue {
  /** 표본 한 건을 그날 배치에 붙인다. */
  append(sample: TrainingSample, at: number): void;
  /** 아직 못 보낸 배치 파일. 오래된 것부터. */
  batches(): string[];
  /** 배치 하나를 보낸 것으로 옮긴다. */
  markSent(file: string): void;
  /** 보관 기간이 지난 `sent/`를 지운다. 지운 개수. */
  sweepSent(at: number): number;
  state(): ExportState;
  saveState(next: ExportState): void;
  dir: string;
  pendingDir: string;
  sentDir: string;
}

export const DEFAULT_KEEP_DAYS = 7;

const DAY_MS = 86_400_000;
/** `2026-08-05.jsonl` 말고는 배치로 보지 않는다. 남이 떨군 파일을 전송하지 않게. */
const BATCH_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

export function createExportQueue(dir: string, keepDays: number = DEFAULT_KEEP_DAYS): ExportQueue {
  const pendingDir = path.join(dir, 'pending');
  const sentDir = path.join(dir, 'sent');
  const stateFile = path.join(dir, 'state.json');

  function append(sample: TrainingSample, at: number): void {
    fs.mkdirSync(pendingDir, { recursive: true });
    // 한 줄을 한 번의 호출로 붙인다. 줄 단위라 중간에 끼어들어도 반쪽짜리 JSON이 안 남는다.
    fs.appendFileSync(path.join(pendingDir, `${dayOf(at)}.jsonl`), `${JSON.stringify(sample)}\n`, 'utf8');
  }

  function batches(): string[] {
    return list(pendingDir).map((name) => path.join(pendingDir, name));
  }

  function markSent(file: string): void {
    fs.mkdirSync(sentDir, { recursive: true });
    const target = path.join(sentDir, path.basename(file));
    if (fs.existsSync(target)) {
      // 같은 날 두 번째 배치다. 덮어쓰면 먼저 보낸 것이 사라진다.
      fs.appendFileSync(target, fs.readFileSync(file, 'utf8'), 'utf8');
      fs.rmSync(file, { force: true });
      return;
    }
    fs.renameSync(file, target);
  }

  function sweepSent(at: number): number {
    const cutoff = at - keepDays * DAY_MS;
    let removed = 0;
    for (const name of list(sentDir)) {
      // 파일 시각이 아니라 이름의 날짜로 판단한다. 파일을 옮기면 mtime이 바뀐다.
      if (Date.parse(`${name.slice(0, 10)}T00:00:00Z`) >= cutoff) continue;
      fs.rmSync(path.join(sentDir, name), { force: true });
      removed += 1;
    }
    return removed;
  }

  function state(): ExportState {
    try {
      const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as Partial<ExportState>;
      return { ...EMPTY_STATE, ...parsed };
    } catch {
      return { ...EMPTY_STATE }; // 아직 한 번도 안 돌았거나 깨졌다 — 누계만 잃는다
    }
  }

  function saveState(next: ExportState): void {
    fs.mkdirSync(dir, { recursive: true });
    const temp = `${stateFile}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    fs.renameSync(temp, stateFile);
  }

  return { append, batches, markSent, sweepSent, state, saveState, dir, pendingDir, sentDir };
}

function list(folder: string): string[] {
  try {
    return fs.readdirSync(folder).filter((name) => BATCH_FILE.test(name)).sort();
  } catch {
    return []; // 아직 없는 폴더다
  }
}

/** UTC 기준 날짜. 시설 시간대를 안 쓰는 이유는 파일 이름 하나로 시설 위치를 좁히지 않기 위해서다. */
export function dayOf(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}
