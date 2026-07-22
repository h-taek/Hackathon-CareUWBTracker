'use strict';

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

export const ANCHOR_CONFIG_USAGE = `
사용법:
  npm start -- \\
    --main-anchor-id <ID> \\
    --sub-anchor-id <ID> \\
    --anchor-distance <미터> \\
    --half-plane <positive|negative>

옵션:
  --main-anchor-id   원점 (0,0)에 놓인 메인 앵커 ID
  --sub-anchor-id    (d,0)에 놓인 서브 앵커 ID
  --anchor-distance  두 앵커 사이 거리 d (0보다 큰 미터 값)
  --half-plane       태그가 놓이는 기준선의 반평면
  --help             이 도움말 출력
`.trim();

export function wantsAnchorConfigHelp(args: readonly string[]): boolean {
  return args.includes('--help') || args.includes('-h');
}

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
