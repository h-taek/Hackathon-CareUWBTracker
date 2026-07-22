// 고전 낙상 감지 상태머신(순수·결정적). 04 §3 알고리즘.
// IDLE -> (충격) fall_candidate -> MONITORING -> (무동작 유지) fall_confirmed / (움직임) fall_canceled -> COOLDOWN -> (움직임) IDLE
// 시간은 payload.ts만 사용. Date.now() 비의존 -> 테스트 재현 가능.

const DEFAULT_GRAVITY = 9.80665;

const DEFAULTS = {
  gravity: DEFAULT_GRAVITY,
  impactG: 2.5,
  freefallG: 0.6,
  freefallWindowMs: 500,
  settleMs: 400,
  immobilityMs: 5000,
  immobilityBandG: 0.25, // 정지 밴드: |SMV-1g|가 이내여야 무동작 시계가 이어짐(초과 시 리셋)
  movementG: 0.4,
};

export interface FallEvent {
  type: string;
  tagId: string;
  peakAccel: number;
  freefall: boolean;
  aiScore?: number;
  pos?: { x: number; y: number };
  zone?: string | null;
}

export interface FallDetectorOptions {
  gravity?: number;
  impactG?: number;
  freefallG?: number;
  freefallWindowMs?: number;
  settleMs?: number;
  immobilityMs?: number;
  immobilityBandG?: number;
  movementG?: number;
}

interface FallState {
  phase: 'IDLE' | 'MONITORING' | 'COOLDOWN';
  lastTs: number | null;
  impactTs: number;
  peakG: number;
  freefallAt: number | null;
  freefallSeen: boolean;
  lastPos: { x: number; y: number; z?: number } | null;
  seq: number;
  quietStartTs: number;
}

function num(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const v = Number(env[key]);
  return Number.isFinite(v) ? v : fallback;
}

export function optionsFromEnv(env: Record<string, string | undefined> = process.env) {
  return {
    gravity: DEFAULT_GRAVITY,
    impactG: num(env, 'FALL_IMPACT_G', DEFAULTS.impactG),
    freefallG: num(env, 'FALL_FREEFALL_G', DEFAULTS.freefallG),
    freefallWindowMs: num(env, 'FALL_FREEFALL_WINDOW_MS', DEFAULTS.freefallWindowMs),
    settleMs: num(env, 'FALL_SETTLE_MS', DEFAULTS.settleMs),
    immobilityMs: num(env, 'FALL_IMMOBILITY_MS', DEFAULTS.immobilityMs),
    immobilityBandG: num(env, 'FALL_IMMOBILITY_BAND_G', DEFAULTS.immobilityBandG),
    movementG: num(env, 'FALL_MOVEMENT_G', DEFAULTS.movementG),
  };
}

export function createFallDetector(options: FallDetectorOptions = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const states = new Map<string, FallState>();

  function stateFor(tagId: string): FallState {
    let st = states.get(tagId);
    if (!st) {
      st = { phase: 'IDLE', lastTs: null, impactTs: 0, peakG: 0, freefallAt: null, freefallSeen: false, lastPos: null, seq: 0, quietStartTs: 0 };
      states.set(tagId, st);
    }
    return st;
  }

  function makeEvent(
    st: FallState,
    payload: { tagId: string; [key: string]: unknown },
    type: string,
    confidence: string,
  ) {
    return {
      eventId: `evt-${payload.tagId}-${st.impactTs}-${++st.seq}`,
      tagId: payload.tagId,
      type,
      ts: payload.ts,
      trigger: 'imu_accel',
      peakAccel: Math.round(st.peakG * 100) / 100,
      freefall: st.freefallSeen,
      pos: st.lastPos ? { x: st.lastPos.x, y: st.lastPos.y, z: st.lastPos.z ?? 0 } : null,
      confidence,
      zone: null as string | null, // server가 pos 기준으로 채움
    };
  }

  function observe(
    payload: { tagId: string; [key: string]: unknown },
    position: { x: number; y: number } | null,
  ) {
    const st = stateFor(payload.tagId);
    const payloadTs = payload.ts as number;
    // 단조 ts 가드: 순서 뒤바뀐(과거) 프레임은 무시해 elapsed 계산 왜곡을 막는다.
    if (st.lastTs !== null && payloadTs < st.lastTs) return [];
    st.lastTs = payloadTs;
    const positionWithPos = position as unknown as { pos?: { x: number; y: number; z?: number } } | null;
    if (positionWithPos && positionWithPos.pos) st.lastPos = positionWithPos.pos;

    const a = (payload.accel as { x?: number; y?: number; z?: number } | undefined) || {};
    const g = Math.hypot(a.x || 0, a.y || 0, a.z || 0) / cfg.gravity;
    const motion = Math.abs(g - 1);
    const ts = payloadTs;
    const events: ReturnType<typeof makeEvent>[] = [];

    if (g <= cfg.freefallG) st.freefallAt = ts;

    if (st.phase === 'IDLE') {
      if (g >= cfg.impactG) {
        st.phase = 'MONITORING';
        st.impactTs = ts;
        st.quietStartTs = ts;
        st.peakG = g;
        st.freefallSeen = st.freefallAt != null && (ts - st.freefallAt) <= cfg.freefallWindowMs;
        events.push(makeEvent(st, payload, 'fall_candidate', 'candidate'));
      }
    } else if (st.phase === 'MONITORING') {
      if (g > st.peakG) st.peakG = g;
      const elapsed = ts - st.impactTs;
      if (elapsed <= cfg.settleMs) {
        // 정착 구간: 바운스 무시(판정 보류). quietStartTs는 impactTs 유지.
      } else if (motion > cfg.movementG) {
        st.phase = 'IDLE';
        st.freefallAt = null;
        events.push(makeEvent(st, payload, 'fall_canceled', 'cleared'));
      } else {
        // 정지 밴드 초과(단 움직임 임계 미만): 완전 정지가 아니므로 무동작 시계 리셋(취소는 안 함).
        if (motion > cfg.immobilityBandG) st.quietStartTs = ts;
        if (ts - st.quietStartTs >= cfg.immobilityMs) {
          st.phase = 'COOLDOWN';
          events.push(makeEvent(st, payload, 'fall_confirmed', 'confirmed'));
        }
      }
    } else if (st.phase === 'COOLDOWN') {
      if (motion > cfg.movementG) {
        st.phase = 'IDLE';
        st.freefallAt = null;
      }
    }

    return events;
  }

  // 태그 상태를 IDLE로 되돌린다(캐스케이드 AI가 candidate를 기각할 때 후속 confirmed 차단용).
  function reset(tagId: string): void {
    const st = states.get(tagId);
    if (!st) return;
    st.phase = 'IDLE';
    st.freefallAt = null;
  }

  return { observe, reset };
}

export { DEFAULTS };
