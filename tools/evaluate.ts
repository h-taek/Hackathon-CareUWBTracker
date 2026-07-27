// 정규화 CSV의 라벨된 trial을 고전 낙상 감지기(detection/fall.ts)에 흘려
// 혼동행렬(민감도/특이도/정밀도/헛경보율)을 뽑는 오프라인 평가 코어.
// 이 감지기의 베이스라인 성적 = AI가 넘어야 할 기준선(spec 04 §6).
//
// 판정 수준은 하나다. 감지기가 fall_detected를 냈는가 = 충격(impactG)을 잡았는가.
// 예전에는 confirmed(충격 + 무동작 5초)를 함께 집계했지만, 그 단계가 없어졌다.

import { createFallDetector, DEFAULTS, type FallDetectorOptions } from '../server/detection/fall.ts';

export const GRAVITY = 9.80665;

export interface Sample {
  tMs: number;
  ax: number;
  ay: number;
  az: number;
  [key: string]: unknown;
}

export type Feed = (emit: (tMs: number, ax: number, ay: number, az: number) => void) => void;

export interface TrialLike {
  dataset: string;
  placement: string;
  isFall: boolean;
  samples?: Sample[];
  feed?: Feed;
}

export interface DetectResult {
  detected: boolean;
}

// trial 한 개를 새 감지기에 흘려 fall_detected가 났는지 본다.
// feed(emit): emit(tMs, ax_g, ay_g, az_g)를 샘플 순서대로 부르는 클로저(저장방식과 분리).
// 감지기는 accel(m/s²)을 기대하므로 g에 gravity를 곱해 넣는다(정규화 CSV는 g 단위).
export function detectTrial(feed: Feed, options: FallDetectorOptions = {}): DetectResult {
  const detector = createFallDetector(options);
  let detected = false;
  feed((tMs, ax, ay, az) => {
    const events = detector.observe({
      tagId: 'eval',
      ts: tMs,
      accel: { x: ax * GRAVITY, y: ay * GRAVITY, z: az * GRAVITY },
    }, null);
    for (const e of events) if (e.type === 'fall_detected') detected = true;
  });
  return { detected };
}

// samples 배열([{tMs,ax,ay,az}])용 feed 헬퍼.
export function feedSamples(samples: Sample[]): Feed {
  return (emit) => { for (const s of samples) emit(s.tMs, s.ax, s.ay, s.az); };
}

// 타입 배열(스윕 캐시용, 4개 병렬 Float 배열) feed 헬퍼.
export function feedTyped(
  ts: Float64Array,
  ax: Float32Array,
  ay: Float32Array,
  az: Float32Array,
): Feed {
  return (emit) => { for (let i = 0; i < ts.length; i += 1) emit(ts[i], ax[i], ay[i], az[i]); };
}

// trial이 캐시 feed를 갖고 있으면 그걸, 아니면 samples 배열을 쓴다.
export function trialFeed(t: TrialLike): Feed {
  return t.feed || feedSamples(t.samples || []);
}

export interface ConfusionCounts {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
}

export interface ConfusionMetrics extends ConfusionCounts {
  sens: number | null;
  spec: number | null;
  prec: number | null;
  fa: number | null;
  f1: number | null;
  bacc: number | null;
}

export interface ConfusionCounter {
  add(isFall: boolean, detected: boolean): void;
  readonly counts: ConfusionCounts;
  metrics(): ConfusionMetrics;
}

// 혼동행렬 누적기. detected=낙상으로 판정했는가, isFall=실제 낙상인가.
export function makeConfusion(): ConfusionCounter {
  const c: ConfusionCounts = { tp: 0, fp: 0, fn: 0, tn: 0 };
  return {
    add(isFall: boolean, detected: boolean): void {
      if (isFall && detected) c.tp += 1;
      else if (isFall && !detected) c.fn += 1;
      else if (!isFall && detected) c.fp += 1;
      else c.tn += 1;
    },
    get counts(): ConfusionCounts { return { ...c }; },
    metrics(): ConfusionMetrics {
      const { tp, fp, fn, tn } = c;
      const div = (a: number, b: number): number | null => (b > 0 ? a / b : null);
      const sens = div(tp, tp + fn);        // 민감도(recall): 실제 낙상 중 잡은 비율
      const spec = div(tn, tn + fp);        // 특이도: 실제 ADL 중 안 울린 비율
      const prec = div(tp, tp + fp);        // 정밀도: 울린 것 중 진짜 낙상 비율
      const fa = div(fp, fp + tn);          // 헛경보율 = 1 - 특이도
      const f1 = (prec != null && sens != null && prec + sens > 0)
        ? (2 * prec * sens) / (prec + sens) : null;
      const bacc = (sens != null && spec != null) ? (sens + spec) / 2 : null;
      return { tp, fp, fn, tn, sens, spec, prec, fa, f1, bacc };
    },
  };
}

export interface GroupResult {
  dataset: string;
  placement: string;
  detected: ConfusionCounter;
}

export interface EvaluationResult {
  overall: ConfusionCounter;
  byGroup: Map<string, GroupResult>;
}

// trial 이터러블을 한 번 훑어 전체 + 데이터셋×위치별 혼동행렬을 만든다.
// trials: [{ dataset, placement, isFall, samples }] 형태를 방출하는 이터러블.
export function evaluateTrials(
  trials: Iterable<TrialLike>,
  options: FallDetectorOptions = {},
): EvaluationResult {
  const overall = makeConfusion();
  const byGroup = new Map<string, GroupResult>();
  for (const t of trials) {
    const { detected } = detectTrial(trialFeed(t), options);
    overall.add(t.isFall, detected);
    const key = `${t.dataset}|${t.placement}`;
    let g = byGroup.get(key);
    if (!g) {
      g = { dataset: t.dataset, placement: t.placement, detected: makeConfusion() };
      byGroup.set(key, g);
    }
    g.detected.add(t.isFall, detected);
  }
  return { overall, byGroup };
}

export interface SweepSpec {
  values: number[];
  affects: string;
}

// 스윕할 임계값과 기본 범위(각 파라미터를 단독으로 흔든다 = 1D 스윕, 나머지는 기본값).
// gravity는 물리 상수라 제외. affects: 이 파라미터가 움직이는 판정 수준(리포트용).
// 감지를 좌우하는 건 impactG 하나뿐이다. freefall 계열은 이벤트의 freefall 플래그만 바꾸고
// 감지 여부에는 영향이 없어 'flag-only'로 표시한다(비교 기준선 유지용으로 남긴다).
// cooldownMs는 trial당 감지가 최대 1건이라 오프라인 평가에서 의미가 없어 뺐다.
export const SWEEP_SPECS: Record<string, SweepSpec> = {
  impactG:         { values: [1.5, 1.75, 2.0, 2.25, 2.5, 2.75, 3.0, 3.5, 4.0], affects: 'detected' },
  freefallG:       { values: [0.3, 0.4, 0.5, 0.6, 0.7, 0.8], affects: 'flag-only' },
  freefallWindowMs:{ values: [250, 500, 750, 1000], affects: 'flag-only' },
};

export interface SweepPoint {
  value: number;
  detected: ConfusionMetrics;
}

// 캐시된 trial 배열에 대해 파라미터 1개를 스윕하며 각 값의 overall 지표를 모은다.
// 반환: [{ value, detected:metrics }]
export function sweepParam(
  trials: TrialLike[],
  param: string,
  values: number[],
  baseOptions: FallDetectorOptions = {},
): SweepPoint[] {
  return values.map((value) => {
    const { overall } = evaluateTrials(trials, { ...baseOptions, [param]: value } as FallDetectorOptions);
    return { value, detected: overall.metrics() };
  });
}

export interface SweepParamResult {
  affects: string;
  base: number;
  points: SweepPoint[];
}

export type SweepResult = Record<string, SweepParamResult>;

// 전 임계값 스윕. specs 기본은 SWEEP_SPECS. 반환: { param: {affects, points:[...]} }
export function sweepAll(
  trials: TrialLike[],
  specs: Record<string, SweepSpec> = SWEEP_SPECS,
  baseOptions: FallDetectorOptions = {},
): SweepResult {
  const out: SweepResult = {};
  const defaults = DEFAULTS as unknown as Record<string, number>;
  for (const [param, spec] of Object.entries(specs)) {
    out[param] = {
      affects: spec.affects,
      base: defaults[param],
      points: sweepParam(trials, param, spec.values, baseOptions),
    };
  }
  return out;
}
