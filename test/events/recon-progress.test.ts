import * as assert from 'node:assert/strict';
import test from 'node:test';

import { parseProgress, reportsProgress } from '../../server/events/recon/progress.ts';

const ctx = { targetFrames: 300, frameCount: 128, numIters: 30000 };

test('ffmpeg의 frame= 줄에서 뽑은 장수를 읽는다', () => {
  const p = parseProgress('frames', 'frame=37\nfps=12.0\n', ctx)!;
  assert.equal(p.done, 37);
  assert.equal(p.total, 300);
  assert.equal(p.percent, 12);
  assert.equal(p.label, '37/300장');
});

test('COLMAP 특징 추출 진행을 읽는다', () => {
  // 실제 로그: "I2026... feature_extraction.cc:270] Processed file [37/128]"
  const line = 'I20260801 23:10:59.060667 0x170a93000 feature_extraction.cc:270] Processed file [37/128]';
  const p = parseProgress('colmap:extract', line, ctx)!;
  assert.equal(p.done, 37);
  assert.equal(p.total, 128);
  assert.equal(p.percent, 29);
  assert.equal(p.label, '37/128장');
});

test('COLMAP 매칭 진행을 읽는다', () => {
  // 실제 로그: "... pairing.cc:485] Processing image [94/128]"
  const line = 'I20260801 23:11:14.128299 0x16b9af000 pairing.cc:485] Processing image [94/128]';
  const p = parseProgress('colmap:match', line, ctx)!;
  assert.equal(p.done, 94);
  assert.equal(p.percent, 73);
});

test('자세 계산은 등록 수를 읽되 총량을 단정하지 않는다', () => {
  // 실제 로그: "... Registering image #67 (num_reg_frames=42)"
  const line = 'I20260801 23:11:56 incremental_pipeline.cc:537] Registering image #67 (num_reg_frames=42)';
  const p = parseProgress('colmap:map', line, ctx)!;
  assert.equal(p.done, 42);
  assert.equal(p.total, 128, '뽑은 장수는 상한이지 목표가 아니다');
  assert.equal(p.label, '등록 42/128장');
});

test('프레임 수를 모르면 자세 계산은 %를 만들지 않는다', () => {
  const p = parseProgress('colmap:map', 'Registering image #5 (num_reg_frames=3)', { ...ctx, frameCount: 0 })!;
  assert.equal(p.percent, null, '없는 분모로 가짜 %를 만들지 않는다');
  assert.equal(p.label, '등록 3장');
});

test('OpenSplat이 준 %를 그대로 쓴다', () => {
  const p = parseProgress('opensplat', 'Step 660: 0.076039 (66%)', ctx)!;
  assert.equal(p.done, 660);
  assert.equal(p.percent, 66);
  assert.equal(p.label, '660/30000회');
});

test('한 덩어리에 여러 줄이 오면 마지막 것을 쓴다', () => {
  // 진행이 되감기면 화면이 튄다.
  const chunk = [
    'Processed file [10/128]',
    'Processed file [11/128]',
    'Processed file [12/128]',
  ].join('\n');
  assert.equal(parseProgress('colmap:extract', chunk, ctx)!.done, 12);

  const steps = 'Step 100: 0.2 (0%)\nStep 110: 0.2 (1%)\nStep 120: 0.19 (2%)';
  assert.equal(parseProgress('opensplat', steps, ctx)!.done, 120);
});

test('진행 줄이 없으면 null — 직전 값을 유지하라는 뜻이다', () => {
  assert.equal(parseProgress('colmap:extract', 'Creating SIFT GPU feature extractor\n', ctx), null);
  assert.equal(parseProgress('opensplat', 'Loading images...\n', ctx), null);
  assert.equal(parseProgress('frames', '', ctx), null);
});

test('진행을 안 찍는 단계는 파서를 두지 않는다', () => {
  assert.equal(reportsProgress('colmap:map'), true);
  assert.equal(reportsProgress('opensplat'), true);
  assert.equal(reportsProgress('probe'), false);
  assert.equal(parseProgress('probe', '64.0\n', ctx), null);
});

test('%는 0~100을 벗어나지 않는다', () => {
  // 목표보다 많이 뽑히는 경우가 있다(ffmpeg가 반올림으로 한 장 더 낸다).
  const over = parseProgress('frames', 'frame=305\n', { ...ctx, targetFrames: 300 })!;
  assert.equal(over.percent, 100);
  const odd = parseProgress('opensplat', 'Step 10: 0.2 (140%)', ctx)!;
  assert.equal(odd.percent, 100);
});
