"""정규화 마스터 CSV → 충격윈도우 특징표 산출 (research 02 §5.4).

각 trial을 창 정렬해 코어 19 특징을 뽑아 1행으로. placement 필터(기본 waist).
출력 스키마: [FEATURE_NAMES..., is_fall, subject, dataset, activity, trial, placement]

사용:
  .venv-ml/bin/python ml/extract.py \
      ml/datasets/_normalized/falls_all_50hz.csv \
      --placement waist \
      --out ml/_out/features_waist.csv
"""
from __future__ import annotations
import argparse, csv, os, sys, time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import features as F

# 컬럼: dataset,subject,placement,activity,trial,is_fall,src_hz,t_ms,ax,ay,az,smv
DS, SUBJ, PLACE, ACT, TR, ISF, SRCHZ, TMS, AX, AY, AZ, SMV = range(12)
MIN_SAMPLES = 3  # 이보다 짧은 trial은 창/특징 무의미 → 스킵(카운트)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("csv_path")
    ap.add_argument("--placement", default="waist", help="필터할 착용 위치(기본 waist, all=전체)")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    want = None if args.placement == "all" else args.placement

    cur_key = None
    meta = None            # (dataset, subject, activity, trial, is_fall, placement)
    ax_b, ay_b, az_b = [], [], []
    n_trials = n_written = n_skipped = 0
    n_fall = 0
    t0 = time.time()

    fout = open(args.out, "w", newline="")
    writer = csv.writer(fout)
    writer.writerow(list(F.FEATURE_NAMES) +
                    ["is_fall", "subject", "dataset", "activity", "trial", "placement"])

    def flush():
        nonlocal n_trials, n_written, n_skipped, n_fall
        if meta is None:
            return
        n_trials += 1
        if len(ax_b) < MIN_SAMPLES:
            n_skipped += 1
            return
        vec = F.feature_vector(np.array(ax_b), np.array(ay_b), np.array(az_b))
        ds, subj, act, tr, isf, place = meta
        writer.writerow([f"{x:.6g}" for x in vec] + [isf, subj, ds, act, tr, place])
        n_written += 1
        if isf == "1":
            n_fall += 1

    with open(args.csv_path, "r", newline="") as f:
        r = csv.reader(f)
        next(r)  # header
        for row in r:
            if len(row) < 12:
                continue
            if want is not None and row[PLACE] != want:
                continue
            key = (row[DS], row[SUBJ], row[ACT], row[TR])
            if key != cur_key:
                flush()
                cur_key = key
                meta = (row[DS], row[SUBJ], row[ACT], row[TR], row[ISF], row[PLACE])
                ax_b, ay_b, az_b = [], [], []
            try:
                ax_b.append(float(row[AX])); ay_b.append(float(row[AY])); az_b.append(float(row[AZ]))
            except ValueError:
                pass
        flush()

    fout.close()
    dt = time.time() - t0
    print(f"[extract] placement={args.placement}  trials={n_trials}  written={n_written} "
          f"(fall {n_fall} / adl {n_written - n_fall})  skipped_short={n_skipped}  {dt:.1f}s")
    print(f"[extract] -> {args.out}")


if __name__ == "__main__":
    main()
