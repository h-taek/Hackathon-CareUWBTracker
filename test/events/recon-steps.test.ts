import * as assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  BUNDLED_OPENSPLAT,
  FALLBACK_SAMPLE_FPS,
  RECON_DEFAULTS,
  isToolAvailable,
  missingTools,
  parseDuration,
  probeStep,
  resolveOpenSplatBin,
  sampleFps,
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

test('상류 기본값은 원본 해상도라 scale 필터를 안 건다', () => {
  // Nerfstudio는 COLMAP에 원본을 넘기고, COLMAP 4.x의 max_image_size도 -1(무제한)이다.
  const frames = step('frames');
  assert.equal(frames.command, 'ffmpeg');
  assert.equal(argOf('frames', '-i'), paths.video);
  assert.equal(argOf('frames', '-vf').includes('scale='), false);
  assert.equal(argOf('frames', '-frames:v'), String(RECON_DEFAULTS.targetFrames));
  assert.equal(frames.args.at(-1), path.join(framesDir(paths.workDir), 'f%04d.jpg'));
});

test('가로를 지정하면 scale 필터가 붙고 세로는 -2로 자동 계산된다', () => {
  // 홀수 높이는 인코더가 거부한다. 가로만 정하고 세로는 맡기는 게 맞다.
  const scaled = reconSteps(paths, { ...RECON_DEFAULTS, frameWidth: 1600 }, 60);
  const vf = scaled.find((s) => s.name === 'frames')!.args;
  assert.match(vf[vf.indexOf('-vf') + 1], /,scale=1600:-2$/);
});

test('프레임은 영상 전체에 고르게 편다 — 앞부분만 자르지 않는다', () => {
  // fps로 잡으면 119초 영상의 앞 75초만 남는 일이 실제로 있었다.
  assert.equal(sampleFps(300, 60), 5, '60초에 300장이면 5fps');
  assert.equal(sampleFps(300, 120), 2.5, '120초면 2.5fps');
  assert.equal(sampleFps(300, 600), 0.5, '10분이면 0.5fps');
  const long = reconSteps(paths, RECON_DEFAULTS, 119);
  assert.match(long.find((s) => s.name === 'frames')!.args.join(' '), /fps=2\.521/);
});

test('길이를 못 재면 폴백 간격으로 뽑고 그 사실이 설명에 남는다', () => {
  assert.equal(sampleFps(300, null), FALLBACK_SAMPLE_FPS);
  assert.equal(sampleFps(300, 0), FALLBACK_SAMPLE_FPS);
  assert.match(step('frames').what, /길이를 못 재/);
});

test('ffprobe로 길이를 재고 출력에서 초를 뽑는다', () => {
  const probe = probeStep(paths);
  assert.equal(probe.command, 'ffprobe');
  assert.equal(probe.args.at(-1), paths.video);
  assert.ok(probe.args.includes('format=duration'));
  assert.equal(parseDuration('64.000000\n'), 64);
  assert.equal(parseDuration('  119.5  '), 119.5);
  assert.equal(parseDuration('N/A'), null);
  assert.equal(parseDuration(''), null);
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
  }, 60);
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
    RECON_FRAMES: '120',
    RECON_ITERS: '느리게',
    OPENSPLAT_BIN: '/x/opensplat',
  });
  assert.equal(tuning.targetFrames, 120);
  assert.equal(tuning.numIters, RECON_DEFAULTS.numIters);
  assert.equal(tuning.openSplatBin, '/x/opensplat');
});

test('단계마다 사람이 읽는 설명이 붙어 있다', () => {
  // 30분 뒤에 실패했을 때 어디서 막혔는지가 로그에 남아야 한다.
  for (const s of steps()) assert.ok(s.what.length > 0, `${s.name}에 설명이 없다`);
});

// ── 실행마다 받는 설정 (화면에서 넘어온다) ──

test('질의 문자열에서 이번 실행 설정만 골라낸다', () => {
  const picked = tuningFromParams(new URLSearchParams('frames=120&frameWidth=1200&iters=300'));
  assert.deepEqual(picked, { targetFrames: 120, frameWidth: 1200, numIters: 300 });
});

test('안 준 값은 아예 빼서 돌려준다 — 호출부가 기본값 위에 덮는다', () => {
  assert.deepEqual(tuningFromParams(new URLSearchParams('frames=120')), { targetFrames: 120 });
  assert.deepEqual(tuningFromParams(new URLSearchParams()), {});
  assert.deepEqual(tuningFromParams(new URLSearchParams('frames=')), {}, '빈칸은 안 준 것과 같다');
});

test('가로 0은 받는다 — 0이 원본 그대로라는 뜻이다', () => {
  assert.deepEqual(tuningFromParams(new URLSearchParams('frameWidth=0')), { frameWidth: 0 });
  assert.deepEqual(tuningFromParams(new URLSearchParams('frames=0')), {}, '장수 0은 뜻이 없다');
});

test('못 읽는 값은 조용히 무시한다 — 빈칸 하나로 화면이 멈추면 안 된다', () => {
  assert.deepEqual(tuningFromParams(new URLSearchParams('frames=많이&frameWidth=-5&iters=abc')), {});
});

test('실행 파일 경로는 질의 문자열로 안 받는다', () => {
  // 브라우저가 서버에서 실행할 바이너리를 정하게 두면 안 된다.
  const picked = tuningFromParams(new URLSearchParams('openSplatBin=/bin/sh&colmapBin=/bin/sh&ffmpegBin=/bin/sh'));
  assert.deepEqual(picked, {});
});

test('실행 설정이 서버 기본값 위에 덮인다', () => {
  const merged = { ...RECON_DEFAULTS, ...tuningFromParams(new URLSearchParams('frames=120')) };
  assert.equal(merged.targetFrames, 120);
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

test('경로가 섞인 실행 파일은 그 자리를 그대로 본다', () => {
  const at = (want: string) => (f: string) => f === want;

  assert.equal(isToolAvailable('/opt/bin/colmap', {}, at('/opt/bin/colmap')), true);
  assert.equal(isToolAvailable('/opt/bin/colmap', {}, () => false), false);
  // 윈도우 경로도 경로다. 구분자를 '/'로만 보면 있는 도구를 없다고 한다.
  assert.equal(isToolAvailable('C:\\tools\\opensplat.exe', {}, at('C:\\tools\\opensplat.exe')), true);
  assert.equal(isToolAvailable('./opensplat', {}, at('./opensplat')), true);
});

test('이름만 온 실행 파일은 PATH를 뒤진다', () => {
  const env = { PATH: ['/usr/bin', '/opt/homebrew/bin'].join(path.delimiter) };

  assert.equal(isToolAvailable('ffmpeg', env, (f) => f === path.join('/opt/homebrew/bin', 'ffmpeg')), true);
  assert.equal(isToolAvailable('ffmpeg', env, () => false), false);
  // PATH 자체가 없으면 뒤질 자리가 없다. 있다고 우기면 spawn이 ENOENT로 죽는다.
  assert.equal(isToolAvailable('ffmpeg', {}, () => true), false);
});

test('윈도우는 PATHEXT의 확장자를 붙여 가며 찾는다', () => {
  // 윈도우 PATH에는 확장자 없는 `ffmpeg`가 없다. `ffmpeg.exe`가 있다.
  // PATH 값에 `C:\`를 안 쓰는 이유: 이 테스트가 POSIX 호스트에서도 도는데, 거기서는
  // `path.delimiter`가 `:`라 드라이브 문자가 쪼개진다. 여기서 보려는 것은 PATHEXT다.
  const env = { PATH: '/tools', PATHEXT: '.COM;.EXE;.BAT' };
  assert.equal(isToolAvailable('ffmpeg', env, (f) => f === path.join('/tools', 'ffmpeg.EXE')), true);
  assert.equal(isToolAvailable('ffmpeg', env, (f) => f === path.join('/tools', 'ffmpeg')), true);
  assert.equal(isToolAvailable('ffmpeg', env, () => false), false);
});

test('없는 도구를 파이프라인 순서대로 알려준다', () => {
  const env = { PATH: '/usr/bin' };
  const has = (...names: string[]) => (f: string) => names.some((n) => f === path.join('/usr/bin', n));

  assert.deepEqual(missingTools(RECON_DEFAULTS, env, () => true), []);
  assert.deepEqual(
    missingTools(RECON_DEFAULTS, env, has('ffmpeg', 'ffprobe')),
    ['colmap', 'opensplat'],
    '순서는 파이프라인 순서다 — 어디서 막히는지 그대로 읽힌다',
  );
  assert.deepEqual(
    missingTools(RECON_DEFAULTS, env, () => false),
    ['ffmpeg', 'ffprobe', 'colmap', 'opensplat'],
  );
  // 이름이 아니라 설정된 실행 파일을 보고한다. OPENSPLAT_BIN을 준 자리에서 'opensplat'이
  // 없다고 하면 어느 경로를 고쳐야 하는지 알 수 없다.
  assert.deepEqual(
    missingTools({ ...RECON_DEFAULTS, openSplatBin: '/build/opensplat' }, env, has('ffmpeg', 'ffprobe', 'colmap')),
    ['/build/opensplat'],
  );
});

test('화면 폼 기본값과 서버 기본값이 같다', () => {
  // 두 벌이 다르면 "기본으로 돌렸다"가 어느 쪽인지 알 수 없어진다. 실제로 한 번 어긋났다.
  const html = fs.readFileSync(new URL('../../server/public/recon/index.html', import.meta.url), 'utf8');
  const formValue = (id: string) => {
    const m = new RegExp(`id="${id}"[^>]*value="([0-9.]+)"`).exec(html);
    return m ? Number(m[1]) : null;
  };
  assert.equal(formValue('frames'), RECON_DEFAULTS.targetFrames);
  assert.equal(formValue('frameWidth'), RECON_DEFAULTS.frameWidth);
  assert.equal(formValue('iters'), RECON_DEFAULTS.numIters);
  assert.match(html, /id="gpu"[^>]*checked/, 'GPU 기본 켬도 같아야 한다');
});
