'use strict';

// 서버 실행 인자 전체의 소유자. argv를 설정 모듈별로 나눠 넘기고, 아무도 안 가져간
// 인자를 여기서 한 번만 거절한다. 서버에 옵션을 추가할 때 손대는 자리도 여기 한 곳이다.

import { takeFlags } from './argv.ts';
import {
  ANCHOR_FLAGS,
  ANCHOR_OPTION_LINES,
  parseAnchorConfig,
  type AnchorConfig,
} from './anchor.ts';

/** 측위 소스: sim(시뮬 자동 생성) 또는 live(실측 ingest만). */
export type SourceMode = 'sim' | 'live';

export const SOURCE_FLAGS: readonly string[] = ['--source'];

const DEFAULT_SOURCE: SourceMode = 'sim';

export interface ServerConfig {
  anchor: AnchorConfig;
  source: SourceMode;
}

export const SERVER_CONFIG_USAGE = `
사용법:
  npm start -- \\
    --main-anchor-id <ID> \\
    --sub-anchor-id <ID> \\
    --anchor-distance <미터> \\
    --half-plane <positive|negative> \\
    [--source <sim|live>] \\
    [--single-anchor-bearing <각도>]

옵션:
${ANCHOR_OPTION_LINES}
  --source           측위 소스 (기본 sim). sim=시뮬 자동 방출, live=실측 ingest만 방출
  --help             이 도움말 출력
`.trim();

export function wantsHelp(args: readonly string[]): boolean {
  return args.includes('--help') || args.includes('-h');
}

/**
 * argv를 소유자별로 나눠 해석한다.
 * 순서: 앵커 → 소스 → 남은 것은 알 수 없는 인자로 거절.
 */
export function parseServerConfig(args: readonly string[]): ServerConfig {
  const anchorSplit = takeFlags(args, ANCHOR_FLAGS);
  const sourceSplit = takeFlags(anchorSplit.rest, SOURCE_FLAGS);

  if (sourceSplit.rest.length > 0) {
    throw new Error(`알 수 없는 실행 인자: ${sourceSplit.rest[0]}`);
  }

  return {
    anchor: parseAnchorConfig(anchorSplit.taken),
    source: parseSource(sourceSplit.taken),
  };
}

// 오타를 조용히 삼키지 않는다. 예전에는 --source 값이 'live'가 아니면 무엇이든 sim으로
// 흘러서, --source liv 같은 오타가 아무 말 없이 시뮬 모드로 떨어졌다.
function parseSource(args: readonly string[]): SourceMode {
  if (args.length === 0) return DEFAULT_SOURCE;

  const [token, next] = args;
  const equalsAt = token.indexOf('=');
  const value = equalsAt >= 0 ? token.slice(equalsAt + 1) : next;

  if (value === undefined || !value.trim()) {
    throw new Error('실행 인자 값이 필요합니다: --source');
  }
  if (equalsAt < 0 && args.length > 2) {
    throw new Error('실행 인자가 중복되었습니다: --source');
  }
  if (equalsAt >= 0 && args.length > 1) {
    throw new Error('실행 인자가 중복되었습니다: --source');
  }

  const source = value.trim();
  if (source !== 'sim' && source !== 'live') {
    throw new Error('--source는 sim 또는 live여야 합니다.');
  }
  return source;
}
