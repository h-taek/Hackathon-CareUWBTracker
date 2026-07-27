import * as assert from 'node:assert/strict';
import test from 'node:test';
import { pct, formatEvaluation, formatSweep } from '../../tools/report.ts';
import { evaluateTrials, sweepAll, type Sample, type TrialLike } from '../../tools/evaluate.ts';

interface TrialOptions {
  impactG?: number;
  isFall?: boolean;
  dataset?: string;
  placement?: string;
}

function trial({ impactG = 0, isFall = false, dataset = 'X', placement = 'waist' }: TrialOptions): TrialLike {
  const samples: Sample[] = [];
  for (let t = 0; t <= 6000; t += 20) {
    let g = 1;
    if (impactG && Math.abs(t - 1000) < 10) g = impactG;
    samples.push({ tMs: t, ax: 0, ay: 0, az: g });
  }
  return { dataset, placement, isFall, samples };
}

test('pct는 null을 대시로, 값을 퍼센트로', () => {
  assert.match(pct(null), /-/);
  assert.equal(pct(0.5).trim(), '50.0%');
});

test('formatEvaluation은 감지 섹션과 전체 행을 낸다', () => {
  const res = evaluateTrials([
    trial({ impactG: 3, isFall: true }),
    trial({ impactG: 0, isFall: false }),
  ]);
  const txt = formatEvaluation(res, { title: '테스트' });
  assert.match(txt, /DETECTED/);
  assert.doesNotMatch(txt, /CONFIRMED/, '승격 단계는 없어졌다');
  assert.match(txt, /전체/);
});

test('formatSweep은 각 파라미터와 기본값 표시를 낸다', () => {
  const trials = [trial({ impactG: 3, isFall: true }), trial({ impactG: 0, isFall: false })];
  const sweep = sweepAll(trials, { impactG: { values: [2.5, 3.5], affects: 'detected' } });
  const txt = formatSweep(sweep);
  assert.match(txt, /impactG/);
  assert.match(txt, /\*/); // 기본값 표시
});
