#!/usr/bin/env python3
"""
공개 낙상 데이터셋 → 정규화 단일 CSV.

정규화 규칙(docs/research/03_fall-datasets.md §D2~D4, 02 §5.1):
  - 가속도 채널만 사용, 허리 착용부위만.
  - 단위 g 통일, 중력 포함(정지 SMV≈1g) — 워치 전송값 규약과 일치.
  - SMV = sqrt(ax²+ay²+az²).
  - 공통 50Hz로 리샘플(데시메이션: 워치의 '틱마다 최신 샘플' 거동과 동일, 안티앨리어싱 없음).
  - 라벨 낙상=1 / ADL=0.

출력 스키마(한 줄=한 샘플):
  dataset,subject,activity,trial,is_fall,t_ms,ax_g,ay_g,az_g,smv_g

의존성 0(순수 파이썬 stdlib). 데이터셋별 어댑터를 추가해 확장한다.
사용: python3 tools/normalize_falls.py [--datasets SisFall,...] [--hz 50] [--out <path>]
"""
import os, sys, csv, math, glob, argparse

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(REPO, "datasets")
TARGET_HZ = 50

# --- 리샘플 코어 -------------------------------------------------------------
def decimate(samples, src_hz, target_hz):
    """src_hz 균일 샘플 리스트 → target_hz. 정수배면 stride, 아니면 최근접-틱.
    워치 거동(틱마다 최신 샘플)을 모사하므로 lowpass 없이 최근접을 취한다."""
    if src_hz <= target_hz:
        return samples  # 이미 같거나 더 낮음(업샘플 안 함)
    n = len(samples)
    dur = n / src_hz
    out = []
    step = 1.0 / target_hz
    t = 0.0
    while t < dur:
        idx = int(round(t * src_hz))
        if idx >= n:
            break
        out.append(samples[idx])
        t += step
    return out

def emit_rows(writer, dataset, subject, activity, trial, is_fall, xyz_g, hz):
    """xyz_g: [(ax,ay,az), ...] (이미 g·중력포함·목표Hz). CSV 행 방출."""
    dt_ms = 1000.0 / hz
    for i, (ax, ay, az) in enumerate(xyz_g):
        smv = math.sqrt(ax*ax + ay*ay + az*az)
        writer.writerow([dataset, subject, activity, trial, is_fall,
                         round(i*dt_ms, 1), round(ax, 5), round(ay, 5),
                         round(az, 5), round(smv, 5)])
    return len(xyz_g)

# --- SisFall 어댑터 ----------------------------------------------------------
# 파일: datasets/SisFall/<SUBJ>/<ACT>_<SUBJ>_<TRIAL>.txt  (200Hz)
# 각 줄 9값: ADXL345(x,y,z), ITG3200 자이로(x,y,z), MMA8451Q(x,y,z). 끝에 ';' 가능.
# ADXL345 ±16g/13bit → g = AD/256 (중력 포함, 정지≈1g 실측 확인).
# 활동코드 F*=낙상(1), D*=ADL(0).
SISFALL_HZ = 200
def sisfall_iter(root):
    for p in sorted(glob.glob(os.path.join(root, "S*", "[DF]*_S*_R*.txt"))):
        base = os.path.basename(p)[:-4]           # D01_SA01_R01
        parts = base.split("_")
        if len(parts) != 3:
            continue
        act, _fname_subj, trial = parts
        # subject는 폴더가 진실. 미러에 SA15/D17_SE15_*처럼 파일명 오네이밍이 있어
        # 파일명에서 뽑으면 서로 다른 트라이얼이 같은 키로 충돌한다(내용 확인 결과 별개 데이터).
        subj = os.path.basename(os.path.dirname(p))
        is_fall = 1 if act.upper().startswith("F") else 0
        xyz = []
        with open(p) as fh:
            for ln in fh:
                ln = ln.strip().rstrip(";").strip()
                if not ln:
                    continue
                c = ln.split(",")
                if len(c) < 3:
                    continue
                try:
                    ax, ay, az = int(c[0]), int(c[1]), int(c[2])
                except ValueError:
                    continue
                xyz.append((ax/256.0, ay/256.0, az/256.0))   # → g
        if xyz:
            yield subj, act, trial, is_fall, xyz, SISFALL_HZ

ADAPTERS = {
    "SisFall": lambda: sisfall_iter(os.path.join(DATA, "SisFall")),
    # 다음 확장: FallAllD(D3), UMAFall(WAIST), UCI-455(허리), URFD.
}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--datasets", default="SisFall")
    ap.add_argument("--hz", type=int, default=TARGET_HZ)
    ap.add_argument("--out", default=os.path.join(DATA, "_normalized",
                                                  "waist_falls_50hz.csv"))
    a = ap.parse_args()
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    names = [x.strip() for x in a.datasets.split(",") if x.strip()]

    stats = {}
    with open(a.out, "w", newline="") as fout:
        w = csv.writer(fout)
        w.writerow(["dataset","subject","activity","trial","is_fall",
                    "t_ms","ax_g","ay_g","az_g","smv_g"])
        for name in names:
            if name not in ADAPTERS:
                print(f"[skip] 어댑터 없음: {name}", file=sys.stderr)
                continue
            trials = rows = fall_tr = 0
            for subj, act, trial, is_fall, xyz, src_hz in ADAPTERS[name]():
                res = decimate(xyz, src_hz, a.hz)
                rows += emit_rows(w, name, subj, act, trial, is_fall, res, a.hz)
                trials += 1
                fall_tr += is_fall
            stats[name] = (trials, fall_tr, trials - fall_tr, rows)

    print(f"출력: {a.out}  (목표 {a.hz}Hz)")
    print(f"{'dataset':>10} | {'trials':>7} | {'fall':>6} | {'adl':>6} | {'rows':>10}")
    for name, (t, f, ad, r) in stats.items():
        print(f"{name:>10} | {t:>7} | {f:>6} | {ad:>6} | {r:>10}")

if __name__ == "__main__":
    main()
