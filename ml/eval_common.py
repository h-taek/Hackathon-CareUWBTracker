"""학습 스크립트 공용 — 분할(LOSO/LODO)·지표·기준선.

train.py(트리)와 train_cnn.py(딥러닝)가 사과 대 사과로 비교되도록 여기 한 곳에서
분할·지표를 정의한다. **의도적으로 numpy + sklearn.model_selection만 의존**한다:
xgboost/lightgbm(libomp)과 torch(자체 OpenMP)를 한 프로세스에 함께 올리면 macOS에서
OpenMP 이중 초기화로 segfault가 난다. 그래서 CNN 쪽이 train.py를 통째로 import하지
않도록 공용 코드를 이 모듈로 떼어낸다.
"""
from __future__ import annotations
import numpy as np
from sklearn.model_selection import GroupKFold, LeaveOneGroupOut

N_SPLITS = 5
BASELINE_SENS = 0.961   # 고전 candidate 민감도(§02 §6.1) — 특이도 비교 기준점


def make_splitter(mode, groups):
    """LOSO=subject 분리 5-fold / LODO=데이터셋 1개씩 빼는 leave-one-out."""
    if mode == "lodo":
        return LeaveOneGroupOut(), int(len(set(groups)))
    return GroupKFold(n_splits=N_SPLITS), N_SPLITS


def confusion(y, pred):
    """낙상=양성. (TP, FP, TN, FN)."""
    tp = int(np.sum((pred == 1) & (y == 1)))
    fp = int(np.sum((pred == 1) & (y == 0)))
    tn = int(np.sum((pred == 0) & (y == 0)))
    fn = int(np.sum((pred == 0) & (y == 1)))
    return tp, fp, tn, fn


def metrics_at(y, proba, thr):
    """임계 thr 적용 후 민감도·특이도·정밀도·헛경보·균형정확도·F1."""
    tp, fp, tn, fn = confusion(y, (proba >= thr).astype(int))
    sens = tp / (tp + fn) if tp + fn else 0.0            # 민감도(재현율)
    spec = tn / (tn + fp) if tn + fp else 0.0            # 특이도
    prec = tp / (tp + fp) if tp + fp else 0.0            # 정밀도
    far = fp / (fp + tn) if fp + tn else 0.0             # 헛경보율(=1-특이도)
    bal = (sens + spec) / 2                              # 균형정확도
    f1 = 2 * prec * sens / (prec + sens) if prec + sens else 0.0
    return dict(thr=thr, sens=sens, spec=spec, prec=prec, far=far, bal=bal, f1=f1,
                tp=tp, fp=fp, tn=tn, fn=fn)


def threshold_for_sensitivity(y, proba, target):
    """OOF 확률에서 민감도>=target을 만족하는 가장 높은 임계값.
    임계가 높을수록 특이도가 좋으므로, 목표 민감도를 지키는 최대 임계를 고른다."""
    pos = np.sort(proba[y == 1])                         # 낙상 샘플 확률 오름차순
    if len(pos) == 0:
        return 0.5
    k = int(np.floor((1.0 - target) * len(pos)))
    k = min(k, len(pos) - 1)
    return float(pos[k])


def fmt_row(label, mt):
    return (f"  {label:<16} 민감도 {mt['sens']*100:5.1f}%  특이도 {mt['spec']*100:5.1f}%  "
            f"정밀도 {mt['prec']*100:5.1f}%  헛경보 {mt['far']*100:5.1f}%  "
            f"균형 {mt['bal']*100:5.1f}%  F1 {mt['f1']*100:5.1f}%")
