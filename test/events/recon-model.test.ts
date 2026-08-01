import * as assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  MIN_POINTS,
  MIN_REGISTERED_IMAGES,
  judgeModel,
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
  assert.match(verdict.reason, /RECON_FPS/, '다음에 뭘 고칠지가 사유에 들어 있다');
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
