// 정규화 마스터 CSV(ml/datasets/_normalized/falls_all_50hz.csv)에서 trial 하나를 잘라
// 데모 주입용 클립 JSON을 만든다.
//
// 클립은 리포에 커밋되는 데이터다. 커밋된 데이터는 재생성 경로가 없으면 출처를 잃으므로
// 이 파일이 그 경로다. 마스터 CSV는 3.7GB로 git 제외라, 클립만 커밋하고 만드는 법을 남긴다.
//
// 자르는 기준:
//   앞 = 첫 이벤트 인덱스 - (WINDOW + 여유)   AI 특징창(최근 150샘플)이 온전히 차야 한다
//   뒤 = 마지막 이벤트 인덱스 + 여유          결말을 보고 나서 끝난다
// 자른 뒤 감지기에 다시 흘려 이벤트 순서가 원본 trial과 같은지 확인한다. 다르면 자르기가
// 판정을 바꿨다는 뜻이라 클립으로 쓰면 안 된다.

import * as fs from 'node:fs';
import * as readline from 'node:readline';

import { WINDOW } from '../server/detection/features.ts';
import { createCascadeDetector } from '../server/detection/cascade.ts';
import type { Clip, ClipSamples } from '../server/inject/clip.ts';

const GRAVITY = 9.80665;
const ROUND = 6; // ml/dump_lgbm.py와 같은 자릿수 — 원신호 표현을 한 곳으로 맞춘다

// 마스터 CSV 컬럼
const COL = {
  dataset: 0, subject: 1, placement: 2, activity: 3, trial: 4,
  isFall: 5, srcHz: 6, tMs: 7, ax: 8, ay: 9, az: 10,
} as const;

export interface ClipSelector {
  dataset: string;
  subject: string;
  activity: string;
  trial: string;
  placement: string;
}

export interface TrialRows extends ClipSamples {
  tMs: number[];
  isFall: number;
  srcHz: number;
}

/** 마스터 CSV를 한 번 훑어 지정한 trial의 행만 모은다. */
export async function readTrial(csvPath: string, want: ClipSelector): Promise<TrialRows> {
  const rows: TrialRows = { ax: [], ay: [], az: [], tMs: [], isFall: 0, srcHz: 0 };
  const rl = readline.createInterface({
    input: fs.createReadStream(csvPath),
    crlfDelay: Infinity,
  });

  let seen = false;
  for await (const line of rl) {
    const c = line.split(',');
    if (c.length < 11) continue;
    if (c[COL.dataset] !== want.dataset || c[COL.subject] !== want.subject) continue;
    if (c[COL.placement] !== want.placement) continue;
    if (c[COL.activity] !== want.activity || c[COL.trial] !== want.trial) continue;

    if (!seen) {
      seen = true;
      rows.isFall = Number(c[COL.isFall]);
      rows.srcHz = Number(c[COL.srcHz]);
    }
    rows.ax.push(Number(c[COL.ax]));
    rows.ay.push(Number(c[COL.ay]));
    rows.az.push(Number(c[COL.az]));
    rows.tMs.push(Number(c[COL.tMs]));
  }
  rl.close();

  if (!seen) {
    const id = `${want.dataset}/${want.subject}/${want.activity}/${want.trial}@${want.placement}`;
    throw new Error(`trial을 찾지 못했습니다: ${id}`);
  }
  return rows;
}

export interface DetectedEvent {
  index: number;
  type: string;
  aiScore: number | null;
}

/**
 * 클립 샘플을 실제 감지기에 50Hz로 흘려 이벤트를 뽑는다.
 * 서버 런타임과 같은 모듈을 쓰므로, 여기서 나온 결과가 곧 데모에서 나올 결과다.
 */
export function detectEvents(samples: ClipSamples, hz: number, aiEnabled = true): DetectedEvent[] {
  const detector = createCascadeDetector({ aiEnabled });
  const stepMs = 1000 / hz;
  const found: DetectedEvent[] = [];

  for (let i = 0; i < samples.ax.length; i += 1) {
    const events = detector.observe(
      {
        tagId: 'clip',
        ts: Math.round(i * stepMs),
        accel: {
          x: samples.ax[i] * GRAVITY,
          y: samples.ay[i] * GRAVITY,
          z: samples.az[i] * GRAVITY,
        },
      },
      { pos: { x: 0, y: 0, z: 0 } },
    );
    for (const event of events) {
      found.push({ index: i, type: event.type, aiScore: event.aiScore ?? null });
    }
  }
  return found;
}

export interface TrimOptions {
  /** 특징창 앞에 더 둘 여유 샘플 수 */
  preMargin?: number;
  /** 마지막 이벤트 뒤에 남길 여유 샘플 수 */
  postMargin?: number;
}

export interface TrimResult {
  from: number;
  to: number;
  samples: ClipSamples;
}

/**
 * 이벤트 구간만 남기고 앞뒤를 자른다.
 *
 * 기준점은 캐스케이드가 아니라 **고전 단독** 이벤트까지 합쳐서 잡는다. 고전이 충격을 잡았는데
 * AI가 기각한 자리는 캐스케이드 이벤트 목록에 안 나타나지만, 그 자리도 클립 안에 들어와야 한다.
 * 그 앞을 잘라 버리면 AI가 채점할 때 링버퍼가 150샘플을 못 채워 가장자리 복제로 메우고
 * (cascade.ts의 "즉시 근사"), 원본에서 기각됐던 충격이 클립에서는 통과해 버린다.
 * 실제로 SisFall SA04 F02 R04에서 이 일이 났다 — 원본에 없던 경보가 클립에서 하나 더 났다.
 */
export function trimToEvents(rows: ClipSamples, hz: number, options: TrimOptions = {}): TrimResult {
  const preMargin = options.preMargin ?? 25;
  const postMargin = options.postMargin ?? 50;

  const cascade = detectEvents(rows, hz, true);
  const classical = detectEvents(rows, hz, false);
  const marks = [...cascade, ...classical].map((e) => e.index);
  if (marks.length === 0) throw new Error('이벤트가 없는 trial입니다 — 클립으로 쓸 수 없습니다.');

  const first = Math.min(...marks);
  const last = Math.max(...marks);
  const from = Math.max(0, first - WINDOW - preMargin);
  const to = Math.min(rows.ax.length, last + postMargin + 1);

  return {
    from,
    to,
    samples: {
      ax: rows.ax.slice(from, to).map(round),
      ay: rows.ay.slice(from, to).map(round),
      az: rows.az.slice(from, to).map(round),
    },
  };
}

function round(value: number): number {
  const factor = 10 ** ROUND;
  return Math.round(value * factor) / factor;
}

export interface BuildClipOptions extends TrimOptions {
  id: string;
  label: string;
  summary: string;
  activityLabel: string;
  hz?: number;
}

export interface BuildClipResult {
  clip: Clip;
  fullEvents: DetectedEvent[];
  clipEvents: DetectedEvent[];
  classicalEvents: DetectedEvent[];
}

export function buildClip(
  rows: TrialRows,
  want: ClipSelector,
  options: BuildClipOptions,
): BuildClipResult {
  const hz = options.hz ?? 50;
  const fullEvents = detectEvents(rows, hz, true);
  const fullClassical = detectEvents(rows, hz, false);
  const { from, to, samples } = trimToEvents(rows, hz, options);
  const clipEvents = detectEvents(samples, hz, true);
  const classicalEvents = detectEvents(samples, hz, false);

  // 자르기가 판정을 바꾸면 클립이 원본을 대표하지 못한다. 조용히 넘어가면 안 된다.
  // 캐스케이드와 고전을 둘 다 본다 — 한쪽만 보면 AI 기각이 통과로 뒤집힌 걸 놓친다.
  const seq = (events: DetectedEvent[]) => events.map((e) => e.type).join('>') || 'none';
  for (const [name, before, after] of [
    ['캐스케이드', seq(fullEvents), seq(clipEvents)],
    ['고전 단독', seq(fullClassical), seq(classicalEvents)],
  ] as const) {
    if (before !== after) {
      throw new Error(`자르기가 ${name} 판정을 바꿨습니다: 원본 ${before} → 클립 ${after}`);
    }
  }

  const clip: Clip = {
    id: options.id,
    label: options.label,
    summary: options.summary,
    hz,
    source: {
      dataset: want.dataset,
      subject: want.subject,
      activity: want.activity,
      activityLabel: options.activityLabel,
      trial: want.trial,
      placement: want.placement,
      isFall: rows.isFall === 1,
      srcHz: rows.srcHz,
      rowRange: [from, to],
    },
    expect: {
      events: clipEvents.map((e) => e.type),
      classicalEvents: classicalEvents.map((e) => e.type),
      aiScore: clipEvents.find((e) => e.aiScore != null)?.aiScore ?? null,
    },
    samples,
  };

  return { clip, fullEvents, clipEvents, classicalEvents };
}

export function formatClipReport(result: BuildClipResult): string {
  const { clip, clipEvents, classicalEvents } = result;
  const at = (events: DetectedEvent[]) => events
    .map((e) => `${e.type}@${(e.index / clip.hz).toFixed(2)}s${e.aiScore != null ? ` ai=${e.aiScore}` : ''}`)
    .join(' > ') || '이벤트 없음';

  const n = clip.samples.ax.length;
  return [
    `클립 ${clip.id}`,
    `  출처   ${clip.source.dataset} ${clip.source.subject} ${clip.source.activity}/${clip.source.trial} (${clip.source.placement}, ${clip.source.srcHz}Hz 원본)`,
    `  동작   ${clip.source.activityLabel} · is_fall=${clip.source.isFall ? 1 : 0}`,
    `  구간   원본 행 ${clip.source.rowRange[0]}~${clip.source.rowRange[1]} · ${n}샘플 · ${(n / clip.hz).toFixed(2)}초`,
    `  캐스케이드 ${at(clipEvents)}`,
    `  고전단독   ${at(classicalEvents)}`,
  ].join('\n');
}

export function writeClip(clip: Clip, outPath: string): void {
  // 샘플 배열은 한 줄로 붙인다 — 숫자마다 줄을 나누면 diff가 수백 줄로 번진다.
  const body = JSON.stringify(clip, null, 2)
    .replace(/\[\n\s+(-?[\d.e+-]+(,\n\s+-?[\d.e+-]+)*)\n\s+\]/g, (match) => match.replace(/\s+/g, ' '));
  fs.writeFileSync(outPath, `${body}\n`);
}
