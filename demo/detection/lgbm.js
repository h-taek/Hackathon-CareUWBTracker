'use strict';

// LightGBM 이진분류 앙상블 추론(순수·무의존). 정본: ml/dump_lgbm.py가 덤프한 model-lgbm.json.
// raw = Σ(도달 리프값), proba = sigmoid(raw). ml/features.py의 특징벡터를 입력으로 받는다.
// 트리 평가식은 dump_lgbm.py self-check에서 sklearn predict_proba와 4e-16까지 일치 검증됨.

const fs = require('fs');
const path = require('path');
const { FEATURE_NAMES } = require('./features');

// 단일 트리 리프값. 노드: {f,t,dl,l,r} 내부 / {v} 리프. dl=default_left(결측 방향).
function evalTree(node, x) {
  while (node.v === undefined) {
    const xv = x[node.f];
    if (Number.isNaN(xv)) node = node.dl ? node.l : node.r;
    else node = xv <= node.t ? node.l : node.r;
  }
  return node.v;
}

function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }

// model: 파싱된 JSON 또는 파일경로(기본 동봉 model-lgbm.json).
function createModel(model) {
  let m = model;
  if (m == null) m = path.join(__dirname, 'model-lgbm.json');
  if (typeof m === 'string') m = JSON.parse(fs.readFileSync(m, 'utf8'));

  // 특징 순서 계약 검증 — Python 정본과 어긋나면 즉시 실패(조용한 오분류 방지).
  if (m.feature_names.length !== FEATURE_NAMES.length
      || m.feature_names.some((nm, i) => nm !== FEATURE_NAMES[i])) {
    throw new Error('model-lgbm.json feature_names가 features.js FEATURE_NAMES와 불일치');
  }
  const trees = m.trees;
  const threshold = m.threshold ?? 0.5;

  function proba(vec) {
    let raw = 0;
    for (let i = 0; i < trees.length; i += 1) raw += evalTree(trees[i], vec);
    return sigmoid(raw);
  }

  return {
    threshold,
    proba,
    predict(vec) { return proba(vec) >= threshold ? 1 : 0; },
  };
}

module.exports = { createModel, evalTree, sigmoid };
