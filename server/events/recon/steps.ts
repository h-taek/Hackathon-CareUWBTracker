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
  /**
   * 목표 프레임 수. **영상 길이에 맞춰 균등 추출한다** — fps로 잡으면 긴 영상에서
   * 앞부분만 남고 뒤가 통째로 잘린다(119초 영상의 앞 75초만 쓰고 있었다).
   * Nerfstudio `ns-process-data video`의 `num_frames_target`과 같은 개념이다.
   */
  targetFrames: number;
  /**
   * 프레임 가로 픽셀. **0이면 원본 그대로.** Nerfstudio는 COLMAP에 원본을 넘기고,
   * COLMAP 4.x도 `FeatureExtraction.max_image_size = -1`이라 줄이지 않는다.
   * 4K가 느리면 여기서 줄인다.
   */
  frameWidth: number;
  /** 3DGS 학습 반복 수 */
  numIters: number;
  /**
   * COLMAP 특징 추출·매칭에 GPU를 쓸지. **CUDA가 아니라 OpenGL(SiftGPU) 경로**라
   * brew의 `without CUDA` 빌드에서도 돈다.
   *
   * 실측(1600×1200 40장, M5 Max): 추출 13.2초 → 3.1초, 매칭 12.4초 → 9.2초.
   * 대신 **특징점을 17% 덜 찾는다**(평균 13,157 → 10,952). 자세를 못 푸는 장면에서는
   * 끄는 쪽이 유리할 수 있어 실행마다 고를 수 있게 뒀다.
   *
   * 화면 세션이 없는 환경(SSH 등)에서는 OpenGL 컨텍스트를 못 잡아 실패할 수 있다.
   */
  useGpu: boolean;
  /** opensplat 실행 파일 */
  openSplatBin: string;
  /** colmap 실행 파일 */
  colmapBin: string;
  /** ffmpeg 실행 파일 */
  ffmpegBin: string;
  /** ffprobe 실행 파일 — 영상 길이를 재서 균등 추출 간격을 정한다 */
  ffprobeBin: string;
}

/**
 * **전부 상류 기본값이다.** 우리가 고른 값이 아니다.
 *
 * | 값 | 출처 |
 * |---|---|
 * | `targetFrames 300` | Nerfstudio `ns-process-data video`의 `num_frames_target` |
 * | `frameWidth 0`(원본) | Nerfstudio는 COLMAP에 원본을 넘긴다. COLMAP 4.x의 `max_image_size`도 -1 |
 * | `numIters 30000` | OpenSplat `--num-iters` |
 * | `useGpu true` | COLMAP `FeatureExtraction.use_gpu` / `FeatureMatching.use_gpu` |
 *
 * **이 장비에서는 느리다.** COLMAP 매핑이 CPU 전용이고 프레임 장수에 급히 늘어난다
 * (1600px 128장에 80초 실측). 1건에 10~15분을 예상한다.
 *
 * 그래도 깎지 않는 이유: **근거 없는 중간값이 기준 행세를 하면 안 된다.** 급하면
 * 화면에서 낮춘다 — 거기서 낮춘 값은 "이번에 이렇게 돌렸다"로 기록에 남는다.
 */
export const RECON_DEFAULTS: ReconTuning = {
  targetFrames: 300,
  frameWidth: 0,
  numIters: 30000,
  useGpu: true,
  openSplatBin: 'opensplat',
  colmapBin: 'colmap',
  ffmpegBin: 'ffmpeg',
  ffprobeBin: 'ffprobe',
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

/** 영상 길이(초)를 재는 명령. 균등 추출 간격이 여기서 나온다. */
export function probeStep(paths: ReconPaths, tuning: ReconTuning = RECON_DEFAULTS): ReconStep {
  return {
    name: 'probe',
    what: '영상 길이를 재서 프레임을 고르게 뽑을 간격을 정한다',
    command: tuning.ffprobeBin,
    args: [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1',
      paths.video,
    ],
  };
}

/** ffprobe 출력에서 길이(초)를 뽑는다. 못 읽으면 null. */
export function parseDuration(output: string): number | null {
  const value = Number(String(output).trim().split('\n').pop());
  return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * 목표 장수를 영상 전체에 고르게 펴는 추출 fps.
 * 길이를 못 잰 경우를 대비해 폴백을 둔다 — 여기서 멈추면 아무것도 못 한다.
 */
export function sampleFps(targetFrames: number, durationSec: number | null): number {
  if (!durationSec || durationSec <= 0) return FALLBACK_SAMPLE_FPS;
  // 소수 셋째 자리까지. 너무 자르면 긴 영상에서 목표 장수를 못 채운다.
  return Math.max(0.001, Math.round((targetFrames / durationSec) * 1000) / 1000);
}

/** 길이를 못 쟀을 때 쓰는 값. 1~2분 촬영에서 300장 근처가 나온다. */
export const FALLBACK_SAMPLE_FPS = 3;

export function reconSteps(
  paths: ReconPaths,
  tuning: ReconTuning = RECON_DEFAULTS,
  durationSec: number | null = null,
): ReconStep[] {
  const { workDir } = paths;
  const frames = framesDir(workDir);
  const project = projectDir(workDir);
  const database = path.join(workDir, 'database.db');
  const images = path.join(project, 'images');
  const sparse = path.join(project, 'sparse');

  const fps = sampleFps(tuning.targetFrames, durationSec);
  // scale의 -2는 가로에 맞춰 세로를 짝수로 자동 계산하라는 뜻이다. 홀수면 인코더가 거부한다.
  const filters = [`fps=${fps}`];
  if (tuning.frameWidth > 0) filters.push(`scale=${tuning.frameWidth}:-2`);

  return [
    {
      name: 'frames',
      what: durationSec
        ? `${Math.round(durationSec)}초 영상에서 ${tuning.targetFrames}장을 고르게 뽑는다(${fps}fps)`
        : `영상 길이를 못 재 ${fps}fps로 뽑는다(최대 ${tuning.targetFrames}장)`,
      command: tuning.ffmpegBin,
      args: [
        '-hide_banner', '-loglevel', 'error', '-y',
        // 진행 표시용. 이걸 안 주면 ffmpeg가 조용해서 화면이 멈춘 것처럼 보인다.
        '-progress', 'pipe:1',
        '-i', paths.video,
        '-vf', filters.join(','),
        '-frames:v', String(tuning.targetFrames),
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
        // **COLMAP 4.x 옵션 이름이다.** 3.x는 `--SiftExtraction.use_gpu`였고, 4.x에서
        // 이 값만 FeatureExtraction 쪽으로 옮겨갔다(나머지 SiftExtraction.* 는 그대로다).
        '--FeatureExtraction.use_gpu', tuning.useGpu ? '1' : '0',
      ],
    },
    {
      name: 'colmap:match',
      what: '이웃 프레임끼리 짝을 짓는다(영상이라 순서가 있어 순차 매칭이 훨씬 빠르다)',
      command: tuning.colmapBin,
      args: [
        'sequential_matcher',
        '--database_path', database,
        // 3.x는 `--SiftMatching.use_gpu`였다. 위와 같은 개편이다.
        '--FeatureMatching.use_gpu', tuning.useGpu ? '1' : '0',
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
export const TUNABLE_BY_REQUEST = ['targetFrames', 'frameWidth', 'numIters'] as const;

/**
 * 질의 문자열 → 이 실행에만 쓸 설정. 없는 값은 빼고 돌려주므로 호출부가 기본값 위에 덮으면 된다.
 * 환경변수는 기본값 자리로 남는다(서버 전체 기본), 여기 온 값이 그 위를 덮는다(이번 실행).
 */
export function tuningFromParams(params: URLSearchParams): Partial<ReconTuning> {
  const picked: Partial<ReconTuning> = {};
  const map: Record<(typeof TUNABLE_BY_REQUEST)[number], string> = {
    targetFrames: 'frames', frameWidth: 'frameWidth', numIters: 'iters',
  };
  for (const key of TUNABLE_BY_REQUEST) {
    const raw = params.get(map[key]);
    if (raw === null || raw === '') continue;
    const value = Number(raw);
    // 음수는 조용히 무시한다. 여기서 400을 내면 화면이 빈칸 하나로 못 돌아간다.
    // frameWidth만 0을 받는다 — 0이 "원본 그대로"라는 뜻이다.
    const floor = key === 'frameWidth' ? 0 : 1;
    if (Number.isFinite(value) && value >= floor) picked[key] = value;
  }
  const gpu = params.get('gpu');
  if (gpu === '0' || gpu === '1') picked.useGpu = gpu === '1';
  return picked;
}

export function tuningFromEnv(
  env: Record<string, string | undefined> = process.env,
): Partial<ReconTuning> {
  return {
    targetFrames: num(env, 'RECON_FRAMES', RECON_DEFAULTS.targetFrames),
    frameWidth: num(env, 'RECON_FRAME_WIDTH', RECON_DEFAULTS.frameWidth, 0),
    numIters: num(env, 'RECON_ITERS', RECON_DEFAULTS.numIters),
    useGpu: env.RECON_GPU !== '0',
    openSplatBin: env.OPENSPLAT_BIN || RECON_DEFAULTS.openSplatBin,
    colmapBin: env.COLMAP_BIN || RECON_DEFAULTS.colmapBin,
    ffmpegBin: env.FFMPEG_BIN || RECON_DEFAULTS.ffmpegBin,
    ffprobeBin: env.FFPROBE_BIN || RECON_DEFAULTS.ffprobeBin,
  };
}

function num(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
  floor = 1,
): number {
  const parsed = Number(env[key]);
  return Number.isFinite(parsed) && parsed >= floor ? parsed : fallback;
}
