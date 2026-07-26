// public/ 정적 파일 응답. 라우팅 표 없이 디스크 배치가 곧 URL이 된다.
// 파일을 추가·삭제해도 서버 코드는 손대지 않는다.

import * as fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { contentTypeOf, resolveStaticFile } from './resolve.ts';

export type StaticHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
) => boolean;

// 교차출처 격리 헤더. SharedArrayBuffer를 켜야 가우시안 스플랫 뷰어가 워커 공유메모리
// 정렬 경로를 쓴다(F3). 우리는 vendor 동봉이라 외부 출처 리소스를 하나도 안 받으므로
// require-corp가 아무것도 깨뜨리지 않는다 — 외부 CDN을 쓰려면 이 헤더부터 재검토해야 한다.
const ISOLATION_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
} as const;

// 처리했으면 true, 해당 파일이 없으면 false(호출부가 404를 낸다).
export function createStaticHandler(root: string): StaticHandler {
  const statFile = (file: string): fs.Stats | null => {
    try {
      const stat = fs.statSync(file);
      return stat.isFile() ? stat : null;
    } catch {
      return null;
    }
  };

  return function serveStatic(request, response, pathname) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return false;

    const file = resolveStaticFile(root, pathname, (f) => statFile(f) !== null);
    if (!file) return false;
    const stat = statFile(file);
    if (!stat) return false; // 해석 직후 사라진 경우

    // 매 요청 재검증하되 안 바뀌었으면 304. 수백 MB 스플랫 재다운로드를 막는다.
    const lastModified = stat.mtime.toUTCString();
    if (request.headers['if-modified-since'] === lastModified) {
      response.writeHead(304, {
        ...ISOLATION_HEADERS,
        'Last-Modified': lastModified,
        'Cache-Control': 'no-cache',
      });
      response.end();
      return true;
    }

    response.writeHead(200, {
      ...ISOLATION_HEADERS,
      'Content-Type': contentTypeOf(file),
      'Content-Length': String(stat.size),
      'Last-Modified': lastModified,
      'Cache-Control': 'no-cache',
    });
    if (request.method === 'HEAD') {
      response.end();
      return true;
    }

    // 통째로 메모리에 올리지 않고 흘려보낸다.
    const stream = fs.createReadStream(file);
    stream.on('error', () => response.destroy());
    stream.pipe(response);
    return true;
  };
}
