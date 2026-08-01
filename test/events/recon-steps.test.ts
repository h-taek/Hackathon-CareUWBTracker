import * as assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  BUNDLED_OPENSPLAT,
  RECON_DEFAULTS,
  resolveOpenSplatBin,
  framesDir,
  outputPly,
  projectDir,
  reconSteps,
  tuningFromEnv,
  tuningFromParams,
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

test('GPU 스위치 이름이 COLMAP 4.x 것이어야 한다', () => {
  // 3.x의 SiftExtraction/SiftMatching을 쓰면 "unrecognised option"으로 죽는다 —
  // 실제로 한 번 밟았다.
  assert.equal(step('colmap:extract').args.includes('--SiftExtraction.use_gpu'), false);
  assert.equal(step('colmap:match').args.includes('--SiftMatching.use_gpu'), false);
  assert.ok(step('colmap:extract').args.includes('--FeatureExtraction.use_gpu'));
  assert.ok(step('colmap:match').args.includes('--FeatureMatching.use_gpu'));
});

test('COLMAP은 기본으로 GPU를 쓴다 — CUDA가 아니라 OpenGL 경로라 brew 빌드에서도 돈다', () => {
  // 실측(1600×1200 40장, M5 Max): 추출 13.2초 → 3.1초, 매칭 12.4초 → 9.2초.
  assert.equal(RECON_DEFAULTS.useGpu, true);
  assert.equal(argOf('colmap:extract', '--FeatureExtraction.use_gpu'), '1');
  assert.equal(argOf('colmap:match', '--FeatureMatching.use_gpu'), '1');
});

test('GPU를 끄면 두 단계 모두 CPU로 내려간다', () => {
  // GPU가 특징점을 17% 덜 찾아, 자세를 못 푸는 장면에서는 끄는 쪽이 유리할 수 있다.
  const cpu = reconSteps(paths, { ...RECON_DEFAULTS, useGpu: false });
  const argIn = (name: string, flag: string) => {
    const a = cpu.find((s) => s.name === name)!.args;
    return a[a.indexOf(flag) + 1];
  };
  assert.equal(argIn('colmap:extract', '--FeatureExtraction.use_gpu'), '0');
  assert.equal(argIn('colmap:match', '--FeatureMatching.use_gpu'), '0');
});

test('GPU 사용 여부를 질의 문자열과 환경변수로 바꾼다', () => {
  assert.equal(tuningFromParams(new URLSearchParams('gpu=0')).useGpu, false);
  assert.equal(tuningFromParams(new URLSearchParams('gpu=1')).useGpu, true);
  assert.equal(tuningFromParams(new URLSearchParams('gpu=아무거나')).useGpu, undefined, '안 준 것과 같다');
  assert.equal(tuningFromEnv({ RECON_GPU: '0' }).useGpu, false);
  assert.equal(tuningFromEnv({}).useGpu, true);
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

// ── 실행마다 받는 설정 (화면에서 넘어온다) ──

test('질의 문자열에서 이번 실행 설정만 골라낸다', () => {
  const picked = tuningFromParams(new URLSearchParams('fps=6&maxFrames=40&frameWidth=1200&iters=300'));
  assert.deepEqual(picked, { fps: 6, maxFrames: 40, frameWidth: 1200, numIters: 300 });
});

test('안 준 값은 아예 빼서 돌려준다 — 호출부가 기본값 위에 덮는다', () => {
  assert.deepEqual(tuningFromParams(new URLSearchParams('fps=3')), { fps: 3 });
  assert.deepEqual(tuningFromParams(new URLSearchParams()), {});
  assert.deepEqual(tuningFromParams(new URLSearchParams('fps=')), {}, '빈칸은 안 준 것과 같다');
});

test('못 읽는 값은 조용히 무시한다 — 빈칸 하나로 화면이 멈추면 안 된다', () => {
  assert.deepEqual(tuningFromParams(new URLSearchParams('fps=빠르게&maxFrames=0&frameWidth=-5&iters=abc')), {});
});

test('실행 파일 경로는 질의 문자열로 안 받는다', () => {
  // 브라우저가 서버에서 실행할 바이너리를 정하게 두면 안 된다.
  const picked = tuningFromParams(new URLSearchParams('openSplatBin=/bin/sh&colmapBin=/bin/sh&ffmpegBin=/bin/sh'));
  assert.deepEqual(picked, {});
});

test('실행 설정이 서버 기본값 위에 덮인다', () => {
  const merged = { ...RECON_DEFAULTS, ...tuningFromParams(new URLSearchParams('fps=6')) };
  assert.equal(merged.fps, 6);
  assert.equal(merged.numIters, RECON_DEFAULTS.numIters, '안 준 값은 기본값 그대로다');
  assert.equal(merged.colmapBin, RECON_DEFAULTS.colmapBin);
});

test('opensplat은 환경변수 → 프로젝트 빌드본 → PATH 순으로 고른다', () => {
  // 빼먹었을 때 COLMAP을 몇 분 돌린 끝에 죽는 게 가장 비싼 실수라, 서버가 대신 찾는다.
  const bundled = path.resolve('/proj/server', BUNDLED_OPENSPLAT);

  assert.equal(
    resolveOpenSplatBin('/proj/server', { OPENSPLAT_BIN: '/custom/opensplat' }, () => true),
    '/custom/opensplat',
    '환경변수가 가장 세다',
  );
  assert.equal(
    resolveOpenSplatBin('/proj/server', {}, (f) => f === bundled),
    bundled,
    '빌드본이 있으면 그것을 쓴다',
  );
  assert.equal(
    resolveOpenSplatBin('/proj/server', {}, () => false),
    'opensplat',
    '없으면 PATH에 맡긴다',
  );
});

test('빌드본 경로는 빌드 절차가 만드는 자리와 같다', () => {
  // tools/recon/README.md의 cmake 산출 위치. 둘이 어긋나면 자동 탐색이 조용히 실패한다.
  assert.equal(path.resolve('/proj/server', BUNDLED_OPENSPLAT), '/proj/tools/recon/OpenSplat/build/opensplat');
});

test('화면 폼 기본값과 서버 기본값이 같다', () => {
  // 두 벌이 다르면 "기본으로 돌렸다"가 어느 쪽인지 알 수 없어진다. 실제로 한 번 어긋났다.
  const html = fs.readFileSync(new URL('../../server/public/recon/index.html', import.meta.url), 'utf8');
  const formValue = (id: string) => {
    const m = new RegExp(`id="${id}"[^>]*value="([0-9.]+)"`).exec(html);
    return m ? Number(m[1]) : null;
  };
  assert.equal(formValue('fps'), RECON_DEFAULTS.fps);
  assert.equal(formValue('maxFrames'), RECON_DEFAULTS.maxFrames);
  assert.equal(formValue('frameWidth'), RECON_DEFAULTS.frameWidth);
  assert.equal(formValue('iters'), RECON_DEFAULTS.numIters);
  assert.match(html, /id="gpu"[^>]*checked/, 'GPU 기본 켬도 같아야 한다');
});
