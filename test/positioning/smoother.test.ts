import * as assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPositionSmoother,
  smootherOptionsFromEnv,
  SMOOTHER_DEFAULTS,
} from '../../server/positioning/smoother.ts';

let clock = 0;
const round = (n: number) => Math.round(n * 1e6) / 1e6;

/** ts를 10Hz(100ms)로 자동으로 밀어준다 — 이상치 컷이 프레임 간격을 쓰기 때문. */
function position(tagId: string, x: number, y = 0, z = 0) {
  clock += 100;
  return { tagId, ts: clock, pos: { x, y, z }, source: 'uwb+imu' };
}

/** 데드밴드·이상치를 끈 순수 이동평균. 평균 자체를 검증할 때 쓴다. */
function averageOnly(windowSize: number) {
  return createPositionSmoother({
    windowSize,
    staticDeadbandM: 0,
    movingDeadbandM: 0,
    jumpBaseM: Number.MAX_SAFE_INTEGER,
  });
}

test('첫 좌표는 지연 없이 그대로 반환한다', () => {
  const smoother = averageOnly(3);
  const input = position('tag-a', 3, 6, 0);
  assert.deepEqual(smoother.observe(input).pos, { x: 3, y: 6, z: 0 });
});

test('윈도우가 차는 동안 좌표 산술평균을 반환한다', () => {
  const smoother = averageOnly(3);
  smoother.observe(position('tag-a', 1, 2, 0));
  const result = smoother.observe(position('tag-a', 3, 4, 2));

  assert.deepEqual(result.pos, { x: 2, y: 3, z: 1 });
  assert.equal(result.source, 'uwb+imu');
});

test('윈도우를 넘으면 가장 오래된 좌표를 제외한다', () => {
  const smoother = averageOnly(2);
  smoother.observe(position('tag-a', 1));
  smoother.observe(position('tag-a', 3));
  const result = smoother.observe(position('tag-a', 7));

  assert.equal(result.pos.x, 5);
});

test('태그별 상태를 독립적으로 유지한다', () => {
  const smoother = averageOnly(2);
  smoother.observe(position('tag-a', 0));
  smoother.observe(position('tag-b', 100));

  assert.equal(smoother.observe(position('tag-a', 2)).pos.x, 1);
  assert.equal(smoother.observe(position('tag-b', 104)).pos.x, 102);
});

test('입력 객체와 원본 pos를 변경하지 않는다', () => {
  const smoother = averageOnly(2);
  const input = position('tag-a', 2);
  smoother.observe(position('tag-a', 0));
  const result = smoother.observe(input);

  assert.notEqual(result, input);
  assert.notEqual(result.pos, input.pos);
  assert.deepEqual(input.pos, { x: 2, y: 0, z: 0 });
});

test('태그 하나 또는 전체 상태를 초기화한다', () => {
  const smoother = averageOnly(2);
  smoother.observe(position('tag-a', 0));
  smoother.observe(position('tag-b', 100));
  smoother.reset('tag-a');

  assert.equal(smoother.observe(position('tag-a', 4)).pos.x, 4);
  assert.equal(smoother.observe(position('tag-b', 104)).pos.x, 102);

  smoother.reset();
  assert.equal(smoother.observe(position('tag-b', 200)).pos.x, 200);
});

test('잘못된 설정과 좌표를 거부한다', () => {
  assert.throws(() => createPositionSmoother(0), /positive integer/);
  assert.throws(() => createPositionSmoother(1.5), /positive integer/);
  assert.throws(() => createPositionSmoother({ staticDeadbandM: -1 }), /staticDeadbandM/);
  assert.throws(() => createPositionSmoother({ maxConsecutiveRejects: 0 }), /maxConsecutiveRejects/);

  const smoother = createPositionSmoother();
  assert.throws(() => smoother.observe(position('', 1)), /tagId/);
  assert.throws(() => smoother.observe(position('tag-a', Number.NaN)), /pos.x/);
});

// ── 클램프 프레임 제외 ──

test('클램프된 좌표는 평균에 넣지 않고 직전 좌표를 유지한다', () => {
  const smoother = createPositionSmoother({ windowSize: 4 });
  smoother.observe(position('tag-a', 5, 5));

  const clamped = { ...position('tag-a', 5, 0), geom: { clamped: true, error: 0.3 } };
  const held = smoother.observe(clamped);

  assert.deepEqual(held.pos, { x: 5, y: 5, z: 0 });
  assert.deepEqual(held.hold, { reason: 'clamped' });
  // ts·가속도 같은 나머지 필드는 현재 프레임 것을 그대로 쓴다(낙상 감지가 프레임을 잃으면 안 된다)
  assert.equal(held.ts, clamped.ts);
});

test('클램프가 첫 프레임이면 그 좌표라도 내보낸다', () => {
  const smoother = createPositionSmoother();
  const first = { ...position('tag-a', 2, 0), geom: { clamped: true, error: 0.1 } };

  assert.deepEqual(smoother.observe(first).pos, { x: 2, y: 0, z: 0 });
});

// ── 이상치 컷 ──

test('물리적으로 불가능한 점프는 버리고 직전 좌표를 유지한다', () => {
  const smoother = createPositionSmoother({ windowSize: 4 });
  smoother.observe(position('tag-a', 0, 0));
  smoother.observe(position('tag-a', 0.1, 0));

  const spike = smoother.observe(position('tag-a', 9, 0));

  assert.deepEqual(spike.hold, { reason: 'outlier' });
  assert.ok(spike.pos.x < 1, `튄 좌표가 화면에 나갔다: ${spike.pos.x}`);
});

test('한 번 튄 값은 이후 프레임의 평균도 흔들지 않는다', () => {
  const smoother = createPositionSmoother({ windowSize: 4 });
  for (const x of [0, 0.05, 0.02]) smoother.observe(position('tag-a', x, 0));
  smoother.observe(position('tag-a', 9, 0));                  // 튄 값 — 창에 안 들어감
  const after = smoother.observe(position('tag-a', 0.04, 0)); // 정상 복귀

  assert.ok(after.pos.x < 0.3, `튄 값이 평균에 남았다: ${after.pos.x}`);
});

test('연속 거부가 한계를 넘으면 진짜 이동으로 보고 따라간다', () => {
  const rejects = SMOOTHER_DEFAULTS.maxConsecutiveRejects;
  const smoother = createPositionSmoother({ windowSize: 4, maxConsecutiveRejects: rejects });
  smoother.observe(position('tag-a', 0, 0));

  let last = smoother.observe(position('tag-a', 0, 0));
  for (let i = 0; i < rejects; i += 1) last = smoother.observe(position('tag-a', 9, 0));

  assert.equal(last.hold, undefined);
  assert.equal(last.pos.x, 9);
});

test('데드밴드로 화면이 멈춰 있어도 천천히 걸어가는 것은 이상치가 아니다', () => {
  const smoother = createPositionSmoother({ windowSize: 3 });
  smoother.observe(position('tag-a', 0, 0));

  // 프레임당 0.1m씩(=1m/s) 30프레임. 기준점이 화면 좌표라면 중간에 이상치로 잘린다.
  let last = smoother.observe(position('tag-a', 0, 0));
  for (let i = 1; i <= 30; i += 1) last = smoother.observe(position('tag-a', i * 0.1, 0));

  assert.equal(last.hold, undefined);
  assert.ok(last.pos.x > 2.5, `걸어간 만큼 못 따라왔다: ${last.pos.x}`);
});

test('이동 중에는 반경을 걸지 않아 걸음이 끊기지 않는다', () => {
  const smoother = createPositionSmoother({ windowSize: 1, stopFrames: 3 });
  smoother.observe(position('tag-a', 0, 0));
  smoother.observe(position('tag-a', 1, 0));       // 정지 반경 이탈 → 이동 시작

  // 프레임당 0.1m(정지 판정 반경 0.15m보다 작다). 이동 중에 반경을 걸면 여기서 마커가 계단처럼 끊긴다.
  for (let i = 1; i <= 2; i += 1) {
    const out = smoother.observe(position('tag-a', 1 + i * 0.1, 0));
    assert.equal(out.hold, undefined, `이동 중 ${i}번째 프레임이 붙잡혔다`);
    assert.equal(round(out.pos.x), round(1 + i * 0.1));
  }
});

// ── 데드밴드 ──

test('반경 안에서 흔들리는 동안에는 좌표를 한 점으로 고정한다', () => {
  const smoother = createPositionSmoother({ windowSize: 3, staticDeadbandM: 0.4 });
  const anchor = smoother.observe(position('tag-a', 10, 10)).pos;

  const jitter = [0.12, -0.15, 0.09, -0.11, 0.14, -0.08];
  for (const d of jitter) {
    const out = smoother.observe(position('tag-a', 10 + d, 10 - d));
    assert.deepEqual(out.pos, anchor, '떨림이 화면 좌표를 움직였다');
    assert.deepEqual(out.hold, { reason: 'deadband' });
  }
});

test('반경을 벗어나면 따라가고, 다시 제자리에 머물면 고정으로 돌아간다', () => {
  const smoother = createPositionSmoother({
    windowSize: 1, staticDeadbandM: 0.4, movingDeadbandM: 0.15, stopFrames: 3,
  });
  smoother.observe(position('tag-a', 0, 0));

  assert.deepEqual(smoother.observe(position('tag-a', 0.3, 0)).hold, { reason: 'deadband' });
  assert.equal(smoother.observe(position('tag-a', 0.5, 0)).pos.x, 0.5);   // 정지 반경 이탈 → 이동

  // 도착 후 제자리 떨림. stopFrames만큼 이어져야 다시 고정에 들어간다.
  smoother.observe(position('tag-a', 0.52, 0));
  smoother.observe(position('tag-a', 0.49, 0));
  const settled = smoother.observe(position('tag-a', 0.51, 0));
  assert.deepEqual(settled.hold, { reason: 'deadband' });

  // 고정된 뒤에는 다시 넓은 정지 반경이 걸린다 — 0.3m 흔들려도 마커는 그대로다.
  const anchor = settled.pos.x;
  assert.deepEqual(smoother.observe(position('tag-a', anchor + 0.3, 0)).pos.x, anchor);
});

// ── 환경변수 ──

test('환경변수로 반경을 조절하고, 값이 없거나 이상하면 기본값을 쓴다', () => {
  assert.deepEqual(smootherOptionsFromEnv({}), {
    windowSize: SMOOTHER_DEFAULTS.windowSize,
    staticDeadbandM: SMOOTHER_DEFAULTS.staticDeadbandM,
    movingDeadbandM: SMOOTHER_DEFAULTS.movingDeadbandM,
    jumpBaseM: SMOOTHER_DEFAULTS.jumpBaseM,
    jumpSpeedMps: SMOOTHER_DEFAULTS.jumpSpeedMps,
  });

  const tuned = smootherOptionsFromEnv({ POS_DEADBAND_M: '0.8', POS_MAX_JUMP_M: 'abc' });
  assert.equal(tuned.staticDeadbandM, 0.8);
  assert.equal(tuned.jumpBaseM, SMOOTHER_DEFAULTS.jumpBaseM);
});
