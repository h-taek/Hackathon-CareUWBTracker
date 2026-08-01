// URL 하나로 스플랫을 띄우는 얇은 뷰어(/recon 전용).
//
// `scene3d.js`와 나눈 이유: 그쪽은 **관제용**이라 scene.json에서 씬·좌표 정합·카메라 프리셋을
// 읽고 낙상 마커를 씬 안에 그린다. 여기는 **사고마다 다른 .ply를 그냥 보기만** 한다.
// 정합할 맵도 찍을 마커도 없다. 같은 모듈에 밀어넣으면 안 쓰는 분기가 절반이 된다.
//
// 뷰어 라이브러리와 그 함정(gpuAcceleratedSort)은 둘이 공유한다 — vendor/README.md.

import * as GS from '@mkkellogg/gaussian-splats-3d';

let viewer = null;
let host = null;
let loadedUrl = null;
let looping = false;

/** 스플랫은 y가 아래로 가는 좌표계로 나온다. scene3d.js와 같은 값이어야 그림이 같다. */
const CAMERA_UP = [0, -1, 0];

function startLoop() {
  if (looping || !viewer) return;
  looping = true;
  const frame = () => {
    if (!looping || !viewer) return;
    viewer.update();
    viewer.render();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

function stopLoop() {
  looping = false;
}

/**
 * 씬 전체가 화면에 들어오는 거리로 카메라를 놓는다.
 *
 * **최소·최대를 그대로 쓰면 안 된다.** 3DGS는 학습 중에 엉뚱하게 멀리 떨어진 스플랫을
 * 몇 개씩 남기는데, 그것들이 범위를 통째로 늘려 화면이 어딘가 이상한 곳을 비추게 된다.
 * 양 끝 5%를 버린 구간을 실제 씬으로 본다.
 */
function frameCamera() {
  const mesh = viewer.splatMesh;
  const count = mesh.getSplatCount();
  if (!count) return;

  const axes = [[], [], []];
  const center = new (viewer.camera.position.constructor)();
  // 전부 훑으면 수십만 개라 느리다. 고르게 솎아 분포만 본다.
  const stride = Math.max(1, Math.floor(count / 20000));
  for (let i = 0; i < count; i += stride) {
    mesh.getSplatCenter(i, center, false);
    axes[0].push(center.x); axes[1].push(center.y); axes[2].push(center.z);
  }
  if (!axes[0].length) return;

  const lo = [], hi = [], mid = [];
  for (let axis = 0; axis < 3; axis += 1) {
    const sorted = axes[axis].sort((a, b) => a - b);
    lo[axis] = sorted[Math.floor(sorted.length * 0.05)];
    hi[axis] = sorted[Math.floor(sorted.length * 0.95)];
    mid[axis] = (lo[axis] + hi[axis]) / 2;
  }

  const size = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1;
  const fov = (viewer.camera.fov * Math.PI) / 180;
  const distance = (size / 2) / Math.tan(fov / 2) * 1.6;

  viewer.controls.target.set(mid[0], mid[1], mid[2]);
  // cameraUp이 -y라 위에서 내려다보려면 y를 빼는 쪽으로 올라가야 한다.
  viewer.camera.position.set(mid[0], mid[1] - distance * 0.4, mid[2] + distance);
  viewer.camera.near = Math.max(0.01, size / 1000);
  viewer.camera.far = distance * 20;
  viewer.camera.updateProjectionMatrix();
  viewer.camera.lookAt(viewer.controls.target);
  viewer.controls.update();
}

/**
 * 스플랫 하나를 띄운다. 같은 URL을 다시 부르면 렌더만 재개하고, 다른 URL이면 통째로 새로 만든다.
 * (0.4.7의 addSplatScene은 교체가 아니라 누적이라, 갈아끼우려면 뷰어를 버리는 게 확실하다.)
 */
export async function show(hostElement, url, onStatus = () => {}) {
  if (viewer && loadedUrl === url && host === hostElement) {
    startLoop();
    return;
  }
  await dispose();

  host = hostElement;
  host.innerHTML = '';
  viewer = new GS.Viewer({
    rootElement: host,
    selfDrivenMode: false,
    useBuiltInControls: true,
    cameraUp: CAMERA_UP,
    sharedMemoryForWorkers: self.crossOriginIsolated,
    // 0.4.7에서 켜면 오류도 경고도 없이 화면만 검게 나온다. vendor/README.md 참조.
    gpuAcceleratedSort: false,
    dynamicScene: false,
    renderMode: GS.RenderMode.Always,
    sceneRevealMode: GS.SceneRevealMode.Instant,
    logLevel: GS.LogLevel.None,
  });

  onStatus('3D 현장 불러오는 중…');
  try {
    await viewer.addSplatScene(url, {
      showLoadingUI: false,
      progressiveLoad: false,
      // 확장자로 형식을 고른다. 첨부 경로는 확장자가 없으므로 여기서 못박는다.
      format: GS.SceneFormat.Ply,
      onProgress: (percent) => onStatus(`3D 현장 불러오는 중… ${Math.round(percent)}%`),
    });
  } catch (error) {
    await dispose();
    throw error;
  }

  loadedUrl = url;
  frameCamera();
  startLoop();
}

export async function dispose() {
  stopLoop();
  if (viewer) {
    await viewer.dispose().catch(() => {});
    viewer = null;
  }
  loadedUrl = null;
}
