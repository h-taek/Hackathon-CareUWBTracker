// F3 선행 게이트(plan/07): 웹 가우시안 스플랫 뷰어가 데모 머신에서 몇 fps를 내는지 실측한다.
// 부적합으로 판정되면 별도 언리얼 창으로 폴백하므로, 이 페이지의 숫자가 그 분기의 근거다.
// F3 본작업이 끝나면 /spike/ 폴더째 삭제한다.

import * as THREE from 'three';
import * as GS from '@mkkellogg/gaussian-splats-3d';

// 스파이크용 공개 씬. 조달 방법은 /assets/splat/README.md.
const SCENES = [
  { url: '/assets/splat/room.splat', label: 'room — 실내 방 · 약 159만 (기준)' },
  { url: '/assets/splat/train.splat', label: 'train — 소형 야외 · 약 103만 (하한)' },
  { url: '/assets/splat/garden.splat', label: 'garden — 대형 야외 · 약 583만 (상한)' },
  { url: '', label: '직접 입력…' },
];

// 3DGS 학습 결과물은 y축이 아래를 향한다(INRIA 관례). 뒤집으면 씬이 거꾸로 보인다.
const CAMERA_UP = [0, -1, 0];
const WARMUP_MS = 2000;
// 라이브러리가 내보내지 않는 내부 enum(LoaderStatus). 진행 단계 표시에만 쓴다.
const DOWNLOADING = 0;

const $ = (id) => document.getElementById(id);
const ui = {
  scene: $('scene'), customRow: $('customRow'), customUrl: $('customUrl'),
  sh: $('sh'), shared: $('shared'), dpr: $('dpr'), duration: $('duration'),
  load: $('load'), bench: $('bench'), status: $('status'), isolation: $('isolation'),
  fps: $('mFps'), count: $('mCount'), loadTime: $('mLoad'),
  result: $('result'), resultBody: $('resultBody'), verdict: $('verdict'), copy: $('copy'),
  hudFps: $('hudFps'),
};

let viewer = null;      // 현재 뷰어
let frameHandle = 0;    // rAF 핸들
let loaded = null;      // { url, splatCount, loadMs, center, orbitRadius, height, options }
let bench = null;       // 측정 진행 상태
let lastResult = null;  // 복사용 JSON

// ── 화면 갱신 ────────────────────────────────────────────────────────────────

function setStatus(text, isError = false) {
  ui.status.innerHTML = text;
  ui.status.classList.toggle('err', isError);
}

const fmtInt = (n) => n.toLocaleString('ko-KR');
const fmtFps = (n) => (Number.isFinite(n) ? n.toFixed(1) : '—');

// ── 뷰어 수명주기 ────────────────────────────────────────────────────────────

function readOptions() {
  const selected = ui.scene.value;
  return {
    url: selected === '' ? ui.customUrl.value.trim() : selected,
    sh: Number(ui.sh.value),
    shared: ui.shared.value === '1' && self.crossOriginIsolated,
    dpr: ui.dpr.value === '1',
    durationMs: Number(ui.duration.value) * 1000,
  };
}

async function disposeViewer() {
  if (frameHandle) cancelAnimationFrame(frameHandle);
  frameHandle = 0;
  bench = null;
  if (viewer) {
    try {
      await viewer.dispose();
    } catch {
      /* 이미 정리됐으면 무시 */
    }
    viewer = null;
  }
  $('stage').replaceChildren();
}

async function loadScene() {
  const options = readOptions();
  if (!options.url) return setStatus('URL을 입력하세요.', true);

  ui.load.disabled = ui.bench.disabled = true;
  ui.result.hidden = true;
  loaded = null;
  await disposeViewer();

  viewer = new GS.Viewer({
    rootElement: $('stage'),
    selfDrivenMode: false,          // update/render를 직접 호출해야 프레임을 셀 수 있다
    useBuiltInControls: true,
    cameraUp: CAMERA_UP,
    ignoreDevicePixelRatio: !options.dpr,
    sharedMemoryForWorkers: options.shared,
    gpuAcceleratedSort: true,
    dynamicScene: false,
    sphericalHarmonicsDegree: options.sh,
    renderMode: GS.RenderMode.Always,   // OnChange면 정지 화면에서 프레임을 안 그려 측정이 왜곡된다
    sceneRevealMode: GS.SceneRevealMode.Instant,
    logLevel: GS.LogLevel.None,
  });

  const started = performance.now();
  try {
    await viewer.addSplatScene(options.url, {
      showLoadingUI: false,
      progressiveLoad: false,       // 다 받은 뒤 한 번에 — 로드 시간을 또렷하게 잰다
      onProgress: (percent, _label, stage) => {
        const phase = stage === DOWNLOADING ? '내려받는 중' : '변환 중';
        setStatus(`${phase} <b>${Math.round(percent)}%</b>`);
      },
    });
  } catch (error) {
    ui.load.disabled = false;
    return setStatus(`로드 실패: ${error?.message ?? error}`, true);
  }

  const loadMs = performance.now() - started;
  const mesh = viewer.splatMesh;
  const { center, size } = measureExtent(mesh);

  loaded = {
    url: options.url,
    options,
    loadMs,
    splatCount: mesh.getSplatCount(),
    center,
    height: size.y,
    // 씬 전체가 화면에 들어오는 거리. 너무 붙으면 스플랫 수가 적게 잡혀 측정이 후해진다.
    orbitRadius: Math.max(0.5 * Math.max(size.x, size.z) * 1.8, 1),
  };

  ui.count.textContent = fmtInt(loaded.splatCount);
  ui.loadTime.textContent = `${(loadMs / 1000).toFixed(1)}초`;
  setStatus('로드 완료. 마우스로 둘러보거나 <b>측정 시작</b>을 누르세요.');
  ui.load.disabled = ui.bench.disabled = false;

  placeCamera(0, 'orbit');
  frameHandle = requestAnimationFrame(frame);
}

// 씬의 실질 크기. 전체 바운딩박스는 멀리 떨어진 배경 스플랫 몇 개에 끌려 터무니없이 커지고,
// 그 거리에서 궤도를 돌면 씬이 점처럼 작아져 프레임이 후하게 나온다. 표본의 백분위로 자른다.
function measureExtent(mesh) {
  const total = mesh.getSplatCount();
  const step = Math.max(1, Math.floor(total / 20000));
  const axes = [[], [], []];
  const point = new THREE.Vector3();
  for (let i = 0; i < total; i += step) {
    mesh.getSplatCenter(i, point, true);
    axes[0].push(point.x);
    axes[1].push(point.y);
    axes[2].push(point.z);
  }

  const bounds = axes.map((values) => {
    values.sort((a, b) => a - b);
    const cut = Math.floor(values.length * 0.025);
    return [values[cut], values[values.length - 1 - cut]];
  });
  return {
    center: new THREE.Vector3(...bounds.map(([lo, hi]) => (lo + hi) / 2)),
    size: new THREE.Vector3(...bounds.map(([lo, hi]) => hi - lo)),
  };
}

// ── 카메라 주행 ──────────────────────────────────────────────────────────────
// 두 구간을 잰다. 궤도=씬 전체가 프레임에 들어오는 최대 스플랫 부하,
// 실내=씬 안에서 둘러보는 최대 겹침(오버드로) 부하. 관제 화면은 실내 쪽에 가깝다.

function placeCamera(progress, mode) {
  const angle = progress * Math.PI * 2;
  const { center, orbitRadius, height } = loaded;
  const camera = viewer.camera;
  const target = new THREE.Vector3();

  if (mode === 'orbit') {
    // cameraUp이 -y라 "위"는 y를 빼는 방향이다.
    camera.position.set(
      center.x + orbitRadius * Math.cos(angle),
      center.y - height * 0.25,
      center.z + orbitRadius * Math.sin(angle),
    );
    target.copy(center);
  } else {
    camera.position.set(center.x, center.y - height * 0.1, center.z);
    target.set(
      center.x + orbitRadius * Math.cos(angle),
      center.y - height * 0.1,
      center.z + orbitRadius * Math.sin(angle),
    );
  }
  if (viewer.controls) viewer.controls.target.copy(target);
  camera.lookAt(target);
}

// ── 렌더 루프 · 프레임 계측 ──────────────────────────────────────────────────

let lastFrameAt = 0;
const recent = [];

function frame(now) {
  frameHandle = requestAnimationFrame(frame);

  if (bench) stepBench(now);
  viewer.update();
  viewer.render();

  if (lastFrameAt) {
    const delta = now - lastFrameAt;
    recent.push(delta);
    if (recent.length > 30) recent.shift();
    if (bench?.phase === 'measure') bench.segment.deltas.push(delta);
  }
  lastFrameAt = now;

  const avg = recent.reduce((a, b) => a + b, 0) / (recent.length || 1);
  const fps = fmtFps(1000 / avg);
  ui.fps.textContent = fps;
  ui.hudFps.textContent = fps;
}

function stepBench(now) {
  const elapsed = now - bench.phaseStartedAt;

  if (bench.phase === 'warmup') {
    // 첫 프레임들은 셰이더 컴파일·텍스처 업로드가 섞여 있어 버린다.
    placeCamera(0, bench.segment.mode);
    if (elapsed >= WARMUP_MS) {
      bench.phase = 'measure';
      bench.phaseStartedAt = now;
      setStatus(`측정 중 — <b>${bench.segment.label}</b>`);
    }
    return;
  }

  const progress = elapsed / bench.durationMs;
  placeCamera(progress, bench.segment.mode);
  if (progress < 1) return;

  const next = bench.queue.shift();
  if (next) {
    bench.segment = next;
    bench.phase = 'warmup';
    bench.phaseStartedAt = now;
    setStatus(`준비 중 — <b>${next.label}</b>`);
    return;
  }
  finishBench();
}

function startBench() {
  const durationMs = Number(ui.duration.value) * 1000;
  const segments = [
    { mode: 'orbit', label: '궤도(씬 전체)', deltas: [] },
    { mode: 'inside', label: '실내(둘러보기)', deltas: [] },
  ];
  bench = {
    durationMs,
    done: segments,
    queue: segments.slice(1),
    segment: segments[0],
    phase: 'warmup',
    phaseStartedAt: performance.now(),
  };
  ui.load.disabled = ui.bench.disabled = true;
  ui.result.hidden = true;
  setStatus(`준비 중 — <b>${segments[0].label}</b>`);
}

// ── 집계 ─────────────────────────────────────────────────────────────────────

function summarize(deltas) {
  const total = deltas.reduce((a, b) => a + b, 0);
  const sorted = [...deltas].sort((a, b) => a - b);
  // 1% 저점: 가장 느린 1% 프레임의 평균 fps. 평균만 보면 순간 끊김이 숨는다.
  const worstCount = Math.max(1, Math.round(sorted.length * 0.01));
  const worst = sorted.slice(-worstCount);
  return {
    frames: deltas.length,
    avgFps: (deltas.length / total) * 1000,
    lowFps: (worst.length / worst.reduce((a, b) => a + b, 0)) * 1000,
    minFps: 1000 / sorted[sorted.length - 1],
  };
}

function finishBench() {
  const segments = bench.done.map((segment) => ({
    label: segment.label,
    mode: segment.mode,
    ...summarize(segment.deltas),
  }));
  bench = null;

  ui.resultBody.replaceChildren(...segments.map((s) => {
    const row = document.createElement('tr');
    for (const value of [s.label, fmtFps(s.avgFps), fmtFps(s.lowFps), fmtFps(s.minFps)]) {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.append(cell);
    }
    return row;
  }));

  const worstLow = Math.min(...segments.map((s) => s.lowFps));
  const [level, text] = judge(worstLow, loaded.loadMs);
  ui.verdict.className = `verdict ${level}`;
  ui.verdict.textContent = text;

  lastResult = {
    scene: loaded.url,
    splatCount: loaded.splatCount,
    loadSeconds: Number((loaded.loadMs / 1000).toFixed(1)),
    sphericalHarmonicsDegree: loaded.options.sh,
    sharedMemory: loaded.options.shared,
    crossOriginIsolated: self.crossOriginIsolated,
    devicePixelRatio: loaded.options.dpr ? devicePixelRatio : 1,
    viewport: `${innerWidth}x${innerHeight}`,
    durationSeconds: Number(ui.duration.value),
    segments: segments.map((s) => ({
      label: s.label, frames: s.frames,
      avgFps: Number(s.avgFps.toFixed(1)),
      lowFps: Number(s.lowFps.toFixed(1)),
      minFps: Number(s.minFps.toFixed(1)),
    })),
    userAgent: navigator.userAgent,
  };

  ui.result.hidden = false;
  ui.copy.textContent = '결과 복사';
  ui.load.disabled = ui.bench.disabled = false;
  setStatus('측정 완료.');
}

// 게이트 판정. 기준은 1% 저점 — 데모 중 한 번 끊기면 평균이 좋아도 소용없다.
function judge(lowFps, loadMs) {
  const slowLoad = loadMs > 20000
    ? ' 다만 로드가 20초를 넘어 데모 시작 전 미리 띄워둬야 한다.'
    : '';
  if (lowFps >= 45) return ['pass', `합격 — 1% 저점 ${fmtFps(lowFps)}fps. 웹 GS로 진행한다.${slowLoad}`];
  if (lowFps >= 30) return ['warn', `조건부 — 1% 저점 ${fmtFps(lowFps)}fps. 웹 GS로 가되 SH 0·1배 해상도로 낮춰 여유를 확보한다.${slowLoad}`];
  return ['fail', `부적합 — 1% 저점 ${fmtFps(lowFps)}fps. SH 0·1배 해상도로 재측정하고, 그래도 30fps 미만이면 언리얼 폴백(plan/07)을 검토한다.${slowLoad}`];
}

// ── 배선 ─────────────────────────────────────────────────────────────────────

ui.scene.replaceChildren(...SCENES.map((scene) => {
  const option = document.createElement('option');
  option.value = scene.url;
  option.textContent = scene.label;
  return option;
}));

ui.scene.addEventListener('change', () => {
  ui.customRow.hidden = ui.scene.value !== '';
});

ui.load.addEventListener('click', () => void loadScene());
ui.bench.addEventListener('click', startBench);

ui.copy.addEventListener('click', async () => {
  await navigator.clipboard.writeText(JSON.stringify(lastResult, null, 2));
  ui.copy.textContent = '복사됨';
});

if (self.crossOriginIsolated) {
  ui.isolation.textContent = '교차출처 격리 O';
} else {
  ui.isolation.textContent = '교차출처 격리 X — 공유메모리 비활성';
  ui.shared.value = '0';
  ui.shared.disabled = true;
}

addEventListener('beforeunload', () => void disposeViewer());
