import * as assert from 'node:assert/strict';
import test from 'node:test';
import {
  detectTrial, feedSamples, makeConfusion, evaluateTrials, sweepParam, type Sample, type TrialLike,
} from '../../tools/evaluate.ts';

interface TrialOptions {
  impactG?: number;
  impactAtMs?: number;
  quietMs?: number;
  hz?: number;
  isFall?: boolean;
  dataset?: string;
  placement?: string;
}

// 정지(1g) N개 + 충격 1개 + 정지 M개(초/ms). ax,ay는 0, az에 g 실어 magnitude=g.
function trial({ impactG = 0, impactAtMs = 1000, quietMs = 6000, hz = 50, isFall = false,
  dataset = 'X', placement = 'waist' }: TrialOptions): TrialLike {
  const samples: Sample[] = [];
  const dt = 1000 / hz;
  const total = quietMs;
  for (let t = 0; t <= total; t += dt) {
    let g = 1; // 정지 1g
    if (impactG && Math.abs(t - impactAtMs) < dt / 2) g = impactG; // 충격 순간 1샘플
    samples.push({ tMs: Math.round(t * 10) / 10, ax: 0, ay: 0, az: g });
  }
  return { dataset, placement, isFall, samples };
}

test('충격 2.5g 이상이면 감지', () => {
  assert.equal(detectTrial(feedSamples(trial({ impactG: 3.0 }).samples!)).detected, true);
});

test('충격 없으면 미감지', () => {
  assert.equal(detectTrial(feedSamples(trial({ impactG: 0 }).samples!)).detected, false);
});

test('충격 뒤 정지가 길게 이어져도 판정은 그대로 한 건이다', () => {
  // 예전에는 여기서 confirmed로 승격했다. 이제 승격 단계가 없다.
  const r = detectTrial(feedSamples(trial({ impactG: 3.0, impactAtMs: 500, quietMs: 7000 }).samples!));
  assert.equal(r.detected, true);
  assert.deepEqual(Object.keys(r), ['detected']);
});

test('충격이 impactG 미만이면 안 잡힌다(임계 스윕 효과)', () => {
  const s = trial({ impactG: 2.0 }).samples!;
  assert.equal(detectTrial(feedSamples(s), { impactG: 2.5 }).detected, false);
  assert.equal(detectTrial(feedSamples(s), { impactG: 1.5 }).detected, true);
});

test('혼동행렬 지표 계산', () => {
  const c = makeConfusion();
  c.add(true, true);   // tp
  c.add(true, false);  // fn
  c.add(false, false); // tn
  c.add(false, true);  // fp
  const m = c.metrics();
  assert.equal(m.tp, 1); assert.equal(m.fn, 1); assert.equal(m.tn, 1); assert.equal(m.fp, 1);
  assert.equal(m.sens, 0.5);
  assert.equal(m.spec, 0.5);
  assert.equal(m.fa, 0.5);
});

test('evaluateTrials가 전체+그룹 혼동행렬을 만든다', () => {
  const trials = [
    trial({ impactG: 3.0, isFall: true }),   // 낙상, 잡힘 -> tp
    trial({ impactG: 0, isFall: false }),    // ADL, 조용 -> tn
    trial({ impactG: 3.0, isFall: false, dataset: 'Y' }), // ADL인데 충격 -> fp
  ];
  const { overall, byGroup } = evaluateTrials(trials);
  const m = overall.metrics();
  assert.equal(m.tp, 1); assert.equal(m.tn, 1); assert.equal(m.fp, 1);
  assert.ok(byGroup.has('X|waist'));
  assert.ok(byGroup.has('Y|waist'));
});

test('sweepParam은 값마다 지표점을 만든다', () => {
  const trials = [trial({ impactG: 2.0, isFall: true })];
  const pts = sweepParam(trials, 'impactG', [1.5, 2.5]);
  assert.equal(pts.length, 2);
  assert.equal(pts[0].detected.tp, 1); // 1.5 임계 -> 2.0충격 잡음
  assert.equal(pts[1].detected.fn, 1); // 2.5 임계 -> 놓침
});
