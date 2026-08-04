// 고전 낙상 감지 상태머신(순수·결정적). 04 §3 알고리즘.
// IDLE -> (충격) PENDING -> (정점 뒤 판정지연 경과) fall_detected -> COOLDOWN -> IDLE
// 시간은 payload.ts만 사용. Date.now() 비의존 -> 테스트 재현 가능.
//
// 감지는 한 단계다. 충격을 잡아 fall_detected 하나를 내고 끝이며, 그 뒤로 시스템은
// 아무것도 판단하지 않는다. 낙상이냐 아니냐는 캐스케이드 AI가 한 번 정하고
// (detection/cascade.ts), 그 다음은 관제사가 본다.
//
// PENDING이 있는 이유 — AI에 넣는 창을 학습 때와 같은 모양으로 만들기 위해서다.
// 임계를 넘은 표본에서 즉시 쏘면 링버퍼 끝(149/150)에 정점이 박히고 정점 이후 표본이
// 0개가 된다. 그러면 post_activity/post_still_ratio가 0, pre_post_ratio가 1e11로
// 고정돼 19특징 중 3개가 학습 때 본 적 없는 값으로 들어간다.
// 실측(waist trial 15,883건): 즉시 판정은 민감도 79.2% / 헛경보 9.1%,
// 정상 입력 기준선은 민감도 97.9% / 헛경보 1.4%(LOSO OOF, ml/_out/train_loso.txt).
// 정점 뒤 decisionDelayMs(=창 절반)만큼 기다렸다 쏘면 정점이 창 중앙에 놓인다.
//
// 예전에는 여기에 단계가 더 있었다 — 무동작 5초면 확진으로 승격, 움직이면 자동 해제.
// 둘 다 뺐다. 승격은 AI가 이미 내린 판정을 5초 늦출 뿐이었고, 자동 해제는 20ms 표본 하나로
// 경보를 지워 SisFall 낙상 1,361건 중 387건(28%)을 잃었다.

const DEFAULT_GRAVITY = 9.80665;

const DEFAULTS = {
  gravity: DEFAULT_GRAVITY,
  impactG: 2.5,
  freefallG: 0.6,
  freefallWindowMs: 500,
  // 정점 이후 이만큼 지나면 판정한다. 특징 창(features.ts WINDOW=150 @50Hz)의 절반인
  // 1.5초여야 정점이 창 한가운데 놓인다. 줄이면 경보는 빨라지지만 입력이 다시 치우친다.
  decisionDelayMs: 1500,
  // 충격 파형은 임계를 여러 표본 연속으로 넘는다. 이 시간 동안 같은 태그의 재발화를 막지
  // 않으면 낙상 한 번에 경보가 수십 건 뜬다.
  cooldownMs: 10000,
  // 도착 순서가 뒤집힌 프레임을 어디까지 "늦게 온 것"으로 받아줄지. 프레임당 POST 1건이라
  // 전송이 겹치면 순서가 섞이는데, 실측 지연은 약 100ms였다. 이보다 더 과거면 재정렬이 아니라
  // 낡은/중복 프레임으로 보고 버린다 — 몇 초 전 충격을 지금 것으로 세면 경보가 헛나간다.
  reorderToleranceMs: 500,
};

export interface FallEvent {
  /** `evt-<tagId>-<충격ts>-<seq>`. 사고 기록(R-1)이 이 값으로 레코드를 연다. */
  eventId: string;
  type: string;
  tagId: string;
  /** 판정 시각이 아니라 충격이 일어난 시각(spec 03 §2). */
  ts: number;
  peakAccel: number;
  freefall: boolean;
  aiScore?: number;
  pos?: { x: number; y: number; z?: number } | null;
  zone?: string | null;
  /** 사생활 구역에서 난 낙상. pos가 null인 이유가 측위 실패가 아니라는 표시다(spec 03 §1.1). */
  privacy?: boolean;
}

export interface FallDetectorOptions {
  gravity?: number;
  impactG?: number;
  freefallG?: number;
  freefallWindowMs?: number;
  decisionDelayMs?: number;
  cooldownMs?: number;
  reorderToleranceMs?: number;
}

interface FallState {
  phase: 'IDLE' | 'PENDING' | 'COOLDOWN';
  lastTs: number | null;
  impactTs: number;
  /** 마지막으로 최댓값을 갱신한 시각. 판정 지연은 여기서부터 잰다 */
  peakTs: number;
  peakG: number;
  freefallAt: number | null;
  freefallSeen: boolean;
  lastPos: { x: number; y: number; z?: number } | null;
  /** 마지막으로 확인한 구역. 사생활 구역에서는 좌표가 없어 이것만 남는다. */
  lastZone: string | null;
  /** 지금 사생활 구역에 있나. 좌표 없음이 측위 실패인지 정책인지를 이 값이 가른다. */
  inPrivacy: boolean;
  seq: number;
  /** 이벤트를 낸 시각. 쿨다운은 여기서부터 잰다 */
  firedTs: number;
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
    decisionDelayMs: num(env, 'FALL_DECISION_DELAY_MS', DEFAULTS.decisionDelayMs),
    cooldownMs: num(env, 'FALL_COOLDOWN_MS', DEFAULTS.cooldownMs),
  };
}

export function createFallDetector(options: FallDetectorOptions = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const states = new Map<string, FallState>();

  function stateFor(tagId: string): FallState {
    let st = states.get(tagId);
    if (!st) {
      st = {
        phase: 'IDLE', lastTs: null, impactTs: 0, peakTs: 0, peakG: 0,
        freefallAt: null, freefallSeen: false, lastPos: null,
        lastZone: null, inPrivacy: false, seq: 0, firedTs: 0,
      };
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
      // 충격이 일어난 시각을 싣는다. 판정은 그보다 decisionDelayMs 늦게 나지만,
      // 관제사에게 의미 있는 건 넘어진 시각이다.
      ts: st.impactTs,
      trigger: 'imu_accel',
      peakAccel: Math.round(st.peakG * 100) / 100,
      freefall: st.freefallSeen,
      pos: st.lastPos ? { x: st.lastPos.x, y: st.lastPos.y, z: st.lastPos.z ?? 0 } : null,
      confidence,
      // 좌표가 있으면 server가 pos 기준으로 덮어쓴다. 사생활 구역은 좌표가 없으므로
      // 마지막으로 본 구역명이 그대로 이벤트의 위치 정보가 된다.
      zone: st.lastZone,
      privacy: st.inPrivacy,
    };
  }

  function observe(
    payload: { tagId: string; [key: string]: unknown },
    position: { pos?: { x: number; y: number; z?: number } | null; zone?: string; privacy?: boolean } | null,
  ) {
    const st = stateFor(payload.tagId);
    const payloadTs = payload.ts as number;
    // 늦게 도착한 과거 프레임 처리. 프레임당 POST 1건이라 전송이 겹치면 도착 순서가 뒤집힌다
    // (실측: 5개 중 1개가 약 100ms 늦게 도착).
    //
    // reorderToleranceMs 안이면 시계는 되감지 않되(경과 계산 왜곡 방지) 그 표본의 가속도는
    // 반영한다. 예전에는 통째로 버렸는데, 하필 충격 정점 표본이 늦게 오면 peakG가 실제보다
    // 낮게 남아 경보의 peakAccel과 AI 채점이 함께 약해졌다.
    // 허용폭을 넘어가면 재정렬이 아니라 낡은 프레임이므로 예전처럼 버린다.
    const behind = st.lastTs !== null ? st.lastTs - payloadTs : 0;
    if (behind > cfg.reorderToleranceMs) return [];
    const late = behind > 0;
    const ts = late ? (st.lastTs as number) : payloadTs;
    if (!late) st.lastTs = payloadTs;
    // 사생활 구역에 들어온 순간 들고 있던 좌표를 버린다. 안 버리면 화장실에서 넘어져도
    // 이벤트에는 **문 앞 좌표**가 실리고 구역은 복도로 찍힌다 — 지운 좌표가 경보를 타고
    // 되살아나는 셈이다(spec 03 §1.1).
    if (position?.privacy) {
      st.lastPos = null;
      st.inPrivacy = true;
      if (position.zone) st.lastZone = position.zone;
    } else if (position?.pos) {
      st.lastPos = position.pos;
      st.inPrivacy = false;
      st.lastZone = position.zone ?? null;
    }

    const a = (payload.accel as { x?: number; y?: number; z?: number } | undefined) || {};
    const g = Math.hypot(a.x || 0, a.y || 0, a.z || 0) / cfg.gravity;
    const events: ReturnType<typeof makeEvent>[] = [];

    if (g <= cfg.freefallG) st.freefallAt = ts;

    if (st.phase === 'IDLE') {
      if (g >= cfg.impactG) {
        st.phase = 'PENDING';
        st.impactTs = ts;
        st.peakTs = ts;
        st.peakG = g;
        st.freefallSeen = st.freefallAt != null && (ts - st.freefallAt) <= cfg.freefallWindowMs;
      }
    } else if (st.phase === 'PENDING') {
      // 더 큰 충격이 오면 그게 진짜 정점이다. 대기를 새 정점 기준으로 다시 잰다.
      if (g > st.peakG) { st.peakG = g; st.peakTs = ts; }
      // 상한: 정점이 계속 갱신돼도 충격 뒤 2배 시간이 지나면 그냥 판정한다.
      const ripe = ts - st.peakTs >= cfg.decisionDelayMs
        || ts - st.impactTs >= cfg.decisionDelayMs * 2;
      if (ripe) {
        st.phase = 'COOLDOWN';
        st.firedTs = ts;
        events.push(makeEvent(st, payload, 'fall_detected', 'detected'));
      }
    } else if (ts - st.firedTs >= cfg.cooldownMs) {
      st.phase = 'IDLE';
      st.freefallAt = null;
    }

    return events;
  }

  // 태그 상태를 IDLE로 되돌린다(캐스케이드 AI가 감지를 기각할 때 쿨다운까지 함께 푼다).
  // 판정이 정점 뒤로 미뤄진 덕에, 기각 시점엔 그 충격이 이미 지나가 재발화가 안 생긴다.
  function reset(tagId: string): void {
    const st = states.get(tagId);
    if (!st) return;
    st.phase = 'IDLE';
    st.freefallAt = null;
  }

  return { observe, reset };
}

export { DEFAULTS };
