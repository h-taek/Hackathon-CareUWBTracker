'use strict';

// 충격 윈도우 + 코어 19특징 — ml/features.py의 Node 포팅(정본은 Python, 이건 이식본).
// numpy/scipy 의미를 정확히 재현한다(percentile linear, scipy skew/kurtosis, find_peaks prominence).
// 동치는 __fixtures__/golden.json으로 골든테스트(features.golden.test.js)에서 강제.
// 값은 g 단위(정지≈1g). 정본 상수 변경 시 Python과 함께 바꿔야 한다.

const WINDOW = 150;
const FS = 50.0;
const HALF = 75;
const STILL_BAND = 0.25;
const GRAV_SEG = 25;
const PEAK_PROMINENCE = 0.3;
const EPS = 1e-9;

const FEATURE_NAMES = [
  'smv_max', 'smv_min', 'smv_range', 'freefall_dur', 'impact_slope',
  'tilt_change', 'post_activity', 'post_still_ratio', 'pre_post_ratio',
  'smv_mean', 'smv_std', 'smv_rms', 'smv_mad', 'smv_kurtosis',
  'smv_skew', 'smv_iqr', 'mean_cross_rate', 'peak_count', 'smv_energy',
];

// ---------- 배열 유틸(numpy 의미) ----------

function smvOf(ax, ay, az) {
  const n = ax.length;
  const out = new Array(n);
  for (let i = 0; i < n; i += 1) out[i] = Math.hypot(ax[i], ay[i], az[i]);
  return out;
}

function argmax(a) { // numpy argmax: 최댓값의 첫 인덱스
  let mi = 0;
  for (let i = 1; i < a.length; i += 1) if (a[i] > a[mi]) mi = i;
  return mi;
}

function argmin(a) {
  let mi = 0;
  for (let i = 1; i < a.length; i += 1) if (a[i] < a[mi]) mi = i;
  return mi;
}

function sum(a) { let s = 0; for (let i = 0; i < a.length; i += 1) s += a[i]; return s; }
function mean(a) { return a.length ? sum(a) / a.length : 0; }
function maxOf(a) { let m = a[0]; for (let i = 1; i < a.length; i += 1) if (a[i] > m) m = a[i]; return m; }
function minOf(a) { let m = a[0]; for (let i = 1; i < a.length; i += 1) if (a[i] < m) m = a[i]; return m; }

function stdPop(a) { // 모표준편차(ddof=0) = numpy std 기본
  if (!a.length) return 0;
  const m = mean(a);
  let s = 0;
  for (let i = 0; i < a.length; i += 1) { const d = a[i] - m; s += d * d; }
  return Math.sqrt(s / a.length);
}

function median(a) {
  const s = a.slice().sort((x, y) => x - y);
  const n = s.length;
  const mid = n >> 1;
  return n % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// numpy percentile 기본('linear' 보간). q는 0..100.
function percentile(a, q) {
  const s = a.slice().sort((x, y) => x - y);
  const pos = (q / 100) * (s.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return s[lo];
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

// scipy.stats.skew(bias=True) = m3/m2^1.5. std<eps면 0(가드, Python과 동일).
function skew(a) {
  const m = mean(a);
  let m2 = 0; let m3 = 0;
  for (let i = 0; i < a.length; i += 1) { const d = a[i] - m; m2 += d * d; m3 += d * d * d; }
  m2 /= a.length; m3 /= a.length;
  if (Math.sqrt(m2) < EPS) return 0;
  return m3 / (m2 ** 1.5);
}

// scipy.stats.kurtosis(Fisher=True, bias=True) = m4/m2^2 - 3. std<eps면 0.
function kurtosis(a) {
  const m = mean(a);
  let m2 = 0; let m4 = 0;
  for (let i = 0; i < a.length; i += 1) { const d = a[i] - m; const d2 = d * d; m2 += d2; m4 += d2 * d2; }
  m2 /= a.length; m4 /= a.length;
  if (Math.sqrt(m2) < EPS) return 0;
  return m4 / (m2 * m2) - 3;
}

function sign(v) { return v > 0 ? 1 : (v < 0 ? -1 : 0); } // np.sign: 0→0

function angleDeg(u, v) {
  const nu = Math.hypot(u[0], u[1], u[2]);
  const nv = Math.hypot(v[0], v[1], v[2]);
  if (nu < EPS || nv < EPS) return 0;
  let c = (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (nu * nv);
  c = Math.max(-1, Math.min(1, c));
  return (Math.acos(c) * 180) / Math.PI;
}

// scipy.signal.find_peaks 지역최댓값(_local_maxima_1d): 평탄부 중점 처리.
function localMaxima(x) {
  const mids = [];
  const iMax = x.length - 1;
  let i = 1;
  while (i < iMax) {
    if (x[i - 1] < x[i]) {
      let iAhead = i + 1;
      while (iAhead < iMax && x[iAhead] === x[i]) iAhead += 1;
      if (x[iAhead] < x[i]) {
        mids.push((i + (iAhead - 1)) >> 1);
        i = iAhead;
      }
    }
    i += 1;
  }
  return mids;
}

// scipy _peak_prominences(wlen=None): 좌/우로 더 높은 봉우리 만날 때까지의 최저점 기준.
function prominence(x, peak) {
  const xp = x[peak];
  let leftMin = xp;
  let i = peak;
  while (i >= 0 && x[i] <= xp) { if (x[i] < leftMin) leftMin = x[i]; i -= 1; }
  let rightMin = xp;
  i = peak;
  const iMax = x.length - 1;
  while (i <= iMax && x[i] <= xp) { if (x[i] < rightMin) rightMin = x[i]; i += 1; }
  return xp - Math.max(leftMin, rightMin);
}

function peakCount(x, minProm) {
  let c = 0;
  for (const p of localMaxima(x)) if (prominence(x, p) >= minProm) c += 1;
  return c;
}

// ---------- 창 추출 ----------

// 정점(argmax SMV) 정렬 150샘플 창. L>=150이면 경계 안으로 시프트(패딩X), L<150이면 가장자리 복제.
function extractWindow(ax, ay, az) {
  const smv = smvOf(ax, ay, az);
  const L = smv.length;
  const p = argmax(smv);
  const idx = new Array(WINDOW);
  if (L >= WINDOW) {
    let start = p - HALF;
    start = Math.max(0, Math.min(start, L - WINDOW));
    for (let k = 0; k < WINDOW; k += 1) idx[k] = start + k;
  } else {
    const start = p - HALF;
    for (let k = 0; k < WINDOW; k += 1) idx[k] = Math.max(0, Math.min(start + k, L - 1));
  }
  const wax = idx.map((j) => ax[j]);
  const way = idx.map((j) => ay[j]);
  const waz = idx.map((j) => az[j]);
  const s = idx.map((j) => smv[j]);
  return { wax, way, waz, s };
}

// ---------- 특징 ----------

function computeFeatures(ax, ay, az) {
  const { wax, way, waz, s } = extractWindow(ax, ay, az);
  const n = s.length;
  const peak = argmax(s);

  const pre = s.slice(0, peak);
  const post = s.slice(peak + 1);
  const preMinIdx = argmin(s.slice(0, peak + 1));

  const smvMax = maxOf(s);
  const smvMin = minOf(s);
  const smvRange = smvMax - smvMin;
  const freefallDur = (peak - preMinIdx) / FS;
  const impactSlope = smvRange / Math.max(freefallDur, 1 / FS);

  const gPre = [mean(wax.slice(0, GRAV_SEG)), mean(way.slice(0, GRAV_SEG)), mean(waz.slice(0, GRAV_SEG))];
  const gPost = [mean(wax.slice(-GRAV_SEG)), mean(way.slice(-GRAV_SEG)), mean(waz.slice(-GRAV_SEG))];
  const tiltChange = angleDeg(gPre, gPost);

  const postActivity = post.length ? stdPop(post) : 0;
  let stillCount = 0;
  for (let i = 0; i < post.length; i += 1) if (Math.abs(post[i] - 1) < STILL_BAND) stillCount += 1;
  const postStillRatio = post.length ? stillCount / post.length : 0;

  let preEnergy = 0; for (let i = 0; i < pre.length; i += 1) preEnergy += pre[i] * pre[i];
  let postEnergy = 0; for (let i = 0; i < post.length; i += 1) postEnergy += post[i] * post[i];
  const prePostRatio = preEnergy / (postEnergy + EPS);

  const smvMean = mean(s);
  const smvStd = stdPop(s);
  let sq = 0; for (let i = 0; i < n; i += 1) sq += s[i] * s[i];
  const smvRms = Math.sqrt(sq / n);
  const med = median(s);
  const smvMad = median(s.map((v) => Math.abs(v - med)));
  const smvKurtosis = kurtosis(s);
  const smvSkew = skew(s);
  const smvIqr = percentile(s, 75) - percentile(s, 25);

  let crossings = 0;
  let prevSign = sign(s[0] - smvMean);
  for (let i = 1; i < n; i += 1) {
    const cur = sign(s[i] - smvMean);
    if (Math.abs(cur - prevSign) > 0) crossings += 1;
    prevSign = cur;
  }
  const meanCrossRate = crossings / n;
  const pkCount = peakCount(s, PEAK_PROMINENCE);
  const smvEnergy = sq / n;

  return {
    smv_max: smvMax, smv_min: smvMin, smv_range: smvRange,
    freefall_dur: freefallDur, impact_slope: impactSlope,
    tilt_change: tiltChange, post_activity: postActivity,
    post_still_ratio: postStillRatio, pre_post_ratio: prePostRatio,
    smv_mean: smvMean, smv_std: smvStd, smv_rms: smvRms,
    smv_mad: smvMad, smv_kurtosis: smvKurtosis, smv_skew: smvSkew,
    smv_iqr: smvIqr, mean_cross_rate: meanCrossRate,
    peak_count: pkCount, smv_energy: smvEnergy,
  };
}

function featureVector(ax, ay, az) {
  const f = computeFeatures(ax, ay, az);
  return FEATURE_NAMES.map((k) => f[k]);
}

module.exports = {
  WINDOW, FS, FEATURE_NAMES, PEAK_PROMINENCE,
  smvOf, extractWindow, computeFeatures, featureVector,
};
