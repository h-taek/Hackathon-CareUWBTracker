// 사건 첨부에서 "지금 보여줄 것"을 고르는 규칙.
//
// 이 파일이 지키는 것은 하나다 — **첨부가 쌓여도 최신을 집는다.** 화면이 `find`로
// 첫 번째를 집던 때, 같은 사건에 3D를 두 번 뽑으면 두 번째가 영영 안 보였다.
// 첨부는 시간순으로 배열 뒤에 붙으므로 `find`는 언제나 가장 오래된 것을 준다.

import * as assert from 'node:assert/strict';
import test from 'node:test';

import { latestOf, pickScene, type SceneAttachment } from '../../server/public/assets/js/attachments.js';

const video = (id: string, uploadedAt: number, recon?: unknown): SceneAttachment => ({
  attachmentId: id, kind: 'video', uploadedAt, bytes: 1, ...(recon ? { recon } : {}),
});
const splat = (id: string, uploadedAt: number, source: string): SceneAttachment => ({
  attachmentId: id, kind: 'splat', uploadedAt, bytes: 1, sourceAttachmentId: source,
});

test('첨부가 없으면 고를 것도 없다', () => {
  assert.deepEqual(pickScene([]), { video: null, splat: null, source: null });
  assert.deepEqual(pickScene(undefined), { video: null, splat: null, source: null });
});

test('3D가 둘이면 최신을 집는다', () => {
  const picked = pickScene([
    video('v1', 100), splat('s1', 200, 'v1'),
    video('v2', 300), splat('s2', 400, 'v2'),
  ]);
  assert.equal(picked.splat?.attachmentId, 's2');
  assert.equal(picked.video?.attachmentId, 'v2');
});

test('영상이 여럿이고 3D가 없으면 최신 영상을 집는다', () => {
  const picked = pickScene([video('v1', 100), video('v2', 300), video('v3', 200)]);
  assert.equal(picked.video?.attachmentId, 'v2');
  assert.equal(picked.splat, null);
});

test('3D의 성적은 그것을 만든 영상에서 읽는다', () => {
  // v1은 아직 도는 중이고 v2가 3D를 냈다. 통계를 v1에서 읽으면 "등록 ?/?장"이 뜬다.
  const picked = pickScene([
    video('v1', 100, { status: 'running' }),
    video('v2', 300, { status: 'done', registeredImages: 92, frames: 300 }),
    splat('s2', 400, 'v2'),
  ]);
  assert.equal(picked.source?.attachmentId, 'v2');
  const recon = picked.source?.recon as { registeredImages?: number } | undefined;
  assert.equal(recon?.registeredImages, 92);
});

test('원본 영상이 사라진 3D는 source가 비어도 3D 자체는 고른다', () => {
  const picked = pickScene([splat('s1', 200, 'v-gone')]);
  assert.equal(picked.splat?.attachmentId, 's1');
  assert.equal(picked.source, null);
});

test('uploadedAt이 같으면 나중에 붙은 쪽이 최신이다', () => {
  const picked = pickScene([splat('s1', 200, 'v1'), splat('s2', 200, 'v2')]);
  assert.equal(picked.splat?.attachmentId, 's2');
});

test('uploadedAt이 없는 옛 기록도 순서로 판별한다', () => {
  const older = { attachmentId: 's1', kind: 'splat' };
  const newer = { attachmentId: 's2', kind: 'splat' };
  assert.equal(latestOf([older, newer], 'splat'), newer);
});

test('종류가 다른 첨부는 섞이지 않는다', () => {
  const list = [video('v1', 100), { attachmentId: 'p1', kind: 'photo', uploadedAt: 500 }];
  assert.equal(latestOf(list, 'video')?.attachmentId, 'v1');
  assert.equal(latestOf(list, 'splat'), null);
});
