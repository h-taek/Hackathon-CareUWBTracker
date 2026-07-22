// LightGBM 이진분류 앙상블 추론(순수·무의존). 정본: ml/dump_lgbm.py가 덤프한 model-lgbm.json.
// raw = Σ(도달 리프값), proba = sigmoid(raw). ml/features.py의 특징벡터를 입력으로 받는다.
// 트리 평가식은 dump_lgbm.py self-check에서 sklearn predict_proba와 4e-16까지 일치 검증됨.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { FEATURE_NAMES } from './features.ts';

// 단일 트리 노드. 내부 노드: {f,t,dl,l,r} / 리프: {v}. dl=default_left(결측 방향).
interface TreeNode {
  v?: number;
  f?: number;
  t?: number;
  dl?: boolean;
  l?: TreeNode;
  r?: TreeNode;
}

interface ModelJson {
  feature_names: string[];
  trees: TreeNode[];
  threshold?: number;
}

function evalTree(node: TreeNode, x: number[]): number {
  while (node.v === undefined) {
    const xv = x[node.f as number];
    if (Number.isNaN(xv)) node = node.dl ? (node.l as TreeNode) : (node.r as TreeNode);
    else node = xv <= (node.t as number) ? (node.l as TreeNode) : (node.r as TreeNode);
  }
  return node.v;
}

function sigmoid(z: number): number { return 1 / (1 + Math.exp(-z)); }

// model: 파싱된 JSON 또는 파일경로(기본 동봉 model-lgbm.json).
function createModel(model?: string | ModelJson | null) {
  let m: string | ModelJson | null | undefined = model;
  if (m == null) m = path.join(import.meta.dirname, 'model-lgbm.json');
  let parsed: ModelJson;
  if (typeof m === 'string') parsed = JSON.parse(fs.readFileSync(m, 'utf8'));
  else parsed = m;

  // 특징 순서 계약 검증 — Python 정본과 어긋나면 즉시 실패(조용한 오분류 방지).
  if (parsed.feature_names.length !== FEATURE_NAMES.length
      || parsed.feature_names.some((nm, i) => nm !== FEATURE_NAMES[i])) {
    throw new Error('model-lgbm.json feature_names가 features.js FEATURE_NAMES와 불일치');
  }
  const trees = parsed.trees;
  const threshold = parsed.threshold ?? 0.5;

  function proba(vec: number[]): number {
    let raw = 0;
    for (let i = 0; i < trees.length; i += 1) raw += evalTree(trees[i], vec);
    return sigmoid(raw);
  }

  return {
    threshold,
    proba,
    predict(vec: number[]): number { return proba(vec) >= threshold ? 1 : 0; },
  };
}

export { createModel, evalTree, sigmoid };
