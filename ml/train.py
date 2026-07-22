"""GroupKFold LOSO 학습·비교 — XGBoost·LightGBM·로지스틱 (research 02 §6).

extract.py가 산출한 특징표를 subject 분리 5-fold로 학습하고, out-of-fold(OOF)
예측을 모아 데이터셋 전체에 대한 정직한 혼동행렬 1개를 낸다. 고전 베이스라인
(§6.1 candidate 민감도 96.1%/특이도 79.2%)이 AI가 넘어야 할 기준선이다.

핵심 비교 축 3가지:
  (1) ROC-AUC       — 임계값과 무관한 분리력. 모델 우열의 주력 지표.
  (2) @0.5          — 기본 임계 성적(민감도/특이도/정밀도/헛경보).
  (3) @민감도 96.1% — 고전과 같은 민감도로 임계를 맞췄을 때 특이도.
                      "같은 민감도에서 헛경보를 줄이나?"가 하이브리드 2단계의 존재 이유.

사용:
  .venv-ml/bin/python ml/train.py --features ml/_out/features_waist.csv
옵션:
  --exclude-dataset KFall   특정 데이터셋 제외(베이스라인과 집합 맞추기)
  --report ml/_out/train_report.txt   요약 저장(기본 저장 안 함)
"""
from __future__ import annotations
import argparse, csv, os, sys

import numpy as np
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from xgboost import XGBClassifier
from lightgbm import LGBMClassifier

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import features as F
# 분할·지표·기준선은 공용 모듈(부스팅/torch 미의존)에서 — train_cnn.py와 단일 진실 공유
from eval_common import (N_SPLITS, BASELINE_SENS, make_splitter,  # noqa: F401
                         confusion, metrics_at, threshold_for_sensitivity, fmt_row)

SEED = 42


# ---------- 데이터 ----------

def load(path, exclude=None):
    """특징표 → (X, y, groups, dataset, names). 결측/비유한 행은 스킵."""
    names = list(F.FEATURE_NAMES)
    X, y, groups, dsets = [], [], [], []
    with open(path, newline="") as f:
        r = csv.DictReader(f)
        for row in r:
            if exclude and row["dataset"] == exclude:
                continue
            try:
                v = [float(row[k]) for k in names]
            except (KeyError, ValueError):
                continue
            if not all(np.isfinite(v)):
                continue
            X.append(v)
            y.append(int(row["is_fall"]))
            groups.append(row["subject"])
            dsets.append(row["dataset"])
    return (np.asarray(X, dtype=np.float64), np.asarray(y, dtype=np.int64),
            np.asarray(groups), np.asarray(dsets), names)


# ---------- 모델 ----------

def make_models(n_pos, n_neg):
    spw = n_neg / max(n_pos, 1)                          # 불균형 보정(양성 가중)
    return {
        "XGBoost": lambda: XGBClassifier(
            n_estimators=400, max_depth=4, learning_rate=0.05,
            subsample=0.8, colsample_bytree=0.8, reg_lambda=1.0,
            scale_pos_weight=spw, eval_metric="logloss",
            random_state=SEED, n_jobs=-1, verbosity=0),
        "LightGBM": lambda: LGBMClassifier(
            n_estimators=400, num_leaves=31, max_depth=-1, learning_rate=0.05,
            subsample=0.8, subsample_freq=1, colsample_bytree=0.8, reg_lambda=1.0,
            scale_pos_weight=spw, random_state=SEED, n_jobs=-1, verbose=-1),
        "로지스틱": lambda: make_pipeline(
            StandardScaler(),
            LogisticRegression(max_iter=2000, class_weight="balanced",
                               random_state=SEED)),
    }


def oof_predict(make_model, X, y, split_groups, splitter):
    """분할 그룹 기준 OOF 확률 + 각 샘플의 fold 번호."""
    oof = np.zeros(len(y))
    fold = np.full(len(y), -1)
    for k, (tr, te) in enumerate(splitter.split(X, y, split_groups)):
        m = make_model()
        m.fit(X[tr], y[tr])
        oof[te] = m.predict_proba(X[te])[:, 1]
        fold[te] = k
    return oof, fold


def feature_importance(make_model, X, y, names):
    """전체 데이터로 한 번 적합 → gain 기반 중요도(트리 전용)."""
    m = make_model()
    m.fit(X, y)
    imp = getattr(m, "feature_importances_", None)
    if imp is None:
        return None
    order = np.argsort(imp)[::-1]
    return [(names[i], float(imp[i])) for i in order]


# ---------- 출력 ----------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--features", default="ml/_out/features_waist.csv")
    ap.add_argument("--mode", choices=["loso", "lodo"], default="loso",
                    help="loso=subject 분리(처음 보는 사람) / lodo=데이터셋 분리(처음 보는 센서)")
    ap.add_argument("--exclude-dataset", default=None)
    ap.add_argument("--report", default=None)
    args = ap.parse_args()

    X, y, groups, dsets, names = load(args.features, exclude=args.exclude_dataset)
    n_pos, n_neg = int(y.sum()), int((y == 0).sum())
    split_groups = dsets if args.mode == "lodo" else groups
    splitter, n_folds = make_splitter(args.mode, split_groups)
    lines = []

    def out(s=""):
        print(s)
        lines.append(s)

    out(f"[data] {args.features}")
    if args.exclude_dataset:
        out(f"[data] '{args.exclude_dataset}' 제외")
    out(f"[data] {len(y)} trial  (낙상 {n_pos} / ADL {n_neg})  "
        f"subject {len(set(groups))}  dataset {len(set(dsets))}")
    if args.mode == "lodo":
        out(f"[eval] LODO {n_folds}-fold (데이터셋 1개씩 홀드아웃) — '처음 보는 센서' 일반화 시험")
    else:
        out(f"[eval] GroupKFold {N_SPLITS}-fold LOSO (group=subject), OOF 예측 집계")
    out(f"[ref ] 고전 베이스라인 candidate: 민감도 96.1% / 특이도 79.2% / 균형 87.7% (§6.1)")
    out("       ※ 베이스라인은 7종·10,808 waist trial, 여기 특징표는 KFall 포함 → 집합 불일치(참고선)")
    out("")

    models = make_models(n_pos, n_neg)
    summary = {}
    for name, mk in models.items():
        oof, fold = oof_predict(mk, X, y, split_groups, splitter)
        auc = roc_auc_score(y, oof)
        m05 = metrics_at(y, oof, 0.5)
        thr_s = threshold_for_sensitivity(y, oof, BASELINE_SENS)
        msens = metrics_at(y, oof, thr_s)
        summary[name] = dict(auc=auc, m05=m05, msens=msens, oof=oof, fold=fold)

        out(f"── {name}  (ROC-AUC {auc:.4f}) ─────────────────────────")
        out(fmt_row("@0.5", m05))
        out(fmt_row(f"@민감도≈96.1%", msens) + f"   (임계 {thr_s:.3f})")
        # fold별 균형정확도 분산(과적합/편차 감지). LODO는 홀드아웃 데이터셋명으로 라벨.
        bals = []
        for k in range(n_folds):
            mask = fold == k
            if mask.sum():
                lab = dsets[mask][0] if args.mode == "lodo" else str(k)
                bals.append((lab, metrics_at(y[mask], oof[mask], 0.5)["bal"]))
        out(f"  fold별 균형정확도(@0.5): " +
            "  ".join(f"{lab}:{b*100:.1f}" for lab, b in bals) +
            f"   (평균 {np.mean([b for _, b in bals])*100:.1f}"
            f" ± {np.std([b for _, b in bals])*100:.1f})")
        out("")

    # 특징 중요도 (트리)
    out("── 특징 중요도 (gain, 전체적합) ─────────────────────────")
    for name in ("XGBoost", "LightGBM"):
        fi = feature_importance(models[name], X, y, names)
        if fi:
            top = "  ".join(f"{n}:{v:.2f}" for n, v in fi[:8])
            out(f"  [{name}] {top}")
    out("")

    # 데이터셋별 AI 성적 (최우수 AUC 모델의 OOF, @0.5)
    best = max(summary, key=lambda k: summary[k]["auc"])
    oof = summary[best]["oof"]
    out(f"── 데이터셋별 성적 ({best} OOF @0.5) ─────────────────────")
    for ds in sorted(set(dsets)):
        mask = dsets == ds
        if mask.sum() == 0 or y[mask].sum() == 0:
            continue
        mt = metrics_at(y[mask], oof[mask], 0.5)
        out(f"  {ds:<10} n={mask.sum():<5} "
            f"민감도 {mt['sens']*100:5.1f}%  특이도 {mt['spec']*100:5.1f}%  "
            f"균형 {mt['bal']*100:5.1f}%")
    out("")
    out(f"[best] AUC 최우수: {best} ({summary[best]['auc']:.4f})")

    if args.report:
        os.makedirs(os.path.dirname(args.report), exist_ok=True)
        with open(args.report, "w") as f:
            f.write("\n".join(lines) + "\n")
        print(f"[report] -> {args.report}")


if __name__ == "__main__":
    main()
