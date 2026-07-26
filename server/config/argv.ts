'use strict';

// argv를 소유자별로 나누는 도구. 각 설정 모듈은 자기 플래그만 받아서 해석하고,
// 아무도 안 가져간 인자는 상위(cli.ts)가 한 곳에서 거절한다.
//
// 이렇게 나눈 이유: 예전에는 parseAnchorConfig가 argv 전체를 받아 모르는 플래그를 전부
// 던졌다. 이름은 앵커 파서인데 argv 전체의 소유권을 쥐고 있어서, 서버에 옵션을 하나
// 추가할 때마다(--source가 그랬다) 앵커 파서가 먼저 죽이는 구조였다.

/** 이 프로젝트의 실행 인자는 전부 `--flag value` 또는 `--flag=value` 형태로 값 하나를 받는다. */
export interface FlagSplit {
  /** 지정한 플래그와 그 값들. 순서는 원본 그대로 */
  taken: string[];
  /** 나머지 전부. 다음 소유자에게 넘기거나, 남으면 알 수 없는 인자로 거절한다 */
  rest: string[];
}

/**
 * args에서 flagNames에 해당하는 플래그와 그 값을 뽑아낸다.
 *
 * 값은 다음 토큰이 `--`로 시작하지 않을 때만 함께 가져간다. `--anchor-distance --source`처럼
 * 값이 빠진 경우 `--source`를 삼키지 않고 rest에 남겨, 값 누락은 해당 파서가
 * 자기 오류 메시지로 알리고 `--source`는 제 소유자에게 정상적으로 도착한다.
 */
export function takeFlags(args: readonly string[], flagNames: readonly string[]): FlagSplit {
  const owned = new Set(flagNames);
  const taken: string[] = [];
  const rest: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    const equalsAt = token.indexOf('=');
    const flag = equalsAt >= 0 ? token.slice(0, equalsAt) : token;

    if (!owned.has(flag)) {
      rest.push(token);
      continue;
    }

    taken.push(token);
    if (equalsAt >= 0) continue; // --flag=value 는 한 토큰

    const value = args[index + 1];
    if (value !== undefined && !value.startsWith('--')) {
      taken.push(value);
      index += 1;
    }
  }

  return { taken, rest };
}
