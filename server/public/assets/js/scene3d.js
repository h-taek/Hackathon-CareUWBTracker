// 대시보드 3D 실사 패널(F3). 가우시안 스플랫 씬을 띄우고 낙상 위치에 마커를 찍는다.
// 별도 언리얼 창이 아니라 대시보드 안에서 렌더한다(plan/07). 성능 게이트는 2026-07-26 통과.
//
// dashboard.js(클래식 스크립트)가 동적 import로 불러 쓴다. 여기서만 ESM인 이유는
// three·gaussian-splats-3d가 모듈이라서다 — 임포트 맵은 index.html에 있다.

import * as THREE from 'three';
import * as GS from '@mkkellogg/gaussian-splats-3d';

const CONFIG_URL = '/assets/splat/scene.json';

// 3DGS 학습 결과물은 y축이 아래를 향한다(INRIA 관례). 뒤집으면 씬이 거꾸로 보인다.
const CAMERA_UP = [0, -1, 0];
const FOCUS_MS = 700;          // 마커로 카메라가 옮겨가는 시간
const OVERVIEW_ELEVATION = Math.PI / 4;

let config = null;
let viewer = null;
let host = null;
let frameHandle = 0;
let running = false;
let ready = false;
let onStatus = () => {};

let markerScene = null;        // 스플랫 위에 덧그리는 마커 전용 씬
let marker = null;
let markerPulse = null;

let align = null;              // 맵(m) → 씬 좌표 변환 파라미터
let overviewTarget = null;     // 씬 중심(경보 없을 때 바라보는 곳)
let overviewDistance = 10;

// 카메라 이동 보간
let travel = null;             // { fromPos, toPos, fromTarget, toTarget, startedAt }

// ── 설정 ─────────────────────────────────────────────────────────────────────

async function loadConfig() {
  if (config) return config;
  const response = await fetch(CONFIG_URL);
  if (!response.ok) throw new Error(`씬 설정을 못 읽었다(${response.status})`);
  config = await response.json();
  return config;
}

// ── 씬 크기 ──────────────────────────────────────────────────────────────────

// 스플랫 중심 표본의 10~90 백분위. 전체 바운딩박스는 멀리 떨어진 배경 스플랫 몇 개에
// 끌려 터무니없이 커져서, 그걸 기준으로 삼으면 카메라도 정합도 다 어긋난다.
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
    const cut = Math.floor(values.length * 0.1);
    return [values[cut], values[values.length - 1 - cut]];
  });
  return {
    center: new THREE.Vector3(...bounds.map(([lo, hi]) => (lo + hi) / 2)),
    size: new THREE.Vector3(...bounds.map(([lo, hi]) => hi - lo)),
    min: new THREE.Vector3(...bounds.map(([lo]) => lo)),
  };
}

// 씬이 화면에 꽉 차는 거리. 배수를 감으로 곱하면 씬마다 너무 멀거나 벽 안에 박힌다.
function fitDistance(size, fovDegrees) {
  const halfExtent = 0.5 * Math.max(size.x, size.y, size.z);
  return Math.max(halfExtent / Math.tan((fovDegrees * Math.PI) / 360), 1) * 1.5;
}

// ── 좌표 정합(I2) ────────────────────────────────────────────────────────────
// 맵은 미터 단위 2D 평면도(x=가로, y=세로), 씬은 스플랫 좌표계(y가 높이·아래 방향).
// 실사 맵을 받으면 scene.json의 align.mode를 fixed로 바꾸고 실측 숫자를 채운다.

function buildAlign(settings, map, extent) {
  if (settings.mode === 'fixed') {
    const yaw = ((settings.yawDegrees || 0) * Math.PI) / 180;
    return {
      scale: settings.unitsPerMeter || 1,
      origin: new THREE.Vector3(...(settings.origin || [0, 0, 0])),
      cos: Math.cos(yaw),
      sin: Math.sin(yaw),
      floorY: settings.floorY || 0,
    };
  }

  // auto: 맵 bounds를 씬 수평 범위에 가운데 맞춤으로 눌러 담는다. 프록시 씬으로 배선을
  // 확인하기 위한 임시 정합이라 실제 방 구조와는 일치하지 않는다.
  const [mx0, mx1] = map.bounds.x;
  const [my0, my1] = map.bounds.y;
  const mapWidth = Math.max(mx1 - mx0, 0.001);
  const mapDepth = Math.max(my1 - my0, 0.001);
  const scale = Math.min(extent.size.x / mapWidth, extent.size.z / mapDepth);
  return {
    scale,
    origin: new THREE.Vector3(
      extent.center.x - ((mx0 + mx1) / 2) * scale,
      // 바닥은 씬 아래쪽. y가 아래를 향하므로 최댓값이 바닥에 가깝다.
      extent.center.y + extent.size.y * 0.35,
      extent.center.z - ((my0 + my1) / 2) * scale,
    ),
    cos: 1,
    sin: 0,
    floorY: extent.center.y + extent.size.y * 0.35,
  };
}

function toScene(x, y) {
  const sx = (x * align.cos - y * align.sin) * align.scale;
  const sz = (x * align.sin + y * align.cos) * align.scale;
  return new THREE.Vector3(align.origin.x + sx, align.floorY, align.origin.z + sz);
}

// ── 마커 ─────────────────────────────────────────────────────────────────────
// 스플랫 렌더가 끝난 뒤 깊이를 지우고 덧그린다. 벽 뒤에 있어도 보여야 관제가 되기 때문에
// 일부러 가려지지 않게 했다.

function buildMarker(unit) {
  markerScene = new THREE.Scene();
  marker = new THREE.Group();

  const sphere = new THREE.Mesh(
    new THREE.SphereGeometry(unit * 0.18, 20, 14),
    new THREE.MeshBasicMaterial({ color: 0xf85149 }),
  );
  sphere.position.y = -unit * 0.55;

  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(unit * 0.035, unit * 0.035, unit * 1.1, 10),
    new THREE.MeshBasicMaterial({ color: 0xf85149, transparent: true, opacity: 0.55 }),
  );
  beam.position.y = -unit * 0.55;

  markerPulse = new THREE.Mesh(
    new THREE.RingGeometry(unit * 0.42, unit * 0.5, 40),
    new THREE.MeshBasicMaterial({ color: 0xf85149, transparent: true, opacity: 0.9, side: THREE.DoubleSide }),
  );
  markerPulse.rotation.x = Math.PI / 2;

  marker.add(sphere, beam, markerPulse);
  marker.visible = false;
  markerScene.add(marker);
}

function animateMarker(nowSeconds) {
  if (!markerPulse || !marker.visible) return;
  const phase = (nowSeconds % 1.8) / 1.8;
  const scale = 0.7 + phase * 0.9;
  markerPulse.scale.set(scale, scale, scale);
  markerPulse.material.opacity = 0.9 * (1 - phase);
}

// ── 카메라 ───────────────────────────────────────────────────────────────────

function startTravel(toPos, toTarget) {
  travel = {
    fromPos: viewer.camera.position.clone(),
    toPos,
    fromTarget: viewer.controls.target.clone(),
    toTarget,
    startedAt: performance.now(),
  };
}

function stepTravel(now) {
  if (!travel) return;
  const t = Math.min((now - travel.startedAt) / FOCUS_MS, 1);
  const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
  viewer.camera.position.lerpVectors(travel.fromPos, travel.toPos, eased);
  viewer.controls.target.lerpVectors(travel.fromTarget, travel.toTarget, eased);
  viewer.camera.lookAt(viewer.controls.target);
  if (t >= 1) travel = null;
}

function overviewPose() {
  const distance = overviewDistance;
  return {
    position: new THREE.Vector3(
      overviewTarget.x + distance * Math.cos(OVERVIEW_ELEVATION),
      overviewTarget.y - distance * Math.sin(OVERVIEW_ELEVATION),
      overviewTarget.z,
    ),
    target: overviewTarget.clone(),
  };
}

// ── 렌더 루프 ────────────────────────────────────────────────────────────────

function frame(now) {
  frameHandle = requestAnimationFrame(frame);
  stepTravel(now);
  animateMarker(now / 1000);

  viewer.update();
  viewer.render();

  // 마커는 스플랫 다음에, 깊이를 지우고 그린다(항상 보이게).
  const renderer = viewer.renderer;
  const savedAutoClear = renderer.autoClear;
  renderer.autoClear = false;
  renderer.clearDepth();
  renderer.render(markerScene, viewer.camera);
  renderer.autoClear = savedAutoClear;
}

function startLoop() {
  if (running || !ready) return;
  running = true;
  frameHandle = requestAnimationFrame(frame);
}

function stopLoop() {
  if (frameHandle) cancelAnimationFrame(frameHandle);
  frameHandle = 0;
  running = false;
}

// ── 공개 API ─────────────────────────────────────────────────────────────────

/**
 * 3D 패널을 준비한다. 뷰어 생성과 씬 로드는 처음 한 번만 하고, 이후 호출은 렌더만 재개한다.
 * 패널이 화면에 보이는 상태에서 불러야 한다(숨겨져 있으면 렌더러 크기가 0으로 잡힌다).
 */
export async function open(hostElement, map, statusCallback) {
  host = hostElement;
  onStatus = statusCallback || (() => {});
  if (ready) { startLoop(); return; }
  if (viewer) return;               // 로드 진행 중

  const settings = await loadConfig();

  viewer = new GS.Viewer({
    rootElement: host,
    selfDrivenMode: false,          // 마커를 덧그려야 해서 렌더 순서를 직접 잡는다
    useBuiltInControls: true,
    cameraUp: CAMERA_UP,
    ignoreDevicePixelRatio: !settings.quality.retina,
    sharedMemoryForWorkers: self.crossOriginIsolated,
    // gpuAcceleratedSort는 켜지 마라(0.4.7). 이 모드에서는 스플랫 좌표를 정렬 워커에
    // 올리는 경로가 통째로 생략돼 워커가 "그릴 스플랫 0개"를 돌려주고, 오류 없이 화면만
    // 검게 남는다. 로드 지표와 FPS는 정상으로 찍혀서 원인 찾기가 고약하다.
    gpuAcceleratedSort: false,
    dynamicScene: false,
    sphericalHarmonicsDegree: settings.quality.sphericalHarmonicsDegree,
    renderMode: GS.RenderMode.Always,
    sceneRevealMode: GS.SceneRevealMode.Instant,
    logLevel: GS.LogLevel.None,
  });

  onStatus('실사 씬 불러오는 중…');
  try {
    await viewer.addSplatScene(settings.url, {
      showLoadingUI: false,
      progressiveLoad: false,
      onProgress: (percent) => onStatus(`실사 씬 불러오는 중… ${Math.round(percent)}%`),
    });
  } catch (error) {
    onStatus(`실사 씬을 못 불러왔다 — ${settings.url}. assets/splat/README.md 참조`);
    await viewer.dispose().catch(() => {});
    viewer = null;
    throw error;
  }

  const extent = measureExtent(viewer.splatMesh);
  align = buildAlign(settings.align, map, extent);
  overviewTarget = extent.center.clone();
  overviewDistance = fitDistance(extent.size, viewer.camera.fov);

  const unit = align.scale;         // 스플랫 좌표에서의 1m
  buildMarker(unit);

  const pose = overviewPose();
  viewer.camera.position.copy(pose.position);
  viewer.controls.target.copy(pose.target);
  viewer.camera.lookAt(pose.target);

  ready = true;
  onStatus('');
  startLoop();
}

/** 렌더를 멈춘다(패널을 닫을 때). 씬은 메모리에 남겨 다음 경보에 즉시 뜨게 한다. */
export function close() {
  stopLoop();
}

/** 낙상 위치(맵 좌표 m)에 마커를 찍고 카메라를 맞춘다. */
export function focus(pos) {
  if (!ready) return;
  if (!pos) { marker.visible = false; return; }

  const point = toScene(pos.x, pos.y);
  marker.position.copy(point);
  marker.visible = true;

  const settings = config.camera;
  const distance = settings.distance * align.scale;
  const elevation = (settings.elevationDegrees * Math.PI) / 180;

  // 현재 보고 있는 수평 방향은 유지하고 거리·고도만 통일한다(화면이 덜 튄다).
  const direction = new THREE.Vector3().subVectors(viewer.camera.position, viewer.controls.target);
  direction.y = 0;
  if (direction.lengthSq() < 1e-6) direction.set(1, 0, 0);
  direction.normalize();

  startTravel(
    new THREE.Vector3(
      point.x + direction.x * distance * Math.cos(elevation),
      point.y - distance * Math.sin(elevation),
      point.z + direction.z * distance * Math.cos(elevation),
    ),
    point.clone(),
  );
}

/** 경보 해제 — 마커를 지우고 씬 전경으로 돌아간다. */
export function clearFocus() {
  if (!ready) return;
  marker.visible = false;
  const pose = overviewPose();
  startTravel(pose.position, pose.target);
}
