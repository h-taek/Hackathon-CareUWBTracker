import test from 'node:test';
import * as assert from 'node:assert';
import * as path from 'node:path';
import { contentTypeOf, resolveStaticFile } from '../../server/static/resolve.ts';

const ROOT = path.resolve('/srv/public');
const p = (...parts: string[]): string => path.join(ROOT, ...parts);

// 디스크에 있다고 가정할 파일 목록
const FILES = new Set([
  p('index.html'),
  p('login.html'),
  p('report', 'index.html'),
  p('assets', 'js', 'dashboard.js'),
  p('assets', 'css', 'base.css'),
  p('vendor', 'gaussian-splats-3d.js'),
  p('assets', 'scene.ply'),
]);
const exists = (file: string): boolean => FILES.has(file);

const resolve = (pathname: string): string | null => resolveStaticFile(ROOT, pathname, exists);

test('/ 는 index.html', () => {
  assert.strictEqual(resolve('/'), p('index.html'));
  assert.strictEqual(resolve('/index.html'), p('index.html'));
});

test('확장자 있는 경로는 그대로 매핑한다', () => {
  assert.strictEqual(resolve('/assets/js/dashboard.js'), p('assets', 'js', 'dashboard.js'));
  assert.strictEqual(resolve('/vendor/gaussian-splats-3d.js'), p('vendor', 'gaussian-splats-3d.js'));
  assert.strictEqual(resolve('/assets/scene.ply'), p('assets', 'scene.ply'));
});

// 페이지 추가는 public/에 파일을 두는 것으로 끝나야 한다(서버 코드 수정 없음).
test('확장자 없는 경로는 .html → 폴더/index.html 순으로 찾는다', () => {
  assert.strictEqual(resolve('/login'), p('login.html'));
  assert.strictEqual(resolve('/report'), p('report', 'index.html'));
  assert.strictEqual(resolve('/report/'), p('report', 'index.html'));
});

test('없는 경로는 null', () => {
  assert.strictEqual(resolve('/nope'), null);
  assert.strictEqual(resolve('/assets/js/none.js'), null);
  assert.strictEqual(resolve('/assets/'), null); // 디렉터리 목록은 내주지 않는다
});

test('상위 경로 탈출은 root 안으로 접힌다', () => {
  const escapes = ['/../index.html', '/../../etc/passwd', '/a/../../index.html', '/%2e%2e/%2e%2e/etc/passwd'];
  for (const pathname of escapes) {
    const file = resolveStaticFile(ROOT, pathname, () => true);
    assert.ok(
      file !== null && (file === ROOT || file.startsWith(ROOT + path.sep)),
      `${pathname} → ${file} 가 root 밖으로 나갔다`,
    );
  }
  // 탈출 경로로 실제 파일을 집어오지도 못한다
  assert.strictEqual(resolve('/../../etc/passwd'), null);
});

test('깨진 인코딩·널바이트는 거부한다', () => {
  assert.strictEqual(resolve('/%E0%A4%A'), null);
  assert.strictEqual(resolve('/index.html%00.png'), null);
});

test('Content-Type은 확장자로 정한다', () => {
  assert.strictEqual(contentTypeOf('a/b.html'), 'text/html; charset=utf-8');
  assert.strictEqual(contentTypeOf('a/b.CSS'), 'text/css; charset=utf-8');
  assert.strictEqual(contentTypeOf('a/b.js'), 'text/javascript; charset=utf-8');
  assert.strictEqual(contentTypeOf('a/scene.ply'), 'application/octet-stream');
  assert.strictEqual(contentTypeOf('a/unknown.xyz'), 'application/octet-stream');
});
