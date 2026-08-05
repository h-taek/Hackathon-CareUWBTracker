// 학습 표본 익명화(spec system 03 §7.1).
//
// 이벤트 레코드 하나를 받아 **시설 밖으로 나가도 되는 것만** 남긴다. 파일도 네트워크도
// 건드리지 않는 순수 함수라, 무엇이 빠져나가는지가 이 파일 하나를 읽으면 끝난다.
//
// **뽑을 필드를 나열하고 나머지는 버린다.** 반대로 짜면 — 지울 것을 나열하면 — 경보
// 스키마에 필드가 하나 늘 때마다 여기 손대야 하고, 안 고치면 그게 그대로 반출된다.
// 지금 alert에는 tagId·floor·zone·pos가 들어 있다.
//
// 남는 것은 3축 가속도 창과 관제사 판정 라벨뿐이다. 근거는 research/01_legal.md §9.

import type { EventRecord } from '../recorder.ts';
import { CONFIRMED, FALSE_ALARM, outcomeOf } from '../outcome.ts';

export interface TrainingSample {
  /** 창 첫 표본 기준 상대 ms. **절대 시각이 사라지는 자리다.** */
  dt: number[];
  ax: number[];
  ay: number[];
  az: number[];
  /** 1=낙상, 0=오경보. 출처는 관제사 판정뿐이다. */
  label: 0 | 1;
  peakAccel?: number;
  freefall?: boolean;
  aiScore?: number;
  /** 창의 실측 평균 표본율. 기기마다 달라 받는 쪽이 추정하게 두지 않는다. */
  hz?: number;
}

/**
 * 표본이 되기 위한 최소 길이. 이보다 짧으면 창이 안 찬 것이다 — 클립 주입이 중간에
 * 끊기거나 태그가 반납되면 몇 점만 남은 레코드가 생긴다. 그런 파형은 학습에 해롭다.
 */
export const MIN_SAMPLES = 10;

/** 반출하지 않은 이유. 세어서 남긴다 — 관제사가 안 보는 만큼이 그대로 학습 손실이다. */
export type SkipReason = 'unjudged' | 'too-short';

export type SampleResult =
  | { ok: true; sample: TrainingSample }
  | { ok: false; reason: SkipReason };

export function toSample(record: EventRecord): SampleResult {
  const label = labelOf(record);
  if (label === null) return { ok: false, reason: 'unjudged' };

  // `track`은 읽지 않는다. 지우는 것이 아니라 처음부터 가져오지 않는다.
  const accel = Array.isArray(record.accel) ? record.accel : [];
  if (accel.length < MIN_SAMPLES) return { ok: false, reason: 'too-short' };

  const t0 = accel[0].ts;
  const sample: TrainingSample = {
    dt: accel.map((s) => s.ts - t0),
    ax: accel.map((s) => s.x),
    ay: accel.map((s) => s.y),
    az: accel.map((s) => s.z),
    label,
  };

  // 감지기 메타. alert는 스키마가 열려 있어(spec 03 §2) 타입을 믿을 수 없다 — 값 하나하나
  // 확인해서 넣는다. aiScore와 label이 어긋난 표본이 오분류 사례이고 학습 재료로 값이 크다.
  const alert = (record.alert ?? {}) as Record<string, unknown>;
  const peakAccel = finite(alert.peakAccel);
  if (peakAccel !== null) sample.peakAccel = peakAccel;
  const aiScore = finite(alert.aiScore);
  if (aiScore !== null) sample.aiScore = aiScore;
  if (typeof alert.freefall === 'boolean') sample.freefall = alert.freefall;

  const hz = rateHz(sample.dt);
  if (hz !== null) sample.hz = hz;

  return { ok: true, sample };
}

/**
 * 라벨은 **관제사 판정에서만** 온다. 감지기 판정(`detected`)은 라벨이 아니다 — 그것을
 * 라벨로 쓰면 모델이 자기 출력을 정답으로 배운다.
 */
function labelOf(record: EventRecord): 0 | 1 | null {
  const outcome = outcomeOf(record);
  if (outcome === CONFIRMED) return 1;
  if (outcome === FALSE_ALARM) return 0;
  return null;
}

/** 창 길이로 나눈 평균. 표본이 한 점에 몰려 있으면(dt 전부 0) 못 잰다. */
function rateHz(dt: number[]): number | null {
  const span = dt[dt.length - 1] - dt[0];
  if (!Number.isFinite(span) || span <= 0) return null;
  return Math.round(((dt.length - 1) * 1000) / span);
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
