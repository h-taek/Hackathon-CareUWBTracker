// 도구 출력에서 단계별 진행을 뽑는다(R-3).
//
// **전체 % 하나로 합치지 않는다.** 단계마다 걸리는 시간이 입력에 따라 뒤집히기 때문이다
// (학습을 30000회로 올리면 학습이, 프레임을 늘리면 자세 계산이 지배한다). 없는 가중치를
// 지어내는 대신 `3/5 · 62%`처럼 **단계 번호와 그 단계 안의 진행**만 보여준다.
//
// 파싱하는 줄은 전부 실제 로그에서 확인한 것이다.
//
//   frames         frame=37                                    (ffmpeg -progress pipe:1)
//   colmap:extract Processed file [37/128]
//   colmap:match   Processing image [94/128]
//   colmap:map     Registering image #67 (num_reg_frames=42)
//   opensplat      Step 660: 0.076039 (66%)

export interface StepProgress {
  /** 지금까지 처리한 수. 단계마다 단위가 다르다(장·회) */
  done: number;
  /** 전체 수. 모르면 null — 자세 계산이 그렇다 */
  total: number | null;
  /** 0~100. total을 모르면 도구가 준 값이 있을 때만 채운다 */
  percent: number | null;
  /** 화면에 그대로 띄우는 문구. "94/128장" 같은 것 */
  label: string;
}

export interface ProgressContext {
  /** ffmpeg가 뽑을 목표 장수 */
  targetFrames: number;
  /** 실제로 뽑힌 장수. 프레임 추출이 끝난 뒤에만 안다 */
  frameCount: number;
  /** 학습 반복 수 */
  numIters: number;
}

const PATTERNS: Record<string, (chunk: string, ctx: ProgressContext) => StepProgress | null> = {
  // ffmpeg는 -progress로 `frame=N`을 계속 찍는다. 마지막 값만 본다.
  frames: (chunk, ctx) => {
    const done = lastNumber(chunk, /^frame=\s*(\d+)/gm);
    if (done === null) return null;
    return ratio(done, ctx.targetFrames, `${done}/${ctx.targetFrames}장`);
  },

  'colmap:extract': (chunk) => {
    const m = lastMatch(chunk, /Processed file \[(\d+)\/(\d+)\]/g);
    return m ? ratio(Number(m[1]), Number(m[2]), `${m[1]}/${m[2]}장`) : null;
  },

  'colmap:match': (chunk) => {
    const m = lastMatch(chunk, /Processing image \[(\d+)\/(\d+)\]/g);
    return m ? ratio(Number(m[1]), Number(m[2]), `${m[1]}/${m[2]}장`) : null;
  },

  /**
   * 자세 계산만 **총량을 모른다.** `num_reg_frames`는 지금까지 등록한 수인데 최종 몇 장이
   * 등록될지는 끝나봐야 안다. 뽑은 장수를 분모로 쓰되, 그게 상한이라는 뜻이지 목표가 아니다
   * — 실패한 촬영은 2/128에서 안 움직이고, 그게 정확한 표시다.
   */
  'colmap:map': (chunk, ctx) => {
    const done = lastNumber(chunk, /num_reg_frames=(\d+)/g);
    if (done === null) return null;
    const total = ctx.frameCount > 0 ? ctx.frameCount : null;
    return ratio(done, total, total ? `등록 ${done}/${total}장` : `등록 ${done}장`);
  },

  // OpenSplat은 %를 직접 준다. 굳이 다시 계산하지 않는다.
  opensplat: (chunk, ctx) => {
    const m = lastMatch(chunk, /^Step (\d+): [\d.eE+-]+ \((\d+)%\)/gm);
    if (!m) return null;
    const done = Number(m[1]);
    return {
      done,
      total: ctx.numIters || null,
      percent: clamp(Number(m[2])),
      label: ctx.numIters ? `${done}/${ctx.numIters}회` : `${done}회`,
    };
  },
};

/** 이 단계의 출력 한 덩어리에서 진행을 뽑는다. 못 뽑으면 null(직전 값을 유지하라는 뜻). */
export function parseProgress(
  stepName: string,
  chunk: string,
  context: ProgressContext,
): StepProgress | null {
  return PATTERNS[stepName]?.(chunk, context) ?? null;
}

/** 진행을 찍는 단계인지. 안 찍는 단계는 화면이 막대 대신 "진행 중"만 보인다. */
export function reportsProgress(stepName: string): boolean {
  return stepName in PATTERNS;
}

function ratio(done: number, total: number | null, label: string): StepProgress {
  return {
    done,
    total,
    percent: total && total > 0 ? clamp(Math.round((done / total) * 100)) : null,
    label,
  };
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, value));
}

/** 한 덩어리에 여러 줄이 들어오므로 **마지막 것**을 쓴다. 중간 값을 쓰면 진행이 되감긴다. */
function lastMatch(chunk: string, pattern: RegExp): RegExpExecArray | null {
  let last: RegExpExecArray | null = null;
  for (const match of chunk.matchAll(pattern)) last = match as RegExpExecArray;
  return last;
}

function lastNumber(chunk: string, pattern: RegExp): number | null {
  const match = lastMatch(chunk, pattern);
  return match ? Number(match[1]) : null;
}
