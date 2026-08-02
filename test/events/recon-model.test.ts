import * as assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  MIN_POINTS,
  MIN_REGISTERED_IMAGES,
  judgeModel,
  pickBestModel,
  promoteModel,
  readModelStats,
} from '../../server/events/recon/model.ts';

/** COLMAP 이진 파일 흉내 — 머리 8바이트가 항목 수(uint64 LE)다. */
function writeModel(dir: string, images: number, points: number) {
  fs.mkdirSync(dir, { recursive: true });
  for (const [file, count] of [['images.bin', images], ['points3D.bin', points]] as const) {
    const buffer = Buffer.alloc(64);
    buffer.writeBigUInt64LE(BigInt(count), 0);
    fs.writeFileSync(path.join(dir, file), buffer);
  }
}

test('COLMAP 이진 파일 머리에서 등록 장수와 점 수를 읽는다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-'));
  writeModel(dir, 120, 8400);

  assert.deepEqual(readModelStats(dir), { registeredImages: 120, points: 8400 });
});

test('모델 폴더가 아예 없으면 0으로 읽는다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-'));
  assert.deepEqual(readModelStats(path.join(dir, '없음')), { registeredImages: 0, points: 0 });
});

test('머리 8바이트도 안 되는 파일은 0이다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'images.bin'), Buffer.alloc(3));
  assert.equal(readModelStats(dir).registeredImages, 0);
});

test('충분히 풀린 모델은 통과한다', () => {
  const verdict = judgeModel({ registeredImages: 150, points: 12000 }, 178);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.reason, '');
});

test('178장 중 2장만 등록된 실제 실패 사례를 잡는다', () => {
  // 실측(2026-08-01): 이 결과가 status=done으로 기록되고 쓸모없는 .ply가 나왔다.
  const verdict = judgeModel({ registeredImages: 2, points: 46 }, 178);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /자세를 거의 못 풀었다/);
  assert.match(verdict.reason, /178장 중 2장/);
  assert.match(verdict.reason, /벽을 따라 걸으며/, '다음에 뭘 고칠지가 사유에 들어 있다');
  assert.doesNotMatch(verdict.reason, /RECON_FPS/, '없는 환경변수를 안내하지 않는다');
});

test('절대 수는 넘겨도 비율이 낮으면 막는다', () => {
  // 200장 뽑아 20장만 풀렸다 — 절대 수는 8장을 넘지만 대부분 버려졌다.
  const verdict = judgeModel({ registeredImages: 20, points: 5000 }, 200);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /등록된 프레임이 너무 적다/);
});

test('장수는 충분한데 점이 모자라면 막는다', () => {
  const verdict = judgeModel({ registeredImages: 100, points: 50 }, 120);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /sparse 점이 너무 적어/);
});

test('경계값 — 최소 등록 장수와 최소 점수를 딱 채우면 통과한다', () => {
  const frames = Math.floor(MIN_REGISTERED_IMAGES / 0.3);
  assert.equal(judgeModel({ registeredImages: MIN_REGISTERED_IMAGES, points: MIN_POINTS }, frames).ok, true);
  assert.equal(judgeModel({ registeredImages: MIN_REGISTERED_IMAGES - 1, points: MIN_POINTS }, frames).ok, false);
  assert.equal(judgeModel({ registeredImages: MIN_REGISTERED_IMAGES, points: MIN_POINTS - 1 }, frames).ok, false);
});

test('프레임이 0장이면 비율 계산에서 터지지 않는다', () => {
  assert.equal(judgeModel({ registeredImages: 0, points: 0 }, 0).ok, false);
});

// ── 서브모델 고르기 ─────────────────────────────────────────────────────────
// COLMAP은 자세가 한 덩어리로 안 풀리면 서브모델을 여러 개 만들고 **완성 순서로**
// 번호를 매긴다. 크기순이 아니다. `0`만 읽으면 성공한 재구성을 실패로 판정한다.

test('실측 사례 — 0에 2장짜리 찌꺼기, 1에 진짜 결과 259장이면 1을 고른다', () => {
  // 2026-08-02 att-6: 300장 중 259장이 sparse/1에 풀렸는데 sparse/0만 읽어 실패로 기록됐다.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sparse-'));
  writeModel(path.join(root, '0'), 2, 854);
  writeModel(path.join(root, '1'), 259, 301085);
  writeModel(path.join(root, '2'), 23, 28734);
  writeModel(path.join(root, '3'), 11, 2854);

  const choice = pickBestModel(root);
  assert.equal(choice.name, '1');
  assert.equal(choice.registeredImages, 259);
  assert.equal(choice.points, 301085);
  assert.equal(choice.candidates.length, 4, '버린 후보도 로그에 남길 수 있게 들고 있는다');
});

test('0이 제일 크면 그대로 0을 고른다', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sparse-'));
  writeModel(path.join(root, '0'), 180, 40000);
  writeModel(path.join(root, '1'), 12, 900);

  assert.equal(pickBestModel(root).name, '0');
});

test('등록 장수가 같으면 점이 많은 쪽을 고른다', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sparse-'));
  writeModel(path.join(root, '0'), 50, 1000);
  writeModel(path.join(root, '1'), 50, 9000);

  assert.equal(pickBestModel(root).name, '1');
});

test('서브모델이 하나도 없으면 이름이 null이고 통계는 0이다', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sparse-'));
  assert.deepEqual(pickBestModel(root), {
    name: null, registeredImages: 0, points: 0, candidates: [],
  });
  assert.equal(pickBestModel(path.join(root, '없음')).name, null, 'sparse 폴더 자체가 없어도 안 터진다');
});

test('고른 모델을 0으로 올리면 0에서 그 모델이 읽힌다', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sparse-'));
  writeModel(path.join(root, '0'), 2, 854);
  writeModel(path.join(root, '1'), 259, 301085);

  promoteModel(root, '1');

  // OpenSplat은 sparse/0만 읽는다(colmap.cpp) — 거기에 진짜 결과가 있어야 한다.
  assert.equal(readModelStats(path.join(root, '0')).registeredImages, 259);
  // 밀려난 것도 남긴다. 로그와 대조할 수 있어야 한다.
  assert.equal(readModelStats(path.join(root, '1')).registeredImages, 2);
});

test('이미 0이 제일 좋으면 올리기는 아무것도 건드리지 않는다', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sparse-'));
  writeModel(path.join(root, '0'), 180, 40000);
  writeModel(path.join(root, '1'), 12, 900);

  promoteModel(root, '0');

  assert.equal(readModelStats(path.join(root, '0')).registeredImages, 180);
  assert.equal(readModelStats(path.join(root, '1')).registeredImages, 12);
});

test('0이 없으면 고른 모델을 그 자리로 옮긴다', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sparse-'));
  writeModel(path.join(root, '1'), 259, 301085);

  promoteModel(root, '1');

  assert.equal(readModelStats(path.join(root, '0')).registeredImages, 259);
});
