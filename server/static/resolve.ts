// 요청 경로 → public/ 아래 실제 파일 경로 해석(순수 함수).
// 파일 존재 확인은 exists로 주입받아 파일시스템 없이 테스트한다.

import * as path from 'node:path';

// 확장자 → Content-Type. 목록에 없으면 옥텟 스트림으로 내보낸다.
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  // 3D 가우시안 스플랫 에셋(F3). 표준 MIME이 없어 옥텟 스트림으로 보낸다.
  '.ply': 'application/octet-stream',
  '.splat': 'application/octet-stream',
  '.ksplat': 'application/octet-stream',
};

export function contentTypeOf(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

// 확장자 없는 경로에 붙여볼 후보. 페이지 추가는 public/에 .html을 두는 것으로 끝난다
// (예: public/login.html → /login, public/report/index.html → /report).
function candidatesFor(target: string, decoded: string): string[] {
  if (decoded.endsWith('/')) return [path.join(target, 'index.html')];
  if (path.extname(target)) return [target];
  return [target + '.html', path.join(target, 'index.html')];
}

export function resolveStaticFile(
  root: string,
  pathname: string,
  exists: (file: string) => boolean,
): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null; // 깨진 퍼센트 인코딩
  }
  if (decoded.includes('\0')) return null;

  // posix.normalize가 ..을 접고(절대경로라 root 위로는 못 올라간다),
  // 접두사 검사가 남은 탈출 경로를 최종 차단한다.
  const relative = path.posix.normalize('/' + decoded).slice(1);
  const target = path.resolve(root, relative);
  if (target !== root && !target.startsWith(root + path.sep)) return null;

  for (const candidate of candidatesFor(target, decoded)) {
    if (exists(candidate)) return candidate;
  }
  return null;
}
