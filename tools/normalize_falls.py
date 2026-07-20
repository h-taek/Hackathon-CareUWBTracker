#!/usr/bin/env python3
"""
공개 낙상 데이터셋 → 정규화 단일 CSV.

정규화 규칙(docs/research/03_fall-datasets.md §D1~D4):
  - 가속도 채널만 사용(자이로/자력계/기압계 드롭).
  - 단위 g 통일, 중력 포함(정지 SMV≈1g) — 워치 전송값 규약과 일치.
  - SMV = sqrt(ax²+ay²+az²).
  - 공통 50Hz로 리샘플(타임스탬프 기반 최근접-틱: 워치의 '틱마다 최신 샘플' 거동과 동일).
  - 라벨 낙상=1 / ADL=0.
  - **위치는 버리지 않고 placement 컬럼으로 태그**한다(D1: 학습은 같은 위치끼리만 → placement로 필터).
    허리 경로 학습셋은 placement=waist 필터(→ waist CSV도 함께 출력).

출력 스키마(한 줄=한 샘플):
  dataset,subject,placement,activity,trial,is_fall,src_hz,t_ms,ax_g,ay_g,az_g,smv_g

의존성 0(순수 파이썬 stdlib). 데이터셋별 어댑터를 추가해 확장한다.
사용: python3 tools/normalize_falls.py [--datasets SisFall,...] [--hz 50] [--out <master>] [--waist-out <waist>]

--- 데이터셋별 규격(어댑터 근거) ------------------------------------------------
 SisFall      허리, 200Hz, ADXL345 ±16g/13bit → g=AD/256(중력포함). F*=낙상/D*=ADL.
 URFD         허리(골반), 불규칙 타임스탬프(col0=ms), col2-4=xyz(g,중력포함). 파일명 fall/adl.
 UMAFall      다부위 SensorTag(20Hz)+폰(200Hz), 불규칙 ms. accel=SensorType0. 파일명 Fall/ADL.
              SensorID→위치: 0=pocket(폰),1=chest,2=waist,3=wrist,4=ankle.
 UCI-455      Xsens 6부위 25Hz. Acc_X/Y/Z(col9-11, m/s²중력포함)→/9.80665. 활동 8xx=ADL/9xx=낙상.
              센서시리얼→위치(Information.pdf): 340506=head,340527=chest,340535=waist,
              340537=wrist,340539=thigh,340540=ankle.
 FallAllD     3부위 LSM9DS1 238Hz ±8g → g=raw×0.000244(중력포함). 활동ID≥101=낙상(1~44=ADL).
              디바이스→위치: D1=waist,D2=wrist,D3=neck.
              (D2=손목은 로컬 실측으로 교차확인: 피크·정지중력축 흔들림 최대. 목록 PDF로 라벨 확정.)
 MMSys        가슴+허벅지 Shimmer 100Hz(g,중력포함). 연속녹음 → annotation_1(1=낙상,2=near-fall,0=ADL)
              동일 라벨 연속구간을 이벤트로 분할(near-fall 제외). 긴 구간은 창으로 자름.
 Sensor-Based 가슴 스트랩(Geriatric device) 100Hz. AccX/Y/Z(col0-2, g중력포함). 폴더 Falls=낙상.
"""
import os, sys, csv, math, glob, argparse, statistics as st

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(REPO, "datasets")
TARGET_HZ = 50
G = 9.80665

SCHEMA = ["dataset","subject","placement","activity","trial","is_fall",
          "src_hz","t_ms","ax_g","ay_g","az_g","smv_g"]

# --- 리샘플 코어 -------------------------------------------------------------
def resample_nn(samples, target_hz):
    """samples: [(t_ms, ax, ay, az), ...] (t_ms 오름차순, g·중력포함).
    → target_hz 균일 출력 [(ax,ay,az), ...]. 각 출력 틱마다 시간상 가장 가까운 원본 샘플(최근접).
    업/다운 both 지원: 워치의 '틱마다 최신 샘플' 거동과 같은 계열이라 lowpass 없이 최근접을 취한다.
    불규칙 샘플(UMAFall/URFD)도 타임스탬프로 처리하므로 시간축이 안 뭉개진다."""
    n = len(samples)
    if n == 0:
        return []
    if n == 1:
        return [(samples[0][1], samples[0][2], samples[0][3])]
    t0 = samples[0][0]
    dur = samples[-1][0] - t0
    if dur <= 0:
        return [(samples[0][1], samples[0][2], samples[0][3])]
    step = 1000.0 / target_hz
    out = []
    j = 0
    k = 0
    while True:
        off = k * step
        if off > dur + 1e-6:
            break
        target_t = t0 + off
        # 틱이 단조증가하므로 j는 앞으로만 이동(다음 샘플이 더 가깝거나 같으면 전진).
        while j + 1 < n and abs(samples[j + 1][0] - target_t) <= abs(samples[j][0] - target_t):
            j += 1
        out.append((samples[j][1], samples[j][2], samples[j][3]))
        k += 1
    return out

def uniform_ts(xyz, src_hz):
    """균일 src_hz 샘플 [(ax,ay,az)] → [(t_ms,ax,ay,az)] 타임스탬프 합성(불규칙 소스와 동일 경로 태우려고)."""
    dt = 1000.0 / src_hz
    return [(i * dt, x, y, z) for i, (x, y, z) in enumerate(xyz)]

# --- SisFall 어댑터 ----------------------------------------------------------
# datasets/SisFall/<SUBJ>/<ACT>_<SUBJ>_<TRIAL>.txt  (200Hz). 각 줄 9값(끝 ';' 가능):
# ADXL345(x,y,z), ITG3200 자이로(x,y,z), MMA8451Q(x,y,z). ADXL345 ±16g/13bit → g=AD/256.
SISFALL_HZ = 200
def sisfall_iter(root):
    for p in sorted(glob.glob(os.path.join(root, "S*", "[DF]*_S*_R*.txt"))):
        base = os.path.basename(p)[:-4]           # D01_SA01_R01
        parts = base.split("_")
        if len(parts) != 3:
            continue
        act, _fn_subj, trial = parts
        # subject는 폴더가 진실(SA15/D17_SE15_* 오네이밍 파일이 있어 파일명에서 뽑으면 충돌).
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
                xyz.append((ax / 256.0, ay / 256.0, az / 256.0))
        if xyz:
            yield subj, "waist", act, trial, is_fall, SISFALL_HZ, uniform_ts(xyz, SISFALL_HZ)

# --- URFD 어댑터 -------------------------------------------------------------
# datasets/URFD/{fall,adl}-NN-acc.csv. col0=t_ms(불규칙), col1=SMV, col2-4=x,y,z(g,중력포함).
def urfd_iter(root):
    for p in sorted(glob.glob(os.path.join(root, "*-acc.csv"))):
        base = os.path.basename(p)[:-8]           # fall-01
        kind, num = base.split("-", 1)
        is_fall = 1 if kind.lower() == "fall" else 0
        samples = []
        with open(p) as fh:
            for ln in fh:
                c = ln.strip().split(",")
                if len(c) < 5:
                    continue
                try:
                    t = float(c[0]); ax = float(c[2]); ay = float(c[3]); az = float(c[4])
                except ValueError:
                    continue
                samples.append((t, ax, ay, az))
        samples.sort(key=lambda s: s[0])
        if len(samples) >= 2:
            yield "na", "waist", kind, num, is_fall, "irregular", samples

# --- UMAFall 어댑터 ----------------------------------------------------------
# datasets/UMAFall/UMAFall_Subject_NN_{ADL|Fall}_<movement>_<k>_<date>.csv
# 헤더(%)들 뒤 데이터: TimeStamp;SampleNo;X;Y;Z;SensorType;SensorID  (';' 구분, X/Y/Z=g,중력포함)
UMA_POS = {0: "pocket", 1: "chest", 2: "waist", 3: "wrist", 4: "ankle"}
def umafall_iter(root):
    for p in sorted(glob.glob(os.path.join(root, "UMAFall_*.csv"))):
        fn = os.path.basename(p)
        low = fn.lower()
        if "_fall_" in low:
            is_fall = 1
        elif "_adl_" in low:
            is_fall = 0
        else:
            continue
        parts = fn.split("_")
        subj = parts[2] if len(parts) > 2 else "na"          # Subject 번호
        # activity/trial: 파일명에서 움직임 이름과 반복 index 추출(대략).
        trial = fn[:-4]
        per = {sid: [] for sid in UMA_POS}                    # SensorID → [(t,x,y,z)]
        with open(p) as fh:
            for ln in fh:
                ln = ln.strip()
                if not ln or ln.startswith("%"):
                    continue
                c = ln.split(";")
                if len(c) < 7:
                    continue
                try:
                    t = float(c[0]); x = float(c[2]); y = float(c[3]); z = float(c[4])
                    stype = int(float(c[5])); sid = int(float(c[6]))
                except ValueError:
                    continue
                if stype != 0 or sid not in per:              # accelerometer(0)만
                    continue
                per[sid].append((t, x, y, z))
        for sid, samples in per.items():
            samples.sort(key=lambda s: s[0])
            if len(samples) >= 2:
                yield subj, UMA_POS[sid], "fall" if is_fall else "adl", trial, is_fall, "irregular", samples

# --- UCI-455 (Erciyes) 어댑터 ------------------------------------------------
# datasets/UCI-455/Tests/<subj>/Testler Export/<code-name>/Test_<n>/<serial>.txt
# 헤더 '//'행 + 'Counter\t...'행 뒤 탭구분 데이터. Acc_X/Y/Z=col9/10/11(m/s²,중력포함).
# 활동코드 9xx=낙상/8xx=ADL. 시리얼→위치.
UCI_POS = {"340506": "head", "340527": "chest", "340535": "waist",
           "340537": "wrist", "340539": "thigh", "340540": "ankle"}
UCI_HZ = 25
def uci455_iter(root):
    for txt in sorted(glob.glob(os.path.join(root, "Tests", "*", "Testler Export", "*", "Test_*", "*.txt"))):
        serial = os.path.basename(txt)[:-4]
        if serial not in UCI_POS:
            continue
        parts = txt.split(os.sep)
        # .../Tests/<subj>/Testler Export/<code-name>/Test_<n>/<serial>.txt
        try:
            subj = parts[-5]
            act_full = parts[-3]
            trial = parts[-2]
        except IndexError:
            continue
        code = act_full.split("-", 1)[0]
        is_fall = 1 if code.startswith("9") else 0
        src_hz = UCI_HZ
        xyz = []
        with open(txt, errors="ignore") as fh:
            for ln in fh:
                if ln.startswith("//"):
                    if "Update Rate" in ln:                   # "// Update Rate: 25.0Hz"
                        try:
                            src_hz = float(ln.split(":")[1].replace("Hz", "").strip())
                        except (ValueError, IndexError):
                            pass
                    continue
                if ln.startswith("Counter"):
                    continue
                c = ln.split()
                if len(c) < 12:
                    continue
                try:
                    ax = float(c[9]) / G; ay = float(c[10]) / G; az = float(c[11]) / G
                except ValueError:
                    continue
                xyz.append((ax, ay, az))
        if xyz:
            yield subj, UCI_POS[serial], code, trial, is_fall, src_hz, uniform_ts(xyz, src_hz)

# --- FallAllD 어댑터 ---------------------------------------------------------
# datasets/FallAllD/S<subj>_D<dev>_A<act>_T<trial>_A.dat  (_A=accelerometer, 238Hz)
# 각 줄 x,y,z (raw int, LSM9DS1 ±8g → g=raw×0.000244, 중력포함). 활동ID≥101=낙상.
FALLALLD_HZ = 238
FALLALLD_SCALE = 0.000244
FALLALLD_POS = {"1": "waist", "2": "wrist", "3": "neck"}
def fallalld_iter(root):
    for p in sorted(glob.glob(os.path.join(root, "S*_D*_A*_T*_A.dat"))):
        base = os.path.basename(p)[:-4]           # S01_D1_A013_T01_A
        parts = base.split("_")
        if len(parts) != 5:
            continue
        subj, dev, act, trial, _sensor = parts
        d = dev[1:]                                # D1 → 1
        if d not in FALLALLD_POS:
            continue
        try:
            act_id = int(act[1:])                  # A013 → 13
        except ValueError:
            continue
        is_fall = 1 if act_id >= 101 else 0
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
                    x, y, z = int(c[0]), int(c[1]), int(c[2])
                except ValueError:
                    continue
                xyz.append((x * FALLALLD_SCALE, y * FALLALLD_SCALE, z * FALLALLD_SCALE))
        if xyz:
            yield subj, FALLALLD_POS[d], act, trial, is_fall, FALLALLD_HZ, uniform_ts(xyz, FALLALLD_HZ)

# --- MMSys (Ojetola) 어댑터 --------------------------------------------------
# datasets/MMSys/falls/subject_N.csv  (헤더행 有, 100Hz 연속녹음)
# cols: ch_accel_x,y,z(0-2), ch_gyro(3-5), th_accel_x,y,z(6-8), th_gyro(9-11), annotation_1(12), annotation_2(13)
# annotation_1: 1=낙상, 2=near-fall, 0=ADL. 동일라벨 연속구간을 이벤트로 분할(near-fall 제외).
# g·중력포함. 긴 구간은 창(win)으로 잘라 트라이얼 크기 균질화.
MMSYS_HZ = 100
MMSYS_PLACES = {"chest": (0, 1, 2), "thigh": (6, 7, 8)}
def _emit_runs(rows, min_len, win):
    """[(is_fall, ax, ay, az), ...] 연속행 → 동일 is_fall 런을 win 길이로 잘라 [(is_fall, [(ax,ay,az)...]), ...]."""
    segs = []
    i, n = 0, len(rows)
    while i < n:
        lab = rows[i][0]
        j = i
        while j < n and rows[j][0] == lab:
            j += 1
        run = rows[i:j]
        i = j
        for s in range(0, len(run), win):
            chunk = run[s:s + win]
            if len(chunk) >= min_len:
                segs.append((lab, [(r[1], r[2], r[3]) for r in chunk]))
    return segs
def mmsys_iter(root):
    for p in sorted(glob.glob(os.path.join(root, "falls", "subject_*.csv"))):
        subj = os.path.basename(p)[:-4].replace("subject_", "")
        for place, (ix, iy, iz) in MMSYS_PLACES.items():
            rows = []
            with open(p) as fh:
                first = True
                for ln in fh:
                    if first:                      # 헤더행
                        first = False
                        continue
                    c = ln.strip().split(",")
                    if len(c) < 13:
                        continue
                    try:
                        ax = float(c[ix]); ay = float(c[iy]); az = float(c[iz]); a1 = int(float(c[12]))
                    except ValueError:
                        continue
                    if a1 == 2:                    # near-fall 제외(라벨 모호)
                        rows.append((None, ax, ay, az))
                        continue
                    rows.append((1 if a1 == 1 else 0, ax, ay, az))
            # near-fall(None)로 런 경계만 끊고 세그먼트에선 뺀다.
            clean = [(lab, ax, ay, az) for (lab, ax, ay, az) in rows if lab is not None]
            # near-fall이 사이에 있으면 런 경계가 자연히 갈리도록 위에서 None을 남기지 않고 필터했으므로,
            # 여기선 연속성이 유지된다(near-fall은 통째로 빠짐). fall/adl 경계로만 분할.
            for k, (lab, seg) in enumerate(_emit_runs(clean, min_len=50, win=1000)):
                yield subj, place, "fall" if lab else "adl", f"seg{k:04d}", lab, MMSYS_HZ, uniform_ts(seg, MMSYS_HZ)

# --- Sensor-Based-8953 어댑터 ------------------------------------------------
# datasets/Sensor-Based-8953/Dataset V4/<Activity>/accelerometer_data_*.csv (헤더행 有)
# cols: AccX,AccY,AccZ,Magnitude,GyroX,... (col0-2=accel g,중력포함). 폴더 Falls=낙상, 그 외=ADL.
# 가슴 스트랩(Geriatric device) 100Hz. subject 미표기 → na, trial=파일 타임스탬프.
SENSORBASED_HZ = 100
def sensorbased_iter(root):
    base = os.path.join(root, "Dataset V4")
    for actdir in sorted(glob.glob(os.path.join(base, "*"))):
        if not os.path.isdir(actdir):
            continue
        act = os.path.basename(actdir).strip()
        if act.lower() == "images":
            continue
        is_fall = 1 if act.lower() == "falls" else 0
        for p in sorted(glob.glob(os.path.join(actdir, "*.csv"))):
            trial = os.path.basename(p)[:-4].replace("accelerometer_data_", "")
            xyz = []
            with open(p) as fh:
                first = True
                for ln in fh:
                    if first:
                        first = False
                        continue
                    c = ln.strip().split(",")
                    if len(c) < 3:
                        continue
                    try:
                        ax = float(c[0]); ay = float(c[1]); az = float(c[2])
                    except ValueError:
                        continue
                    xyz.append((ax, ay, az))
            if xyz:
                yield "na", "chest", act, trial, is_fall, SENSORBASED_HZ, uniform_ts(xyz, SENSORBASED_HZ)

ADAPTERS = {
    "SisFall":     lambda: sisfall_iter(os.path.join(DATA, "SisFall")),
    "URFD":        lambda: urfd_iter(os.path.join(DATA, "URFD")),
    "UMAFall":     lambda: umafall_iter(os.path.join(DATA, "UMAFall")),
    "UCI-455":     lambda: uci455_iter(os.path.join(DATA, "UCI-455")),
    "FallAllD":    lambda: fallalld_iter(os.path.join(DATA, "FallAllD")),
    "MMSys":       lambda: mmsys_iter(os.path.join(DATA, "MMSys")),
    "SensorBased": lambda: sensorbased_iter(os.path.join(DATA, "Sensor-Based-8953")),
}
ALL = ",".join(ADAPTERS)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--datasets", default=ALL, help=f"쉼표구분(기본 전체): {ALL}")
    ap.add_argument("--hz", type=int, default=TARGET_HZ)
    ap.add_argument("--out", default=os.path.join(DATA, "_normalized", "falls_all_50hz.csv"),
                    help="마스터 CSV(전 위치)")
    ap.add_argument("--waist-out", default=os.path.join(DATA, "_normalized", "waist_falls_50hz.csv"),
                    help="허리 필터 CSV(학습용 뷰)")
    a = ap.parse_args()
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    names = [x.strip() for x in a.datasets.split(",") if x.strip()]
    dt_ms = 1000.0 / a.hz

    stats = {}   # (dataset,placement) -> [trials, falls, rows, [trial_median_smv...]]
    with open(a.out, "w", newline="") as fmaster, open(a.waist_out, "w", newline="") as fwaist:
        wm = csv.writer(fmaster); ww = csv.writer(fwaist)
        wm.writerow(SCHEMA); ww.writerow(SCHEMA)
        for name in names:
            if name not in ADAPTERS:
                print(f"[skip] 어댑터 없음: {name}", file=sys.stderr)
                continue
            print(f"[run] {name} ...", file=sys.stderr)
            for subj, place, act, trial, is_fall, src_hz, samples in ADAPTERS[name]():
                xyz = resample_nn(samples, a.hz)
                if not xyz:
                    continue
                key = (name, place)
                s = stats.setdefault(key, [0, 0, 0, []])
                s[0] += 1; s[1] += is_fall
                smvs = []
                for i, (ax, ay, az) in enumerate(xyz):
                    smv = math.sqrt(ax * ax + ay * ay + az * az)
                    smvs.append(smv)
                    row = [name, subj, place, act, trial, is_fall, src_hz,
                           round(i * dt_ms, 1), round(ax, 5), round(ay, 5),
                           round(az, 5), round(smv, 5)]
                    wm.writerow(row)
                    if place == "waist":
                        ww.writerow(row)
                s[2] += len(xyz)
                if len(s[3]) < 5000:               # 검증용: 트라이얼별 median SMV 표본(정지≈1g 기대)
                    s[3].append(st.median(smvs))

    print(f"\n마스터: {a.out}")
    print(f"허리:   {a.waist_out}  (placement=waist 필터)")
    print(f"\n{'dataset':>12} | {'placement':>9} | {'trials':>7} | {'fall':>6} | {'adl':>6} | {'rows':>10} | {'medSMV(g)':>9}")
    tot = [0, 0, 0]
    for (name, place), (tr, fa, rows, meds) in sorted(stats.items()):
        med = st.median(meds) if meds else 0.0
        flag = "" if 0.8 <= med <= 1.25 else "  <-- 중력/단위 확인!"
        print(f"{name:>12} | {place:>9} | {tr:>7} | {fa:>6} | {tr-fa:>6} | {rows:>10} | {med:>9.3f}{flag}")
        tot[0] += tr; tot[1] += fa; tot[2] += rows
    print(f"{'TOTAL':>12} | {'':>9} | {tot[0]:>7} | {tot[1]:>6} | {tot[0]-tot[1]:>6} | {tot[2]:>10}")

if __name__ == "__main__":
    main()
