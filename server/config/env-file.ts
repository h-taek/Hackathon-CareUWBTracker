// 설정 파일(`server/.env`) 읽기. **진입점이 스스로 읽는다.**
//
// 이 서버는 런타임 의존성이 없어 `node server/server.ts`로 바로 뜬다. 그래서 실행을 npm
// 스크립트로 감싸지 않는데, 감싸지 않으면 `--env-file-if-exists` 같은 플래그를 사람이 매번
// 손으로 적어야 한다. 진입점이 직접 읽으면 실행 명령이 인자만 남는다.
//
// **반드시 진입점 본문의 첫머리에서 부른다.** 임포트된 모듈이 최상위에서 `process.env`를
// 읽으면 그쪽이 먼저 실행되어 설정이 반영되기 전 값으로 굳는다. 지금은 모든 설정 읽기가
// 함수 안이거나 진입점 본문에 있어 안전하다.

import * as fs from 'node:fs';
import * as path from 'node:path';

export const ENV_FILE_NAME = '.env';

export interface LoadEnvFileOptions {
  /** 테스트가 갈아끼운다. 기본은 Node 내장 로더다. */
  load?: (file: string) => void;
  exists?: (file: string) => boolean;
}

/**
 * `dir/.env`가 있으면 읽고 그 경로를, 없으면 `null`을 돌려준다.
 *
 * 없는 것은 정상이다 — 파일을 만들지 않으면 전 항목이 기본값으로 동작한다. `process.loadEnvFile`은
 * 없는 파일에 ENOENT를 던지므로 여기서 존재를 먼저 본다.
 *
 * **셸에서 준 환경 변수가 파일보다 우선한다**(Node 기본 동작). 한 번만 다르게 띄울 때
 * 파일을 고치지 않아도 되는 자리다.
 */
export function loadEnvFile(dir: string, options: LoadEnvFileOptions = {}): string | null {
  const exists = options.exists ?? fs.existsSync;
  const load = options.load ?? ((file: string) => process.loadEnvFile(file));

  const file = path.join(dir, ENV_FILE_NAME);
  if (!exists(file)) return null;

  load(file);
  return file;
}
