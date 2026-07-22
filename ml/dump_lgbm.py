"""확정 모델(LightGBM)을 Node 이식용으로 덤프 + 골든 픽스처 생성 (research 04).

산출:
  demo/detection/model-lgbm.json          트리 앙상블(간결 노드) + 특징순서 + 임계
  demo/detection/__fixtures__/golden.json  실제 trial 원신호 + Python 특징/확률(동치 검증용)

핵심: JS가 돌릴 트리 평가 로직을 Python으로 먼저 재현(eval_trees)해 sklearn predict_proba와
일치하는지 self-check한다. 여기서 맞으면 JS는 이 로직을 그대로 옮기기만 하면 된다.

사용: .venv-ml/bin/python ml/dump_lgbm.py
"""
from __future__ import annotations
import csv, json, math, os, sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import features as F
import train as T   # load(), make_models() 재사용 (torch 미로드 프로세스)

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
FEATURES_CSV = os.path.join(HERE, "_out", "features_waist.csv")
MASTER_CSV = os.path.join(HERE, "datasets", "_normalized", "falls_all_50hz.csv")
MODEL_OUT = os.path.join(REPO, "demo", "detection", "model-lgbm.json")
GOLDEN_OUT = os.path.join(REPO, "demo", "detection", "__fixtures__", "golden.json")

# 마스터 컬럼
DS, SUBJ, PLACE, ACT, TR, ISF, SRCHZ, TMS, AX, AY, AZ, SMV = range(12)
ROUND = 6          # 원신호 저장 소수자리 — Python 특징도 이 반올림 배열로 계산(양측 동일 입력 보장)


# ---------- LightGBM 트리 → 간결 노드 ----------

def conv(node):
    """LightGBM dump 노드 → {f,t,dl,l,r} 내부노드 / {v} 리프."""
    if "leaf_value" in node:
        return {"v": float(node["leaf_value"])}
    assert node.get("decision_type", "<=") == "<=", "수치 '<=' 분기만 지원(현재 특징 전부 수치)"
    return {
        "f": int(node["split_feature"]),
        "t": float(node["threshold"]),
        "dl": bool(node.get("default_left", True)),
        "l": conv(node["left_child"]),
        "r": conv(node["right_child"]),
    }


def eval_one(node, x):
    """단일 트리 리프값. JS가 그대로 옮길 로직."""
    while "v" not in node:
        xv = x[node["f"]]
        if math.isnan(xv):
            node = node["l"] if node["dl"] else node["r"]
        else:
            node = node["l"] if xv <= node["t"] else node["r"]
    return node["v"]


def eval_trees(trees, x):
    """앙상블 raw 합 → 시그모이드 확률."""
    raw = sum(eval_one(t, x) for t in trees)
    return 1.0 / (1.0 + math.exp(-raw))


# ---------- 골든 픽스처: 실제 trial 원신호 샘플 ----------

def sample_trials(path, per_class_per_ds=2, cap=600):
    """placement=waist에서 데이터셋별 낙상/ADL 각 N개 trial의 원신호를 모은다."""
    want_place = "waist"
    buckets = {}            # (ds, isf) -> count
    cur_key, meta, ax_b, ay_b, az_b = None, None, [], [], []
    out = []

    def flush():
        if meta is None:
            return
        ds, isf = meta
        k = (ds, isf)
        if buckets.get(k, 0) >= per_class_per_ds or len(ax_b) < F.WINDOW // 2:
            return
        buckets[k] = buckets.get(k, 0) + 1
        ax = np.round(np.array(ax_b[:cap]), ROUND)
        ay = np.round(np.array(ay_b[:cap]), ROUND)
        az = np.round(np.array(az_b[:cap]), ROUND)
        out.append({"dataset": ds, "is_fall": int(isf),
                    "ax": ax.tolist(), "ay": ay.tolist(), "az": az.tolist()})

    with open(path, newline="") as f:
        r = csv.reader(f); next(r)
        for row in r:
            if len(row) < 12 or row[PLACE] != want_place:
                continue
            key = (row[DS], row[SUBJ], row[ACT], row[TR])
            if key != cur_key:
                flush()
                cur_key = key
                meta = (row[DS], row[ISF])
                ax_b, ay_b, az_b = [], [], []
            try:
                ax_b.append(float(row[AX])); ay_b.append(float(row[AY])); az_b.append(float(row[AZ]))
            except ValueError:
                pass
        flush()
    return out


def main():
    # 1) 전체 데이터로 최종 LightGBM 학습(홀드아웃 없음 — 배포 모델)
    X, y, groups, dsets, names = T.load(FEATURES_CSV)
    n_pos, n_neg = int(y.sum()), int((y == 0).sum())
    model = T.make_models(n_pos, n_neg)["LightGBM"]()
    model.fit(X, y)
    print(f"[dump] LightGBM 학습 완료: {len(y)} rows, {model.n_estimators} trees")

    # 2) 트리 덤프 → 간결 노드
    dump = model.booster_.dump_model()
    trees = [conv(ti["tree_structure"]) for ti in dump["tree_info"]]

    # 3) self-check: JS-스타일 eval_trees vs sklearn predict_proba (전 행)
    proba_sk = model.predict_proba(X)[:, 1]
    proba_js = np.array([eval_trees(trees, X[i]) for i in range(len(X))])
    max_err = float(np.max(np.abs(proba_sk - proba_js)))
    print(f"[dump] self-check max|predict_proba - eval_trees| = {max_err:.2e}")
    assert max_err < 1e-9, "트리 평가 로직이 sklearn과 불일치 — base offset 등 확인 필요"

    os.makedirs(os.path.dirname(MODEL_OUT), exist_ok=True)
    with open(MODEL_OUT, "w") as f:
        json.dump({
            "model": "lightgbm-binary",
            "note": "raw=sum(leaf_values); proba=sigmoid(raw). research 04.",
            "feature_names": names,
            "threshold": 0.5,
            "n_trees": len(trees),
            "trees": trees,
        }, f)
    print(f"[dump] -> {MODEL_OUT}  ({os.path.getsize(MODEL_OUT)//1024} KB)")

    # 4) 골든 픽스처: 실제 trial 원신호 + Python 특징/확률
    samples = sample_trials(MASTER_CSV)
    golden = []
    for s in samples:
        ax = np.array(s["ax"]); ay = np.array(s["ay"]); az = np.array(s["az"])
        vec = F.feature_vector(ax, ay, az)
        golden.append({
            "dataset": s["dataset"], "is_fall": s["is_fall"],
            "ax": s["ax"], "ay": s["ay"], "az": s["az"],
            "features": {names[i]: float(vec[i]) for i in range(len(names))},
            "proba": eval_trees(trees, vec),
        })
    os.makedirs(os.path.dirname(GOLDEN_OUT), exist_ok=True)
    with open(GOLDEN_OUT, "w") as f:
        json.dump(golden, f)
    n_fall = sum(g["is_fall"] for g in golden)
    print(f"[dump] -> {GOLDEN_OUT}  ({len(golden)} trials, 낙상 {n_fall}/ADL {len(golden)-n_fall}, "
          f"{os.path.getsize(GOLDEN_OUT)//1024} KB)")


if __name__ == "__main__":
    main()
