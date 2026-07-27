// 2단계 캐스케이드 감지기 = 1단계 고전 상태머신(고민감도) → 2단계 AI 정밀판정(헛경보 청소).
// research 02 하이브리드 / 04 §3. 1단계가 fall_detected를 내면, 그 순간의 충격 윈도우를
// AI(LightGBM)로 즉석 채점(즉시 근사 판정)해 낙상이 아니면 이벤트를 기각하고 고전 상태를
// IDLE로 되돌린다. 낙상이냐 아니냐를 정하는 곳은 여기 하나뿐이다.
//
// 채점 창: 1단계가 정점 뒤 decisionDelayMs(1.5초 = WINDOW 절반)를 기다렸다 이벤트를 내므로,
// 그 시점의 링버퍼(최근 WINDOW개)는 정점이 한가운데(≈74/150)에 놓인 상태다. extractWindow가
// 기대하는 배치이자 학습 때와 같은 모양이라, 19특징이 전부 정상 범위로 들어간다.
//
// 예전에는 임계를 넘는 표본에서 즉시 채점했다("즉시 근사"). 그러면 정점이 창 끝(149/150)에
// 박혀 정점 이후 표본이 0개가 되고, post_activity/post_still_ratio가 0, pre_post_ratio가
// 1e11로 고정됐다. 실측으로 민감도 79.2% / 헛경보 9.1% — 기준선(97.9% / 1.4%)과 큰 차이였다.

import { createFallDetector, type FallDetectorOptions, type FallEvent } from './fall.ts';
import { WINDOW, featureVector } from './features.ts';
import { createModel } from './lgbm.ts';

const DEFAULT_GRAVITY = 9.80665;

interface ModelInstance {
  threshold: number;
  proba: (vec: number[]) => number;
  predict?: (vec: number[]) => number;
}

export interface RejectionInfo {
  tagId: string;
  aiScore: number;
  threshold: number;
  peakAccel: number;
}

export interface CascadeOptions extends FallDetectorOptions {
  model?: ModelInstance | string | Record<string, unknown> | null;
  aiThreshold?: number;
  aiEnabled?: boolean;
  gravity?: number;
  /** AI가 감지를 기각할 때 부른다. 기각은 밖에서 안 보이므로 이게 유일한 흔적이다 */
  onReject?: (info: RejectionInfo) => void;
}

interface AccelBuffer {
  ax: number[];
  ay: number[];
  az: number[];
}

function isModelInstance(m: unknown): m is ModelInstance {
  return !!m && typeof (m as ModelInstance).proba === 'function';
}

// options: 고전 옵션 전체 + { model, aiThreshold, aiEnabled, gravity }
//   model: createModel() 인스턴스 또는 JSON/경로(미지정 시 동봉 model-lgbm.json 로드)
//   aiThreshold: 이 확률 미만이면 candidate 기각(기본 model.threshold)
//   aiEnabled: false면 순수 고전과 동일(A/B용)
export function createCascadeDetector(options: CascadeOptions = {}) {
  const classical = createFallDetector(options);
  const gravity = options.gravity || DEFAULT_GRAVITY;
  const aiEnabled = options.aiEnabled !== false;

  let model: ModelInstance | null = null;
  if (aiEnabled) {
    model = isModelInstance(options.model)
      ? options.model
      : (createModel(options.model as unknown as Parameters<typeof createModel>[0]) as ModelInstance);
  }
  const threshold = options.aiThreshold != null
    ? options.aiThreshold : (model ? model.threshold : 0.5);

  const buffers = new Map<string, AccelBuffer>(); // tagId -> {ax:[],ay:[],az:[]} (g 단위, 최근 WINDOW개)

  function push(tagId: string, axg: number, ayg: number, azg: number): AccelBuffer {
    let b = buffers.get(tagId);
    if (!b) { b = { ax: [], ay: [], az: [] }; buffers.set(tagId, b); }
    b.ax.push(axg); b.ay.push(ayg); b.az.push(azg);
    if (b.ax.length > WINDOW) { b.ax.shift(); b.ay.shift(); b.az.shift(); }
    return b;
  }

  function scoreBuffer(b: AccelBuffer): number {
    const vec = featureVector(b.ax, b.ay, b.az);
    return (model as ModelInstance).proba(vec);
  }

  function observe(
    payload: { tagId: string; [key: string]: unknown },
    position: { pos?: { x: number; y: number; z?: number } } | null,
  ): FallEvent[] {
    const a = (payload.accel as { x?: number; y?: number; z?: number } | undefined) || {};
    const b = push(payload.tagId, (a.x || 0) / gravity, (a.y || 0) / gravity, (a.z || 0) / gravity);

    const events = classical.observe(payload, position) as unknown as FallEvent[];
    if (!aiEnabled || events.length === 0) return events;

    const out: FallEvent[] = [];
    for (const e of events) {
      if (e.type === 'fall_detected') {
        const score = scoreBuffer(b);
        e.aiScore = Math.round(score * 1000) / 1000;
        if (score < threshold) {
          // AI 기각: 이벤트 미전파 + 고전 상태 리셋(쿨다운까지 풀어 다음 충격을 다시 본다).
          // 기각은 아무 흔적을 안 남기면 "감지기가 죽었다"와 구분이 안 된다.
          // 워치를 떨어뜨렸는데 화면이 조용할 때, 이 콜백이 유일한 단서다.
          options.onReject?.({
            tagId: payload.tagId,
            aiScore: e.aiScore as number,
            threshold,
            peakAccel: e.peakAccel,
          });
          classical.reset(payload.tagId);
          continue;
        }
      }
      out.push(e);
    }
    return out;
  }

  return { observe, reset: (tagId: string) => classical.reset(tagId) };
}
