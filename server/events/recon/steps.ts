// 재구성 파이프라인의 단계 정의(R-3). **명령을 만들기만 하고 실행하지 않는다.**
//
//   영상 → ffmpeg(프레임) → COLMAP(카메라 자세 + sparse 점) → OpenSplat(.ply)
//
// OpenSplat은 sparse 점이 없으면 못 돈다("random initialization is not supported").
// 그래서 COLMAP이 선택이 아니라 필수 단계다.
//
// 순수 함수로 둔 이유: 인자 한 글자가 틀리면 30분 뒤에 실패한다. 실행 없이 명령줄을
// 그대로 검증할 수 있어야 한다.

import * as path from 'node:path';

export interface ReconPaths {
  /** 입력 영상 절대 경로 */
  video: string;
  /** 작업 폴더 절대 경로. 이 아래에만 쓴다 */
  workDir: string;
}

export interface ReconTuning {
  /** 초당 뽑을 프레임 수. 너무 높이면 COLMAP 매칭이 폭발하고, 낮으면 겹침이 모자라 실패한다 */
  fps: number;
  /** 프레임 장수 상한. 넘으면 COLMAP 매칭 시간이 장수의 제곱으로 는다 */
  maxFrames: number;
  /** 프레임 가로 픽셀. COLMAP 특징 추출이 CPU라 4K 원본을 그대로 넣으면 몇 시간이 된다 */
  frameWidth: number;
  /** 3DGS 학습 반복 수 */
  numIters: number;
  /** opensplat 실행 파일 */
  openSplatBin: string;
  /** colmap 실행 파일 */
  colmapBin: string;
  /** ffmpeg 실행 파일 */
  ffmpegBin: string;
}

export const RECON_DEFAULTS: ReconTuning = {
  fps: 2,
  maxFrames: 150,
  frameWidth: 1600,
  numIters: 2000,
  openSplatBin: 'opensplat',
  colmapBin: 'colmap',
  ffmpegBin: 'ffmpeg',
};

export interface ReconStep {
  /** 로그와 상태 표시에 쓰는 이름 */
  name: string;
  command: string;
  args: string[];
  /** 사람이 읽는 한 줄 설명 — 실패했을 때 어디서 막혔는지 바로 보이게 */
  what: string;
}

export function framesDir(workDir: string): string {
  return path.join(workDir, 'frames');
}

export function sparseDir(workDir: string): string {
  return path.join(workDir, 'sparse');
}

/** OpenSplat이 읽는 COLMAP 프로젝트 루트. images/와 sparse/0/이 나란히 있어야 한다. */
export function projectDir(workDir: string): string {
  return path.join(workDir, 'project');
}

/** COLMAP이 자세를 푼 모델. OpenSplat은 `0`만 읽는다. */
export function modelDir(workDir: string): string {
  return path.join(projectDir(workDir), 'sparse', '0');
}

export function outputPly(workDir: string): string {
  return path.join(workDir, 'scene.ply');
}

export function reconSteps(paths: ReconPaths, tuning: ReconTuning = RECON_DEFAULTS): ReconStep[] {
  const { workDir } = paths;
  const frames = framesDir(workDir);
  const project = projectDir(workDir);
  const database = path.join(workDir, 'database.db');
  const images = path.join(project, 'images');
  const sparse = path.join(project, 'sparse');

  return [
    {
      name: 'frames',
      what: `영상에서 초당 ${tuning.fps}장, 최대 ${tuning.maxFrames}장을 뽑는다`,
      command: tuning.ffmpegBin,
      args: [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-i', paths.video,
        // scale의 -2는 가로에 맞춰 세로를 짝수로 자동 계산하라는 뜻이다. 홀수면 인코더가 거부한다.
        '-vf', `fps=${tuning.fps},scale=${tuning.frameWidth}:-2`,
        '-frames:v', String(tuning.maxFrames),
        '-q:v', '2',
        path.join(frames, 'f%04d.jpg'),
      ],
    },
    {
      name: 'colmap:extract',
      what: 'COLMAP이 프레임마다 특징점을 뽑는다',
      command: tuning.colmapBin,
      args: [
        'feature_extractor',
        '--database_path', database,
        '--image_path', images,
        // 폰 영상은 한 대로 찍은 것이라 카메라 내부 파라미터를 공유시켜야 해가 잘 잡힌다.
        '--ImageReader.single_camera', '1',
        '--ImageReader.camera_model', 'OPENCV',
        // brew colmap이 CUDA 없이 빌드돼 있고, GPU SIFT 경로는 헤드리스에서 화면 컨텍스트를
        // 잡으려다 죽는다. CPU로 못박는다.
        // **COLMAP 4.x 옵션 이름이다.** 3.x는 `--SiftExtraction.use_gpu`였고, 4.x에서
        // 이 값만 FeatureExtraction 쪽으로 옮겨갔다(나머지 SiftExtraction.* 는 그대로다).
        '--FeatureExtraction.use_gpu', '0',
      ],
    },
    {
      name: 'colmap:match',
      what: '이웃 프레임끼리 짝을 짓는다(영상이라 순서가 있어 순차 매칭이 훨씬 빠르다)',
      command: tuning.colmapBin,
      args: [
        'sequential_matcher',
        '--database_path', database,
        // 3.x는 `--SiftMatching.use_gpu`였다. 위와 같은 이유·같은 개편이다.
        '--FeatureMatching.use_gpu', '0',
      ],
    },
    {
      name: 'colmap:map',
      what: '카메라 자세와 sparse 점군을 푼다 — OpenSplat의 필수 입력이다',
      command: tuning.colmapBin,
      args: [
        'mapper',
        '--database_path', database,
        '--image_path', images,
        '--output_path', sparse,
      ],
    },
    {
      name: 'opensplat',
      what: `3DGS를 ${tuning.numIters}회 학습해 .ply를 낸다`,
      command: tuning.openSplatBin,
      args: [
        project,
        '-n', String(tuning.numIters),
        '-o', outputPly(workDir),
      ],
    },
  ];
}

/** 빌드 절차가 만드는 자리(tools/recon/README.md). 서버 폴더 기준 상대 경로다. */
export const BUNDLED_OPENSPLAT = '../tools/recon/OpenSplat/build/opensplat';

/**
 * 쓸 `opensplat`을 정한다. 순서는 환경변수 → 프로젝트 안 빌드본 → PATH.
 *
 * **빌드본을 자동으로 찾는 이유:** 이걸 안 하면 `OPENSPLAT_BIN`을 빼먹었을 때
 * COLMAP을 몇 분 돌린 **끝에** 마지막 단계에서 죽는다. 실패까지 가장 비싼 실수라
 * 서버가 대신 찾아준다. `exists`는 테스트가 갈아끼운다.
 */
export function resolveOpenSplatBin(
  serverDir: string,
  env: Record<string, string | undefined>,
  exists: (file: string) => boolean,
): string {
  if (env.OPENSPLAT_BIN) return env.OPENSPLAT_BIN;
  const bundled = path.resolve(serverDir, BUNDLED_OPENSPLAT);
  return exists(bundled) ? bundled : RECON_DEFAULTS.openSplatBin;
}

/** 화면이 실행마다 넘기는 값. 실행 파일 경로는 여기로 안 받는다 — 브라우저가 정할 일이 아니다. */
export const TUNABLE_BY_REQUEST = ['fps', 'maxFrames', 'frameWidth', 'numIters'] as const;

/**
 * 질의 문자열 → 이 실행에만 쓸 설정. 없는 값은 빼고 돌려주므로 호출부가 기본값 위에 덮으면 된다.
 * 환경변수는 기본값 자리로 남는다(서버 전체 기본), 여기 온 값이 그 위를 덮는다(이번 실행).
 */
export function tuningFromParams(params: URLSearchParams): Partial<ReconTuning> {
  const picked: Partial<ReconTuning> = {};
  const map: Record<(typeof TUNABLE_BY_REQUEST)[number], string> = {
    fps: 'fps', maxFrames: 'maxFrames', frameWidth: 'frameWidth', numIters: 'iters',
  };
  for (const key of TUNABLE_BY_REQUEST) {
    const raw = params.get(map[key]);
    if (raw === null || raw === '') continue;
    const value = Number(raw);
    // 0이나 음수는 조용히 무시한다. 여기서 400을 내면 화면이 빈칸 하나로 못 돌아간다.
    if (Number.isFinite(value) && value > 0) picked[key] = value;
  }
  return picked;
}

export function tuningFromEnv(
  env: Record<string, string | undefined> = process.env,
): Partial<ReconTuning> {
  return {
    fps: num(env, 'RECON_FPS', RECON_DEFAULTS.fps),
    maxFrames: num(env, 'RECON_MAX_FRAMES', RECON_DEFAULTS.maxFrames),
    frameWidth: num(env, 'RECON_FRAME_WIDTH', RECON_DEFAULTS.frameWidth),
    numIters: num(env, 'RECON_ITERS', RECON_DEFAULTS.numIters),
    openSplatBin: env.OPENSPLAT_BIN || RECON_DEFAULTS.openSplatBin,
    colmapBin: env.COLMAP_BIN || RECON_DEFAULTS.colmapBin,
    ffmpegBin: env.FFMPEG_BIN || RECON_DEFAULTS.ffmpegBin,
  };
}

function num(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const parsed = Number(env[key]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
