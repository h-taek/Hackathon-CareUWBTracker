'use strict';

// 앵커 배치 설정만 담당한다. argv 전체를 보지 않는다 —
// 자기 플래그만 골라 넘겨주는 일은 cli.ts가 한다.

export type HalfPlane = 'positive' | 'negative';

export interface AnchorConfig {
  mainAnchorId: string;
  subAnchorId: string;
  anchorDistance: number;
  halfPlane: HalfPlane;
}

const FLAG_TO_KEY = {
  '--main-anchor-id': 'mainAnchorId',
  '--sub-anchor-id': 'subAnchorId',
  '--anchor-distance': 'anchorDistance',
  '--half-plane': 'halfPlane',
} as const;

type ConfigKey = (typeof FLAG_TO_KEY)[keyof typeof FLAG_TO_KEY];

/** 이 모듈이 소유하는 실행 인자. cli.ts가 argv를 나눌 때 쓴다(목록을 두 곳에 두지 않는다). */
export const ANCHOR_FLAGS: readonly string[] = Object.keys(FLAG_TO_KEY);

// 사용법의 앵커 항목. 전체 사용법은 cli.ts가 이 조각을 끼워 조립한다.
// 앞뒤 줄바꿈만 걷어낸다 — trim()을 쓰면 첫 줄의 들여쓰기까지 깎여 정렬이 어긋난다.
export const ANCHOR_OPTION_LINES = `
  --main-anchor-id   원점 (0,0)에 놓인 메인 앵커 ID
  --sub-anchor-id    (d,0)에 놓인 서브 앵커 ID
  --anchor-distance  두 앵커 사이 거리 d (0보다 큰 미터 값)
  --half-plane       태그가 놓이는 기준선의 반평면 (positive|negative)
`.replace(/^\n+|\n+$/g, '');

/**
 * 앵커 인자를 해석한다. ANCHOR_FLAGS에 없는 인자가 들어오면 던진다 —
 * 여기까지 왔다는 건 cli.ts의 분배가 틀렸다는 뜻이라 조용히 넘기면 안 된다.
 */
export function parseAnchorConfig(args: readonly string[]): AnchorConfig {
  const values: Partial<Record<ConfigKey, string>> = {};

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    const equalsAt = token.indexOf('=');
    const flag = equalsAt >= 0 ? token.slice(0, equalsAt) : token;

    if (!(flag in FLAG_TO_KEY)) {
      throw new Error(`알 수 없는 실행 인자: ${token}`);
    }

    const key = FLAG_TO_KEY[flag as keyof typeof FLAG_TO_KEY];
    if (values[key] !== undefined) {
      throw new Error(`실행 인자가 중복되었습니다: ${flag}`);
    }

    const inlineValue = equalsAt >= 0 ? token.slice(equalsAt + 1) : undefined;
    const value = inlineValue ?? args[index + 1];
    if (value === undefined || value.startsWith('--') || value === '-h') {
      throw new Error(`실행 인자 값이 필요합니다: ${flag}`);
    }
    if (inlineValue === undefined) index += 1;
    values[key] = value;
  }

  const mainAnchorId = requireText(values.mainAnchorId, '--main-anchor-id');
  const subAnchorId = requireText(values.subAnchorId, '--sub-anchor-id');
  if (mainAnchorId === subAnchorId) {
    throw new Error('메인 앵커 ID와 서브 앵커 ID는 달라야 합니다.');
  }

  const distanceText = requireText(values.anchorDistance, '--anchor-distance');
  const anchorDistance = Number(distanceText);
  if (!Number.isFinite(anchorDistance) || anchorDistance <= 0) {
    throw new Error('--anchor-distance는 0보다 큰 유한한 숫자여야 합니다.');
  }

  const halfPlane = requireText(values.halfPlane, '--half-plane');
  if (halfPlane !== 'positive' && halfPlane !== 'negative') {
    throw new Error('--half-plane은 positive 또는 negative여야 합니다.');
  }

  return { mainAnchorId, subAnchorId, anchorDistance, halfPlane };
}

function requireText(value: string | undefined, flag: string): string {
  if (value === undefined) throw new Error(`필수 실행 인자가 없습니다: ${flag}`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`실행 인자 값이 비어 있습니다: ${flag}`);
  return trimmed;
}
