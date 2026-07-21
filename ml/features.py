"""충격 윈도우 추출 + 특징 계산 — 정본 정의 (research 02 §5.3/§5.4).

트리 3종(XGBoost·LightGBM·로지스틱) 공통 입력이 되는 방향불변 코어 19개.
학습(Python)·런타임(Node) 양쪽이 같은 값을 내야 하므로 이 파일이 유일한 진실.
값은 전부 g 단위(정지≈1g). 1D-CNN은 이 특징 대신 원시 창을 받는다.
"""
from __future__ import annotations
import numpy as np
from scipy import stats, signal

# --- 확정 상수 (research 02 §5.3/§5.4) ---
WINDOW = 150          # 충격 정렬 창 폭(샘플) = 3s @ 50Hz
FS = 50.0             # 정규화 샘플레이트(Hz)
HALF = WINDOW // 2    # 75
STILL_BAND = 0.25     # 정지밴드 |SMV-1g| < 0.25g (고전 감지기 stillBand와 동일)
GRAV_SEG = 25         # tilt용 서브구간 0.5s = 25샘플
PEAK_PROMINENCE = 0.3 # peak_count용 국소정점 prominence(g)
_EPS = 1e-9

# 특징 순서 고정 — 산출 표의 열 순서이자 Node 이식 시 계약
FEATURE_NAMES = [
    # A그룹 — 충격/낙상 핵심 (방향불변)
    "smv_max", "smv_min", "smv_range", "freefall_dur", "impact_slope",
    "tilt_change", "post_activity", "post_still_ratio", "pre_post_ratio",
    # B그룹 — 창 통계 (SMV 기반, 방향불변)
    "smv_mean", "smv_std", "smv_rms", "smv_mad", "smv_kurtosis",
    "smv_skew", "smv_iqr", "mean_cross_rate", "peak_count", "smv_energy",
]


def smv_of(ax: np.ndarray, ay: np.ndarray, az: np.ndarray) -> np.ndarray:
    """신호 크기 벡터 SMV = sqrt(ax²+ay²+az²)."""
    return np.sqrt(ax * ax + ay * ay + az * az)


def extract_window(ax, ay, az):
    """정점(argmax SMV) 정렬 150샘플 창을 오려낸다.

    - trial 길이 L>=150: 정점 중심 [p-75,p+75)를 잡되 경계 초과 시 trial 안으로 시프트(패딩 없음).
    - L<150: 가장자리 값으로 복제 패딩(정점을 중앙에 두도록).
    반환: (win_ax, win_ay, win_az, win_smv) 각 길이 WINDOW.
    """
    ax = np.asarray(ax, dtype=np.float64)
    ay = np.asarray(ay, dtype=np.float64)
    az = np.asarray(az, dtype=np.float64)
    smv = smv_of(ax, ay, az)
    L = len(smv)
    p = int(np.argmax(smv))

    if L >= WINDOW:
        start = p - HALF
        start = max(0, min(start, L - WINDOW))          # trial 안으로 시프트
        idx = np.arange(start, start + WINDOW)
    else:
        start = p - HALF                                 # 음수 가능
        idx = np.clip(np.arange(start, start + WINDOW), 0, L - 1)  # 가장자리 복제
    return ax[idx], ay[idx], az[idx], smv[idx]


def _safe_skew(x):
    return 0.0 if np.std(x) < _EPS else float(stats.skew(x))


def _safe_kurtosis(x):
    return 0.0 if np.std(x) < _EPS else float(stats.kurtosis(x))  # Fisher(정규=0)


def _angle_deg(u, v):
    nu, nv = np.linalg.norm(u), np.linalg.norm(v)
    if nu < _EPS or nv < _EPS:
        return 0.0
    c = float(np.clip(np.dot(u, v) / (nu * nv), -1.0, 1.0))
    return float(np.degrees(np.arccos(c)))


def compute_features(ax, ay, az) -> dict:
    """한 trial → 특징 dict(FEATURE_NAMES 키). 창 추출까지 내부에서 수행."""
    wax, way, waz, s = extract_window(ax, ay, az)
    n = len(s)
    peak = int(np.argmax(s))

    pre = s[:peak]                 # 정점 이전
    post = s[peak + 1:]            # 정점 이후
    pre_min_idx = int(np.argmin(s[:peak + 1]))  # 정점 포함 이전 구간의 최저점

    smv_max = float(s.max())
    smv_min = float(s.min())
    smv_range = smv_max - smv_min
    freefall_dur = (peak - pre_min_idx) / FS
    impact_slope = smv_range / max(freefall_dur, 1.0 / FS)

    g_pre = np.array([wax[:GRAV_SEG].mean(), way[:GRAV_SEG].mean(), waz[:GRAV_SEG].mean()])
    g_post = np.array([wax[-GRAV_SEG:].mean(), way[-GRAV_SEG:].mean(), waz[-GRAV_SEG:].mean()])
    tilt_change = _angle_deg(g_pre, g_post)

    post_activity = float(post.std()) if post.size else 0.0
    post_still_ratio = float(np.mean(np.abs(post - 1.0) < STILL_BAND)) if post.size else 0.0
    pre_energy = float(np.sum(pre * pre)) if pre.size else 0.0
    post_energy = float(np.sum(post * post)) if post.size else 0.0
    pre_post_ratio = pre_energy / (post_energy + _EPS)

    smv_mean = float(s.mean())
    smv_std = float(s.std())
    smv_rms = float(np.sqrt(np.mean(s * s)))
    smv_mad = float(np.median(np.abs(s - np.median(s))))
    smv_kurtosis = _safe_kurtosis(s)
    smv_skew = _safe_skew(s)
    q1, q3 = np.percentile(s, [25, 75])
    smv_iqr = float(q3 - q1)
    centered = s - smv_mean
    mean_cross_rate = float(np.sum(np.abs(np.diff(np.sign(centered))) > 0)) / n
    peaks, _ = signal.find_peaks(s, prominence=PEAK_PROMINENCE)
    peak_count = float(len(peaks))
    smv_energy = float(np.sum(s * s) / n)

    return {
        "smv_max": smv_max, "smv_min": smv_min, "smv_range": smv_range,
        "freefall_dur": freefall_dur, "impact_slope": impact_slope,
        "tilt_change": tilt_change, "post_activity": post_activity,
        "post_still_ratio": post_still_ratio, "pre_post_ratio": pre_post_ratio,
        "smv_mean": smv_mean, "smv_std": smv_std, "smv_rms": smv_rms,
        "smv_mad": smv_mad, "smv_kurtosis": smv_kurtosis, "smv_skew": smv_skew,
        "smv_iqr": smv_iqr, "mean_cross_rate": mean_cross_rate,
        "peak_count": peak_count, "smv_energy": smv_energy,
    }


def feature_vector(ax, ay, az) -> np.ndarray:
    """compute_features를 FEATURE_NAMES 순서의 1D 배열로."""
    f = compute_features(ax, ay, az)
    return np.array([f[k] for k in FEATURE_NAMES], dtype=np.float64)
