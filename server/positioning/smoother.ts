'use strict';

export const DEFAULT_POSITION_WINDOW = 5;

/**
 * UWB 거리는 가만히 서 있어도 수 cm씩 흔들린다. 이동평균만으로는 그 흔들림이 마커의
 * 제자리 떨림으로 그대로 남는다 — 창을 키우면 떨림 대신 지연이 커질 뿐이라 맞바꾸기가 된다.
 * 그래서 "정지"와 "이동"을 나눠서 다루고, 평균에 들어가면 안 되는 프레임을 먼저 걸러낸다.
 */
export interface SmootherConfig {
  windowSize: number;
  /** 정지 중 판정 반경(m). 평활 좌표가 이 안에서 놀면 마커를 아예 안 옮긴다. */
  staticDeadbandM: number;
  /**
   * 정지 판정 거리(m). 이동 중이던 태그가 stopFrames 동안 이만큼도 못 움직였으면 멈춘 것으로 본다.
   * 프레임당 이동이 아니라 누적 이동을 보는 이유는, 10Hz에서 1m/s 걸음이 프레임당 0.1m뿐이라
   * 프레임 단위로 재면 정상 보행이 '제자리'로 오판되기 때문이다(0.3초면 0.3m라 확실히 갈린다).
   */
  movingDeadbandM: number;
  /** 정지 판정에 쓰는 관찰 구간(프레임). 10Hz 기준 3프레임 ≈ 0.3초. */
  stopFrames: number;
  /** 이상치 판정 기준(m). 여기에 이동속도 몫을 더한 만큼까지는 정상으로 본다. */
  jumpBaseM: number;
  /** 사람이 낼 수 있다고 보는 속도(m/s). 프레임 간격에 곱해 이상치 한계에 더한다. */
  jumpSpeedMps: number;
  /** 이만큼 연속으로 이상치가 나오면 진짜 이동으로 보고 창을 비운다. */
  maxConsecutiveRejects: number;
  /** ts가 없거나 뒤집혔을 때 가정하는 프레임 간격(ms). ingest는 10Hz다. */
  assumedFrameMs: number;
}

export const SMOOTHER_DEFAULTS: SmootherConfig = {
  windowSize: DEFAULT_POSITION_WINDOW,
  staticDeadbandM: 0.4,
  movingDeadbandM: 0.15,
  stopFrames: 3,
  jumpBaseM: 0.8,
  jumpSpeedMps: 3,
  maxConsecutiveRejects: 5,
  assumedFrameMs: 100,
};

export type SmootherOptions = Partial<SmootherConfig>;

interface Coordinates {
  x: number;
  y: number;
  z: number;
}

export interface PositionRecord {
  tagId: string;
  ts?: unknown;
  pos: Coordinates;
  /** 삼각측량이 해 없음으로 y를 깎았다는 표시. 있으면 측정값이 아니다(from-ingest.ts 참고). */
  geom?: { clamped?: boolean };
  [key: string]: unknown;
}

/** 마커를 안 옮긴 프레임에 붙는 꼬리표. 왜 안 움직였는지가 로그로 남는다. */
export type HoldReason = 'clamped' | 'outlier' | 'deadband';

interface TagState {
  /** 평활 창에 들어간 좌표들. */
  points: Coordinates[];
  sum: Coordinates;
  /** 마지막으로 창에 넣은 원본 좌표. 이상치 판정 기준점이다(화면 좌표가 아니다). */
  lastAccepted: Coordinates | null;
  lastTs: number | null;
  /** 마지막으로 내보낸 좌표. 데드밴드 판정 기준점이다. */
  shown: Coordinates | null;
  /** 데드밴드를 벗어나 따라가는 중인가. 정지/이동을 다르게 다루기 위한 상태. */
  moving: boolean;
  /** 이동 중 최근 출력 좌표들. 맨 앞과 현재를 비교해 누적 이동량으로 정지를 판정한다. */
  trail: Coordinates[];
  rejects: number;
}

/** 좌표를 붙잡은 프레임에는 hold가 실린다 — 있으면 "이 프레임은 화면을 안 움직였다"는 뜻이다. */
export type Smoothed<T> = T & { hold?: { reason: HoldReason } };

export interface PositionSmoother {
  observe<T extends PositionRecord>(position: T): Smoothed<T>;
  reset(tagId?: string): void;
}

/** 실기기 현장에서 재빌드 없이 반경을 조절할 수 있게 환경변수로 뺀다(fall 감지기와 같은 방식). */
export function smootherOptionsFromEnv(
  env: Record<string, string | undefined> = process.env,
): SmootherOptions {
  return {
    windowSize: num(env, 'POS_WINDOW', SMOOTHER_DEFAULTS.windowSize),
    staticDeadbandM: num(env, 'POS_DEADBAND_M', SMOOTHER_DEFAULTS.staticDeadbandM),
    movingDeadbandM: num(env, 'POS_DEADBAND_MOVING_M', SMOOTHER_DEFAULTS.movingDeadbandM),
    jumpBaseM: num(env, 'POS_MAX_JUMP_M', SMOOTHER_DEFAULTS.jumpBaseM),
    jumpSpeedMps: num(env, 'POS_MAX_SPEED_MPS', SMOOTHER_DEFAULTS.jumpSpeedMps),
  };
}

function num(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const parsed = Number(env[key]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function createPositionSmoother(
  options: number | SmootherOptions = {},
): PositionSmoother {
  const cfg = {
    ...SMOOTHER_DEFAULTS,
    ...(typeof options === 'number' ? { windowSize: options } : options),
  };
  validateConfig(cfg);

  const states = new Map<string, TagState>();

  function stateFor(tagId: string): TagState {
    let state = states.get(tagId);
    if (!state) {
      state = {
        points: [],
        sum: { x: 0, y: 0, z: 0 },
        lastAccepted: null,
        lastTs: null,
        shown: null,
        moving: false,
        trail: [],
        rejects: 0,
      };
      states.set(tagId, state);
    }
    return state;
  }

  /**
   * 이 프레임의 좌표를 화면에 반영하지 않고 직전 좌표를 그대로 유지한다.
   * ts·가속도 등 나머지 필드는 현재 프레임 것을 쓴다 — 좌표만 붙잡는 것이지 프레임을 버리는 게 아니다.
   * (낙상 감지기가 이 반환값의 pos를 마지막 위치로 쓰므로 값이 비면 안 된다.)
   */
  function hold<T extends PositionRecord>(
    position: T,
    state: TagState,
    reason: HoldReason,
  ): Smoothed<T> {
    if (!state.shown) state.shown = { ...position.pos };
    return { ...position, pos: { ...state.shown }, hold: { reason } };
  }

  function clearWindow(state: TagState): void {
    state.points.length = 0;
    state.sum = { x: 0, y: 0, z: 0 };
  }

  return {
    observe<T extends PositionRecord>(position: T): Smoothed<T> {
      validatePosition(position);

      const state = stateFor(position.tagId);
      const raw: Coordinates = { ...position.pos };
      const ts = typeof position.ts === 'number' && Number.isFinite(position.ts) ? position.ts : null;

      // ── 클램프 프레임 제외 ──
      // 삼각측량이 해를 못 찾아 y를 0으로 깎은 좌표다. 측정값이 아니라 실패 신호라서
      // 평균에 섞이면 마커가 실제 위치와 y=0 사이를 왕복한다.
      if (position.geom?.clamped) return hold(position, state, 'clamped');

      // ── 이상치 컷 ──
      // 기준점은 화면 좌표가 아니라 마지막으로 창에 넣은 원본이다. 데드밴드로 화면이 멈춰 있는 동안
      // 사람이 천천히 걸어가면 화면 기준으로는 거리가 계속 벌어져서, 정상 이동이 통째로 이상치가 된다.
      if (state.lastAccepted) {
        const gapMs = ts !== null && state.lastTs !== null ? ts - state.lastTs : cfg.assumedFrameMs;
        const dtSec = Math.max(0, Number.isFinite(gapMs) ? gapMs : cfg.assumedFrameMs) / 1000;
        const limit = cfg.jumpBaseM + cfg.jumpSpeedMps * dtSec;
        if (distance(raw, state.lastAccepted) > limit) {
          state.rejects += 1;
          // 계속 거부되면 튄 게 아니라 실제로 멀리 간 것이다(재연결·달리기). 창을 비우고 새로 시작한다.
          if (state.rejects < cfg.maxConsecutiveRejects) return hold(position, state, 'outlier');
          clearWindow(state);
        }
      }
      state.rejects = 0;
      state.lastAccepted = raw;
      state.lastTs = ts;

      // ── 이동평균 ──
      state.points.push(raw);
      state.sum.x += raw.x;
      state.sum.y += raw.y;
      state.sum.z += raw.z;
      if (state.points.length > cfg.windowSize) {
        const removed = state.points.shift();
        if (removed) {
          state.sum.x -= removed.x;
          state.sum.y -= removed.y;
          state.sum.z -= removed.z;
        }
      }
      const count = state.points.length;
      const averaged: Coordinates = {
        x: state.sum.x / count,
        y: state.sum.y / count,
        z: state.sum.z / count,
      };

      // ── 데드밴드 ──
      // 정지 중에는 반경 안에서 노는 좌표를 무시하고 마커를 한 점에 고정한다 — 제자리 떨림이
      // 화면에서 사라진다. 반경을 벗어나면 이동으로 보고 그때부터는 평활 좌표를 그대로 따라간다
      // (이동 중에도 반경을 걸면 걸음이 계단처럼 끊긴다). 좁은 반경 안에 몇 프레임 머물면 정지로 돌아간다.
      if (state.shown) {
        if (state.moving) {
          state.trail.push(averaged);
          if (state.trail.length > cfg.stopFrames + 1) state.trail.shift();
          const from = state.trail.length > cfg.stopFrames ? state.trail[0] : null;
          if (from && distance(averaged, from) < cfg.movingDeadbandM) {
            state.moving = false;
            state.trail.length = 0;
            return hold(position, state, 'deadband');
          }
        } else if (distance(averaged, state.shown) < cfg.staticDeadbandM) {
          return hold(position, state, 'deadband');
        } else {
          state.moving = true;
          // 관찰 구간은 이동을 시작한 지점부터 센다. 직전 고정 좌표를 넣으면 그 한 번의 큰
          // 도약이 계속 기준으로 남아서, 도착해 멈춘 뒤에도 이동 중으로 오판한다.
          state.trail = [averaged];
        }
      }
      state.shown = averaged;
      return { ...position, pos: { ...averaged } };
    },

    reset(tagId?: string): void {
      if (tagId === undefined) states.clear();
      else states.delete(tagId);
    },
  };
}

function distance(a: Coordinates, b: Coordinates): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function validateConfig(cfg: SmootherConfig): void {
  if (!Number.isInteger(cfg.windowSize) || cfg.windowSize <= 0) {
    throw new RangeError('windowSize must be a positive integer');
  }
  for (const key of ['staticDeadbandM', 'movingDeadbandM', 'jumpBaseM', 'jumpSpeedMps'] as const) {
    if (!Number.isFinite(cfg[key]) || cfg[key] < 0) {
      throw new RangeError(`${key} must be a non-negative finite number`);
    }
  }
  for (const key of ['maxConsecutiveRejects', 'stopFrames'] as const) {
    if (!Number.isInteger(cfg[key]) || cfg[key] <= 0) {
      throw new RangeError(`${key} must be a positive integer`);
    }
  }
}

function validatePosition(position: PositionRecord): void {
  if (!position || typeof position !== 'object') {
    throw new TypeError('position must be an object');
  }
  if (typeof position.tagId !== 'string' || !position.tagId.trim()) {
    throw new TypeError('position.tagId must be a non-empty string');
  }
  if (!position.pos || typeof position.pos !== 'object') {
    throw new TypeError('position.pos must be an object');
  }
  for (const axis of ['x', 'y', 'z'] as const) {
    if (!Number.isFinite(position.pos[axis])) {
      throw new TypeError(`position.pos.${axis} must be a finite number`);
    }
  }
}
