'use strict';

// 골든테스트 — Node 특징추출·모델추론이 Python 정본과 동치인지 강제.
// 픽스처(__fixtures__/golden.json)는 ml/dump_lgbm.py가 실제 waist trial 원신호로 생성:
//   각 trial의 ax/ay/az(원신호) + Python이 계산한 19특징 + LightGBM 확률.
// 같은 원신호를 Node에 넣어 특징·확률이 일치하면 이식 성공. 재생성: .venv-ml/bin/python ml/dump_lgbm.py

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { computeFeatures, FEATURE_NAMES } = require('./features');
const { createModel } = require('./lgbm');

const golden = JSON.parse(fs.readFileSync(path.join(__dirname, '__fixtures__', 'golden.json'), 'utf8'));
const model = createModel();

// 특징: 크기·부호가 제각각이라 상대+절대 혼합 허용오차. 순수 산술 이식이라 매우 타이트해야 정상.
const FEAT_TOL = 1e-9;
const PROBA_TOL = 1e-9;

test('golden 픽스처가 비어있지 않다', () => {
  assert.ok(golden.length >= 12, `골든 trial ${golden.length}개 — 재생성 필요할 수 있음`);
});

test('Node 특징 == Python 특징 (전 trial × 19특징)', () => {
  for (const g of golden) {
    const f = computeFeatures(g.ax, g.ay, g.az);
    for (const name of FEATURE_NAMES) {
      const got = f[name];
      const exp = g.features[name];
      const diff = Math.abs(got - exp);
      const tol = FEAT_TOL * Math.max(1, Math.abs(exp));
      assert.ok(diff <= tol,
        `${g.dataset}(fall=${g.is_fall}) ${name}: Node ${got} vs Py ${exp} (Δ${diff.toExponential(2)})`);
    }
  }
});

test('Node LightGBM 확률 == Python 확률 (전 trial)', () => {
  for (const g of golden) {
    const f = computeFeatures(g.ax, g.ay, g.az);
    const vec = FEATURE_NAMES.map((k) => f[k]);
    const got = model.proba(vec);
    const diff = Math.abs(got - g.proba);
    assert.ok(diff <= PROBA_TOL,
      `${g.dataset}(fall=${g.is_fall}) proba: Node ${got} vs Py ${g.proba} (Δ${diff.toExponential(2)})`);
  }
});

test('모델이 낙상/ADL을 방향성 있게 가른다(sanity)', () => {
  const falls = golden.filter((g) => g.is_fall === 1).map((g) => g.proba);
  const adls = golden.filter((g) => g.is_fall === 0).map((g) => g.proba);
  const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  assert.ok(avg(falls) > avg(adls), `낙상 평균확률 ${avg(falls).toFixed(3)} <= ADL ${avg(adls).toFixed(3)}`);
});
