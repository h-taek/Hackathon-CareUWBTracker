import * as assert from 'node:assert/strict';
import test from 'node:test';
import * as path from 'node:path';

import {
  RECON_DEFAULTS,
  framesDir,
  outputPly,
  projectDir,
  reconSteps,
  tuningFromEnv,
} from '../../server/events/recon/steps.ts';

const paths = { video: '/data/evt-1/att-1.mp4', workDir: '/data/evt-1/recon/att-1' };
const steps = () => reconSteps(paths);
const step = (name: string) => steps().find((s) => s.name === name)!;
const argOf = (name: string, flag: string) => {
  const args = step(name).args;
  return args[args.indexOf(flag) + 1];
};

test('단계는 프레임 → 특징 → 매칭 → 매핑 → 학습 순이다', () => {
  assert.deepEqual(
    steps().map((s) => s.name),
    ['frames', 'colmap:extract', 'colmap:match', 'colmap:map', 'opensplat'],
  );
});

test('ffmpeg는 지정한 fps·장수·가로폭으로 프레임을 뽑는다', () => {
  const frames = step('frames');
  assert.equal(frames.command, 'ffmpeg');
  assert.equal(argOf('frames', '-vf'), `fps=${RECON_DEFAULTS.fps},scale=${RECON_DEFAULTS.frameWidth}:-2`);
  assert.equal(argOf('frames', '-frames:v'), String(RECON_DEFAULTS.maxFrames));
  assert.equal(argOf('frames', '-i'), paths.video);
  assert.equal(frames.args.at(-1), path.join(framesDir(paths.workDir), 'f%04d.jpg'));
});

test('세로는 -2로 둬서 짝수로 자동 계산된다', () => {
  // 홀수 높이는 인코더가 거부한다. 가로만 정하고 세로는 맡기는 게 맞다.
  assert.match(argOf('frames', '-vf'), /scale=\d+:-2$/);
});

test('COLMAP은 GPU를 쓰지 않는다 — brew colmap이 CUDA 없이 빌드돼 있다', () => {
  // 이름이 COLMAP 4.x 것이어야 한다. 3.x의 SiftExtraction/SiftMatching을 쓰면
  // "unrecognised option"으로 죽는다 — 실제로 한 번 밟았다.
  assert.equal(argOf('colmap:extract', '--FeatureExtraction.use_gpu'), '0');
  assert.equal(argOf('colmap:match', '--FeatureMatching.use_gpu'), '0');
  assert.equal(step('colmap:extract').args.includes('--SiftExtraction.use_gpu'), false);
  assert.equal(step('colmap:match').args.includes('--SiftMatching.use_gpu'), false);
});

test('폰 영상이라 카메라 하나를 공유하게 잡는다', () => {
  assert.equal(argOf('colmap:extract', '--ImageReader.single_camera'), '1');
  assert.equal(argOf('colmap:extract', '--ImageReader.camera_model'), 'OPENCV');
});

test('매칭은 순차 매칭이다 — 영상은 프레임 순서가 있다', () => {
  assert.equal(step('colmap:match').args[0], 'sequential_matcher');
});

test('COLMAP은 project/images를 읽고 project/sparse에 쓴다 — OpenSplat이 보는 배치', () => {
  const project = projectDir(paths.workDir);
  assert.equal(argOf('colmap:extract', '--image_path'), path.join(project, 'images'));
  assert.equal(argOf('colmap:map', '--image_path'), path.join(project, 'images'));
  assert.equal(argOf('colmap:map', '--output_path'), path.join(project, 'sparse'));
});

test('세 COLMAP 단계가 같은 database.db를 쓴다', () => {
  const db = argOf('colmap:extract', '--database_path');
  assert.equal(argOf('colmap:match', '--database_path'), db);
  assert.equal(argOf('colmap:map', '--database_path'), db);
  assert.equal(db, path.join(paths.workDir, 'database.db'));
});

test('opensplat은 COLMAP 프로젝트를 받아 scene.ply를 낸다', () => {
  const opensplat = step('opensplat');
  assert.equal(opensplat.args[0], projectDir(paths.workDir));
  assert.equal(argOf('opensplat', '-o'), outputPly(paths.workDir));
  assert.equal(argOf('opensplat', '-n'), String(RECON_DEFAULTS.numIters));
});

test('모든 산출물이 작업 폴더 안에만 쓰인다', () => {
  // 작업 폴더는 실패하면 통째로 지운다. 밖에 쓰면 찌꺼기가 남는다.
  const writes = [
    step('frames').args.at(-1)!,
    argOf('colmap:extract', '--database_path'),
    argOf('colmap:map', '--output_path'),
    argOf('opensplat', '-o'),
  ];
  for (const target of writes) {
    assert.equal(target.startsWith(paths.workDir), true, `${target}가 작업 폴더 밖이다`);
  }
});

test('실행 파일을 환경변수로 갈아끼운다', () => {
  const custom = reconSteps(paths, {
    ...RECON_DEFAULTS,
    ffmpegBin: '/opt/ffmpeg',
    colmapBin: '/opt/colmap',
    openSplatBin: '/opt/opensplat',
  });
  assert.deepEqual(
    custom.map((s) => s.command),
    ['/opt/ffmpeg', '/opt/colmap', '/opt/colmap', '/opt/colmap', '/opt/opensplat'],
  );
});

test('환경변수가 없으면 기본값이다', () => {
  assert.deepEqual(tuningFromEnv({}), RECON_DEFAULTS);
});

test('환경변수로 튜닝값을 바꾸고, 못 읽는 값은 기본값으로 둔다', () => {
  const tuning = tuningFromEnv({
    RECON_FPS: '4',
    RECON_MAX_FRAMES: '0',
    RECON_ITERS: '느리게',
    OPENSPLAT_BIN: '/x/opensplat',
  });
  assert.equal(tuning.fps, 4);
  assert.equal(tuning.maxFrames, RECON_DEFAULTS.maxFrames, '0은 안 받는다');
  assert.equal(tuning.numIters, RECON_DEFAULTS.numIters);
  assert.equal(tuning.openSplatBin, '/x/opensplat');
});

test('단계마다 사람이 읽는 설명이 붙어 있다', () => {
  // 30분 뒤에 실패했을 때 어디서 막혔는지가 로그에 남아야 한다.
  for (const s of steps()) assert.ok(s.what.length > 0, `${s.name}에 설명이 없다`);
});
