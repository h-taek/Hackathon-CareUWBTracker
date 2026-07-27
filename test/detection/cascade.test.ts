// 캐스케이드(고전+AI) 배선 검증.
//  1) 게이트 로직: 주입 모델(고정 확률)로 억제/통과를 결정적으로 확인(데이터 운 배제).
//  2) 실모델: golden 낙상 원신호가 실제 LightGBM을 통과하는지.

import test from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { createCascadeDetector } from '../../server/detection/cascade.ts';
import { createFallDetector } from '../../server/detection/fall.ts';

const GRAVITY = 9.80665;
const golden = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'fixtures', 'golden.json'), 'utf8'));

// 합성 충격 스트림: 정지(1g) → 스파이크(spikeG) → 정지. 고전 1단계가 감지를 내게 만든다.
// 길이는 판정 지연(정점 뒤 1.5초 = 75샘플)을 넘겨야 한다. 20ms 간격 200샘플 = 4초.
function impactStream(spikeG = 3.0, n = 200, spikeAt = 40): number[] {
  const s: number[] = [];
  for (let i = 0; i < n; i += 1) s.push(i === spikeAt ? spikeG : 1.0);
  return s;
}

function feed(
  detector: { observe: (payload: { tagId: string; [key: string]: unknown }, position: { pos?: { x: number; y: number; z?: number } } | null) => Array<{ type: string }> },
  azSeq: number[],
  tagId = 't',
) {
  let detected = false;
  for (let i = 0; i < azSeq.length; i += 1) {
    const ev = detector.observe({ tagId, ts: i * 20, accel: { x: 0, y: 0, z: azSeq[i] * GRAVITY } }, null);
    for (const e of ev) if (e.type === 'fall_detected') detected = true;
  }
  return { detected };
}

const stub = (p: number) => ({ threshold: 0.5, proba: () => p });
const OPTS = { impactG: 2.0 };

test('사전조건: 합성 충격은 고전 단독에서 감지를 낸다', () => {
  const r = feed(createFallDetector(OPTS), impactStream());
  assert.ok(r.detected, '합성 스파이크가 고전 감지를 못 냄 — 임계 확인');
});

test('AI 확률 < 임계 → 감지 억제', () => {
  const r = feed(createCascadeDetector({ ...OPTS, model: stub(0.1) }), impactStream());
  assert.strictEqual(r.detected, false, 'AI가 기각했는데 이벤트가 전파됨');
});

test('AI 확률 >= 임계 → 감지 통과', () => {
  const r = feed(createCascadeDetector({ ...OPTS, model: stub(0.9) }), impactStream());
  assert.strictEqual(r.detected, true, 'AI가 통과시켰는데 이벤트가 안 나옴');
});

test('aiEnabled=false면 순수 고전과 동일', () => {
  const base = feed(createFallDetector(OPTS), impactStream());
  const off = feed(createCascadeDetector({ ...OPTS, aiEnabled: false }), impactStream());
  assert.strictEqual(off.detected, base.detected);
});

// 실모델 재생: g단위 golden 원신호를 스트림으로.
function replayReal(
  detector: { observe: (payload: { tagId: string; [key: string]: unknown }, position: { pos?: { x: number; y: number; z?: number } } | null) => Array<{ type: string; aiScore?: number }> },
  g: { ax: number[]; ay: number[]; az: number[] },
) {
  let detected = false; let ai = null;
  for (let i = 0; i < g.ax.length; i += 1) {
    const ev = detector.observe({
      tagId: 'r', ts: i * 20,
      accel: { x: g.ax[i] * GRAVITY, y: g.ay[i] * GRAVITY, z: g.az[i] * GRAVITY },
    }, null);
    for (const e of ev) if (e.type === 'fall_detected') { detected = true; ai = e.aiScore; }
  }
  return { detected, ai };
}

test('실 LightGBM: golden 낙상 다수가 감지를 통과한다', () => {
  const falls = golden.filter((g: { is_fall: number }) => g.is_fall === 1);
  let passed = 0;
  for (const g of falls) if (replayReal(createCascadeDetector(OPTS), g).detected) passed += 1;
  assert.ok(passed >= Math.ceil(falls.length * 0.6),
    `낙상 통과 ${passed}/${falls.length} — 게이트가 과하게 기각`);
});
