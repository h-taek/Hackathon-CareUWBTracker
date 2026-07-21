"""1D-CNN 학습·비교 — 원시 충격 창 입력 (research 04 §5, 딥러닝 후보).

트리 3종(train.py)이 사람이 정한 특징 19개를 먹는 것과 달리, 1D-CNN은 충격 정렬
창(150샘플)을 통째로 받아 특징을 스스로 학습한다. 분할(LOSO/LODO)·지표·기준선은
train.py 것을 그대로 재사용해 트리와 사과 대 사과로 비교한다.

■ 입력 채널 — 방향불변이 기본 (중요)
  원시 3축(ax/ay/az)을 그대로 넣으면 데이터셋마다 센서 장착 방향이 달라 "방향 지문"이
  섞여 LODO(낯선 센서) 성능이 부풀거나 무너진다(트리에서 축별 C그룹을 보류한 이유와 동일).
  그래서 기본 채널을 방향불변으로 구성한다:
    ch0 = SMV(t)                         신호크기(방향 무관)
    ch1..3 = sort(|ax|,|ay|,|az|) 내림차순  시점별 축 에너지 배분(라벨 순서라 방향 무관)
  --raw-xyz 로 원시 3축을 쓸 수 있으나 LODO 누수 위험을 감수하는 실험 모드다.

■ 실행 (torch 필요: uv pip install --python .venv-ml/bin/python torch)
  .venv-ml/bin/python ml/train_cnn.py --mode loso
  .venv-ml/bin/python ml/train_cnn.py --mode lodo --report ml/_out/train_cnn_lodo.txt
"""
from __future__ import annotations
import argparse, csv, os, sys, time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import features as F
# 분할·지표·기준선은 공용 모듈에서. train.py를 import하면 xgboost/lightgbm(libomp)이
# torch와 한 프로세스에 올라 macOS OpenMP 이중 초기화 → segfault. 그래서 공용만 가져온다.
import eval_common as T

# 마스터 CSV 컬럼: dataset,subject,placement,activity,trial,is_fall,src_hz,t_ms,ax,ay,az,smv
DS, SUBJ, PLACE, ACT, TR, ISF, SRCHZ, TMS, AX, AY, AZ, SMV = range(12)
MIN_SAMPLES = 3
SEED = 42


# ---------- 원시 창 데이터셋 ----------

def _channels(wax, way, waz, smv, raw_xyz):
    """trial 창 → (C, WINDOW). 기본 방향불변 4채널 / raw_xyz면 원시 3채널."""
    if raw_xyz:
        return np.vstack([wax, way, waz]).astype(np.float32)          # (3, W)
    mags = np.abs(np.vstack([wax, way, waz]))                         # (3, W)
    srt = np.sort(mags, axis=0)[::-1]                                 # 내림차순 정렬(축 라벨 제거)
    return np.vstack([smv[None, :], srt]).astype(np.float32)          # (4, W)


def load_windows(path, placement, raw_xyz):
    """마스터 CSV 스트리밍 → trial별 충격 창 → (X[N,C,W], y, groups, dsets)."""
    want = None if placement == "all" else placement
    X, y, groups, dsets = [], [], [], []
    cur_key, meta, ax_b, ay_b, az_b = None, None, [], [], []

    def flush():
        if meta is None or len(ax_b) < MIN_SAMPLES:
            return
        wax, way, waz, smv = F.extract_window(np.array(ax_b), np.array(ay_b), np.array(az_b))
        X.append(_channels(wax, way, waz, smv, raw_xyz))
        ds, subj, isf = meta
        y.append(int(isf)); groups.append(subj); dsets.append(ds)

    with open(path, newline="") as f:
        r = csv.reader(f)
        next(r)
        for row in r:
            if len(row) < 12 or (want is not None and row[PLACE] != want):
                continue
            key = (row[DS], row[SUBJ], row[ACT], row[TR])
            if key != cur_key:
                flush()
                cur_key = key
                meta = (row[DS], row[SUBJ], row[ISF])
                ax_b, ay_b, az_b = [], [], []
            try:
                ax_b.append(float(row[AX])); ay_b.append(float(row[AY])); az_b.append(float(row[AZ]))
            except ValueError:
                pass
        flush()

    return (np.stack(X), np.asarray(y, dtype=np.int64),
            np.asarray(groups), np.asarray(dsets))


# ---------- 모델 ----------

def build_model(torch, nn, in_ch):
    class FallCNN(nn.Module):
        def __init__(self, c):
            super().__init__()
            self.net = nn.Sequential(
                nn.Conv1d(c, 32, 7, padding=3), nn.BatchNorm1d(32), nn.ReLU(), nn.MaxPool1d(2),
                nn.Conv1d(32, 64, 5, padding=2), nn.BatchNorm1d(64), nn.ReLU(), nn.MaxPool1d(2),
                nn.Conv1d(64, 128, 3, padding=1), nn.BatchNorm1d(128), nn.ReLU(),
                nn.AdaptiveAvgPool1d(1),
            )
            self.head = nn.Sequential(nn.Flatten(), nn.Dropout(0.3), nn.Linear(128, 1))

        def forward(self, x):
            return self.head(self.net(x)).squeeze(1)   # 로짓(N,)

    return FallCNN(in_ch)


def pick_device(torch, choice="auto"):
    """choice=auto면 cuda>mps>cpu 순으로 가속기 우선. --device로 강제도 허용.
    (초기 MPS segfault는 OpenMP 이중 초기화가 원인이었고 eval_common 분리로 해소됨.)"""
    if choice != "auto":
        return torch.device(choice)
    if torch.cuda.is_available():
        return torch.device("cuda")
    if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


def train_one_fold(torch, nn, Xtr, ytr, Xte, epochs, batch, lr, device, log, tag):
    """한 fold 학습 → 홀드아웃 확률(sigmoid). 표준화는 train 통계만 사용(누수 차단).
    log(콜백)로 에폭별 평균 loss를 찍어 runtime 진행을 보이게 한다."""
    # 채널별 표준화: train에서 mean/std 산출 → train/test 공통 적용
    mu = Xtr.mean(axis=(0, 2), keepdims=True)
    sd = Xtr.std(axis=(0, 2), keepdims=True) + 1e-6
    Xtr = (Xtr - mu) / sd
    Xte = (Xte - mu) / sd

    n_pos = int(ytr.sum()); n_neg = int((ytr == 0).sum())
    pos_weight = torch.tensor([n_neg / max(n_pos, 1)], device=device)

    model = build_model(torch, nn, Xtr.shape[1]).to(device)
    opt = torch.optim.Adam(model.parameters(), lr=lr, weight_decay=1e-4)
    loss_fn = nn.BCEWithLogitsLoss(pos_weight=pos_weight)

    xt = torch.tensor(Xtr, dtype=torch.float32)
    yt = torch.tensor(ytr, dtype=torch.float32)
    ds = torch.utils.data.TensorDataset(xt, yt)
    gen = torch.Generator().manual_seed(SEED)
    dl = torch.utils.data.DataLoader(ds, batch_size=batch, shuffle=True, generator=gen)

    # 에폭 로그는 촘촘하면 시끄러워 5회(또는 마지막)마다만. 첫 에폭은 항상 찍어 살아있음 표시.
    every = max(1, epochs // 6)
    model.train()
    for ep in range(1, epochs + 1):
        run_loss = n_seen = 0.0
        for xb, yb in dl:
            xb, yb = xb.to(device), yb.to(device)
            opt.zero_grad()
            loss = loss_fn(model(xb), yb)
            loss.backward()
            opt.step()
            run_loss += loss.item() * len(xb); n_seen += len(xb)
        if ep == 1 or ep % every == 0 or ep == epochs:
            log(f"    {tag} epoch {ep:>2}/{epochs}  loss {run_loss / n_seen:.4f}")

    model.eval()
    with torch.no_grad():
        xe = torch.tensor(Xte, dtype=torch.float32).to(device)
        proba = torch.sigmoid(model(xe)).cpu().numpy()
    return proba


def oof_cnn(torch, nn, X, y, split_groups, splitter, epochs, batch, lr, device, out, dsets, mode):
    oof = np.zeros(len(y)); fold = np.full(len(y), -1)
    for k, (tr, te) in enumerate(splitter.split(X, y, split_groups)):
        t0 = time.time()
        # 홀드아웃 라벨: LODO는 데이터셋명, LOSO는 fold 번호
        hold = dsets[te][0] if mode == "lodo" else f"fold{k}"
        out(f"  [{hold}] 학습 시작  train {len(tr)} / test {len(te)}")
        oof[te] = train_one_fold(torch, nn, X[tr], y[tr], X[te],
                                 epochs, batch, lr, device, out, hold)
        fold[te] = k
        out(f"  [{hold}] 완료  {time.time()-t0:.1f}s")
    return oof, fold


# ---------- main ----------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--features-csv", default="ml/datasets/_normalized/falls_all_50hz.csv",
                    help="원시 창을 뜰 마스터 CSV(특징표가 아니라 원신호)")
    ap.add_argument("--placement", default="waist")
    ap.add_argument("--mode", choices=["loso", "lodo"], default="loso")
    ap.add_argument("--raw-xyz", action="store_true", help="원시 3축 입력(LODO 누수 위험)")
    ap.add_argument("--device", choices=["auto", "cpu", "mps", "cuda"], default="auto",
                    help="auto=cuda>mps>cpu. Apple Silicon은 mps(GPU) 사용")
    ap.add_argument("--epochs", type=int, default=30)
    ap.add_argument("--batch", type=int, default=128)
    ap.add_argument("--lr", type=float, default=1e-3)
    ap.add_argument("--report", default=None)
    args = ap.parse_args()

    try:
        import torch
        from torch import nn
    except ImportError:
        sys.exit("torch 미설치: uv pip install --python .venv-ml/bin/python torch")

    torch.manual_seed(SEED); np.random.seed(SEED)
    lines = []

    def out(s=""):
        print(s); lines.append(s)

    t0 = time.time()
    X, y, groups, dsets = load_windows(args.features_csv, args.placement, args.raw_xyz)
    ch = "raw-xyz(3)" if args.raw_xyz else "smv+sorted(4)"
    device = pick_device(torch, args.device)

    split_groups = dsets if args.mode == "lodo" else groups
    splitter, n_folds = T.make_splitter(args.mode, split_groups)

    out(f"[data] {args.features_csv}  placement={args.placement}  채널={ch}")
    out(f"[data] {len(y)} trial (낙상 {int(y.sum())} / ADL {int((y==0).sum())})  "
        f"창 {X.shape}  subject {len(set(groups))}  dataset {len(set(dsets))}  로드 {time.time()-t0:.1f}s")
    out(f"[eval] {'LODO '+str(n_folds)+'-fold(센서 분리)' if args.mode=='lodo' else 'LOSO 5-fold(사람 분리)'}  "
        f"device={device.type}  epochs={args.epochs}")
    out(f"[ref ] 고전 candidate 96.1/79.2 (§02 §6.1) · 트리 최고 LightGBM "
        f"{'LODO 95.3' if args.mode=='lodo' else 'LOSO 98.2'} 균형 (§04 §3)")
    out("")

    oof, fold = oof_cnn(torch, nn, X, y, split_groups, splitter,
                        args.epochs, args.batch, args.lr, device, out, dsets, args.mode)

    from sklearn.metrics import roc_auc_score
    auc = roc_auc_score(y, oof)
    m05 = T.metrics_at(y, oof, 0.5)
    thr_s = T.threshold_for_sensitivity(y, oof, T.BASELINE_SENS)
    msens = T.metrics_at(y, oof, thr_s)

    out("")
    out(f"── 1D-CNN  (ROC-AUC {auc:.4f}) ─────────────────────────")
    out(T.fmt_row("@0.5", m05))
    out(T.fmt_row("@민감도≈96.1%", msens) + f"   (임계 {thr_s:.3f})")
    # fold별 균형정확도
    bals = []
    for k in range(n_folds):
        mask = fold == k
        if mask.sum():
            lab = dsets[mask][0] if args.mode == "lodo" else str(k)
            bals.append((lab, T.metrics_at(y[mask], oof[mask], 0.5)["bal"]))
    out("  fold별 균형정확도(@0.5): " +
        "  ".join(f"{lab}:{b*100:.1f}" for lab, b in bals) +
        f"   (평균 {np.mean([b for _, b in bals])*100:.1f} ± {np.std([b for _, b in bals])*100:.1f})")
    out("")
    out("── 데이터셋별 성적 (@0.5) ─────────────────────")
    for ds in sorted(set(dsets)):
        mask = dsets == ds
        if mask.sum() and y[mask].sum():
            mt = T.metrics_at(y[mask], oof[mask], 0.5)
            out(f"  {ds:<10} n={mask.sum():<5} 민감도 {mt['sens']*100:5.1f}%  "
                f"특이도 {mt['spec']*100:5.1f}%  균형 {mt['bal']*100:5.1f}%")

    if args.report:
        os.makedirs(os.path.dirname(args.report), exist_ok=True)
        with open(args.report, "w") as f:
            f.write("\n".join(lines) + "\n")
        print(f"[report] -> {args.report}")


if __name__ == "__main__":
    main()
