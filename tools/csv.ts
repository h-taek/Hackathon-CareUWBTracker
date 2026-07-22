// 정규화 낙상 CSV(ml/normalize_falls.py 출력) 스트리밍 리더.
// 대용량(마스터 2.5GB)을 메모리에 다 안 올리고 한 줄씩 읽어 trial 단위로 끊는다.
// CSV는 trial 단위로 연속 기록되므로(같은 키 행이 인접), 키가 바뀌는 지점에서 한 trial을 방출한다.

import * as fs from 'node:fs';
import * as readline from 'node:readline';

export const EXPECTED = ['dataset', 'subject', 'placement', 'activity', 'trial',
  'is_fall', 'src_hz', 't_ms', 'ax_g', 'ay_g', 'az_g', 'smv_g'];

export interface CsvRow {
  dataset: string;
  subject: string;
  placement: string;
  activity: string;
  trial: string;
  isFall: boolean;
  srcHz: string;
  tMs: number;
  ax: number;
  ay: number;
  az: number;
  smv: number;
}

export interface Sample {
  tMs: number;
  ax: number;
  ay: number;
  az: number;
  smv: number;
  [key: string]: unknown;
}

export interface Trial {
  dataset: string;
  subject: string;
  placement: string;
  activity: string;
  trial: string;
  isFall: boolean;
  srcHz: string;
  samples: Sample[];
}

export interface StreamStats {
  trials: number;
  rows: number;
}

// 헤더 줄 → 컬럼명:인덱스 맵. 기대 컬럼이 없으면 던진다(포맷 변경 조기 감지).
export function parseHeader(line: string): Record<string, number> {
  const cols = line.split(',');
  const idx: Record<string, number> = {};
  cols.forEach((name, i) => { idx[name.trim()] = i; });
  for (const key of EXPECTED) {
    if (!(key in idx)) throw new Error(`CSV 헤더에 '${key}' 컬럼이 없습니다`);
  }
  return idx;
}

// 데이터 줄 → 샘플 객체(숫자 파싱). 빈 줄/파싱 실패는 null.
export function parseRow(line: string, idx: Record<string, number>): CsvRow | null {
  if (!line) return null;
  const c = line.split(',');
  if (c.length < EXPECTED.length) return null;
  const tMs = Number(c[idx.t_ms]);
  const ax = Number(c[idx.ax_g]);
  const ay = Number(c[idx.ay_g]);
  const az = Number(c[idx.az_g]);
  if (!Number.isFinite(tMs) || !Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(az)) {
    return null;
  }
  return {
    dataset: c[idx.dataset],
    subject: c[idx.subject],
    placement: c[idx.placement],
    activity: c[idx.activity],
    trial: c[idx.trial],
    isFall: c[idx.is_fall] === '1',
    srcHz: c[idx.src_hz],
    tMs, ax, ay, az,
    smv: Number(c[idx.smv_g]),
  };
}

// trial 식별 키(한 trial의 전 행이 공유).
export function trialKey(r: CsvRow): string {
  return `${r.dataset}|${r.subject}|${r.placement}|${r.activity}|${r.trial}`;
}

// 행 이터러블 → trial 제너레이터(연속 같은 키를 묶는다). 순수 함수(테스트 가능).
// 방출 trial: { dataset, subject, placement, activity, trial, isFall, srcHz, samples:[{tMs,ax,ay,az,smv}] }
export function* groupTrials(rows: Iterable<CsvRow | null>): Generator<Trial> {
  let cur: Trial | null = null;
  let curKey: string | null = null;
  for (const r of rows) {
    if (!r) continue;
    const k = trialKey(r);
    if (k !== curKey) {
      if (cur) yield cur;
      curKey = k;
      cur = {
        dataset: r.dataset, subject: r.subject, placement: r.placement,
        activity: r.activity, trial: r.trial, isFall: r.isFall, srcHz: r.srcHz,
        samples: [],
      };
    }
    cur!.samples.push({ tMs: r.tMs, ax: r.ax, ay: r.ay, az: r.az, smv: r.smv });
  }
  if (cur) yield cur;
}

// 파일을 스트리밍하며 trial마다 onTrial(trial)을 부른다. filter(trial)=>bool로 선별 가능.
// 반환: Promise<{trials, rows}> 통계.
export function streamTrialsFromFile(
  filePath: string,
  onTrial: (trial: Trial) => void,
  filter: ((trial: Trial) => boolean) | null = null,
): Promise<StreamStats> {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    let idx: Record<string, number> | null = null;
    let trials = 0;
    let rows = 0;
    let cur: Trial | null = null;
    let curKey: string | null = null;

    const flush = (): void => {
      if (!cur) return;
      trials += 1;
      if (!filter || filter(cur)) onTrial(cur);
      cur = null;
    };

    rl.on('line', (line: string) => {
      if (idx === null) { idx = parseHeader(line); return; }
      const r = parseRow(line, idx);
      if (!r) return;
      rows += 1;
      const k = trialKey(r);
      if (k !== curKey) {
        flush();
        curKey = k;
        cur = {
          dataset: r.dataset, subject: r.subject, placement: r.placement,
          activity: r.activity, trial: r.trial, isFall: r.isFall, srcHz: r.srcHz,
          samples: [],
        };
      }
      cur!.samples.push({ tMs: r.tMs, ax: r.ax, ay: r.ay, az: r.az, smv: r.smv });
    });
    rl.on('close', () => { flush(); resolve({ trials, rows }); });
    rl.on('error', reject);
  });
}
