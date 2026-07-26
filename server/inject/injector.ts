// 클립 주입기 — 데이터셋 클립을 ingest 프레임으로 되돌려 실제 파이프라인에 흘린다.
//
// 흐르는 길은 실측 워치와 완전히 같다:
//   클립 샘플(g) → ingest 스키마(m/s^2 + UWB 거리) → validateIngest → 삼각측량 → 스무딩
//   → 낙상 감지(고전 + LightGBM) → SSE
//
// 그래서 주입 버튼이 내는 경보는 "각본"이 아니라 감지기의 판정이다. 어떤 클립을 넣느냐가
// 결과를 정하고, 감지기가 기각하면 아무 경보도 안 나간다 — 실제 동작 그대로다.

import { clipDurationMs, type Clip } from './clip.ts';

export interface InjectFrame {
  tagId: string;
  ts: number;
  ranges: { anchorId: string; distance: number }[];
  accel: { x: number; y: number; z: number };
  source: string;
}

export interface InjectorOptions {
  clips: readonly Clip[];
  /** g → m/s^2 환산에 쓸 중력상수. 감지기(detection/fall.ts)와 같은 값이어야 한다 */
  gravity: number;
  /** 태그가 서 있는 자리 기준으로 만들 UWB 거리. 태그를 못 찾으면 null */
  rangesFor: (tagId: string) => InjectFrame['ranges'] | null;
  /** 한 프레임을 파이프라인에 넣는다. 서버가 /ingest와 같은 함수를 연결한다 */
  onFrame: (frame: InjectFrame) => void;
  /** 재생 시작 — 시뮬 태그 정지, 감지기 상태 초기화 등 준비를 서버가 한다 */
  onStart?: (tagId: string, clip: Clip) => void;
  /** 재생 종료(끝까지 갔든 중간에 교체됐든) */
  onEnd?: (tagId: string, clip: Clip, completed: boolean) => void;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancelSchedule?: (timer: unknown) => void;
}

export interface InjectionHandle {
  clipId: string;
  tagId: string;
  durationMs: number;
  frames: number;
}

interface Running {
  clip: Clip;
  timer: unknown;
}

export class ClipNotFoundError extends Error {
  constructor(clipId: string, known: readonly string[]) {
    super(`알 수 없는 클립: ${clipId} (있는 클립: ${known.join(', ')})`);
    this.name = 'ClipNotFoundError';
  }
}

export class TagNotFoundError extends Error {
  constructor(tagId: string) {
    super(`알 수 없는 태그: ${tagId}`);
    this.name = 'TagNotFoundError';
  }
}

export function createInjector(options: InjectorOptions) {
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? setTimeout;
  const cancelSchedule = options.cancelSchedule ?? ((t: unknown) => clearTimeout(t as NodeJS.Timeout));

  const byId = new Map<string, Clip>();
  for (const clip of options.clips) byId.set(clip.id, clip);
  const running = new Map<string, Running>();

  function stop(tagId: string, completed: boolean): void {
    const current = running.get(tagId);
    if (!current) return;
    running.delete(tagId);
    if (current.timer !== null) cancelSchedule(current.timer);
    options.onEnd?.(tagId, current.clip, completed);
  }

  /**
   * 클립을 태그 하나에 재생한다. 같은 태그에 이미 재생 중이면 이전 것을 버린다 —
   * 두 클립이 겹쳐 흐르면 감지기가 보는 신호가 실제로 존재할 수 없는 파형이 된다.
   */
  function start(tagId: string, clipId: string): InjectionHandle {
    const clip = byId.get(clipId);
    if (!clip) throw new ClipNotFoundError(clipId, [...byId.keys()]);

    const ranges = options.rangesFor(tagId);
    if (!ranges) throw new TagNotFoundError(tagId);

    stop(tagId, false);
    options.onStart?.(tagId, clip);

    const stepMs = 1000 / clip.hz;
    const startTs = now();
    const total = clip.samples.ax.length;
    const state: Running = { clip, timer: null };
    running.set(tagId, state);

    const emit = (index: number): void => {
      if (running.get(tagId) !== state) return; // 교체됐다 — 조용히 물러난다

      options.onFrame({
        tagId,
        // ts는 클립의 표본 간격으로 만든다. 실제 타이머 지터를 그대로 쓰면 감지기의
        // 무동작 시계가 매번 다르게 흘러 재현이 안 된다.
        ts: startTs + Math.round(index * stepMs),
        ranges,
        accel: {
          x: clip.samples.ax[index] * options.gravity,
          y: clip.samples.ay[index] * options.gravity,
          z: clip.samples.az[index] * options.gravity,
        },
        source: 'sim',
      });

      const next = index + 1;
      if (next >= total) {
        stop(tagId, true);
        return;
      }
      // 남은 프레임을 절대 시각 기준으로 잡는다. 상대 지연을 누적하면 재생이 느려진다.
      const delay = Math.max(0, startTs + next * stepMs - now());
      state.timer = schedule(() => emit(next), delay);
    };

    emit(0);

    return { clipId: clip.id, tagId, durationMs: clipDurationMs(clip), frames: total };
  }

  return {
    start,
    stop: (tagId: string) => stop(tagId, false),
    stopAll: () => { for (const tagId of [...running.keys()]) stop(tagId, false); },
    isPlaying: (tagId: string) => running.has(tagId),
    clips: () => [...byId.values()],
  };
}
