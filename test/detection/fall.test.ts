import test from 'node:test';
import * as assert from 'node:assert';
import { createFallDetector } from '../../server/detection/fall.ts';

const G = 9.80665;
// 축약: |a|=g배 크기의 z축 가속도 프레임 생성
const frame = (ts: number, gMag: number, tagId = 'tag-watch') => ({ tagId, ts, accel: { x: 0, y: 0, z: gMag * G }, source: 'ni' });

// 감지기에 프레임 배열을 순차 투입하고 방출된 모든 이벤트를 모은다.
function run(
  det: { observe: (payload: { tagId: string; [key: string]: unknown }, position: { pos?: { x: number; y: number; z?: number } } | null) => Array<{ type: string; [key: string]: unknown }> },
  frames: ReturnType<typeof frame>[],
  position: { pos?: { x: number; y: number; z?: number } } | null = null,
) {
  const out: Array<{ type: string; [key: string]: unknown }> = [];
  for (const f of frames) out.push(...det.observe(f, position));
  return out;
}

// dt=100ms 간격으로 gMag 값들을 프레임 시퀀스로.
function seq(startTs: number, dt: number, gs: number[]) {
  return gs.map((g, i) => frame(startTs + i * dt, g));
}

// dt=100ms 프레임 기준, 판정 지연 1.5초 = 정점 뒤 15프레임.
const QUIET = (n: number) => Array(n).fill(1);

test('자유낙하 -> 충격이면 정점 1.5초 뒤에 fall_detected가 나온다', () => {
  const det = createFallDetector();
  const frames = [
    ...seq(0, 100, [1, 1, 0.1, 0.1]),   // t=200,300: freefall
    frame(400, 4.0),                     // 충격(정점)
    ...seq(500, 100, QUIET(30)),         // 500~3400ms
  ];
  const events = run(det, frames);
  assert.deepStrictEqual(events.map((e) => e.type), ['fall_detected']);
  assert.strictEqual(events[0].confidence, 'detected');
  assert.strictEqual(events[0].freefall, true, '직전 자유낙하 감지');
  assert.strictEqual(events[0].peakAccel, 4.0);
  // 이벤트 ts는 판정 시각이 아니라 충격 시각이다 — 관제사에게 의미 있는 건 넘어진 때다.
  assert.strictEqual(events[0].ts, 400);
});

test('정점 뒤 1.5초가 안 지나면 아직 안 쏜다', () => {
  const det = createFallDetector();
  // 충격 후 1.4초까지만 흘린다
  const events = run(det, [frame(0, 4.0), ...seq(100, 100, QUIET(14))]);
  assert.strictEqual(events.length, 0);
});

test('판정 지연은 마지막 정점 갱신 기준이다 — 늦게 온 더 큰 충격이 기준을 다시 잡는다', () => {
  const det = createFallDetector();
  // 3g 충격 -> 0.5초 뒤 6g(진짜 정점) -> 그 뒤로 조용
  const frames = [frame(0, 3.0), ...seq(100, 100, QUIET(4)),
    frame(500, 6.0), ...seq(600, 100, QUIET(30))];
  const events = run(det, frames);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].peakAccel, 6.0, 'peak은 관찰 구간 최대여야 한다');
  assert.ok((events[0].ts as number) === 0, 'ts는 첫 충격 시각');
  // 500(정점) + 1500 = 2000ms 이후에 나와야 한다. 즉 3.0 기준(1500)보다 늦다.
});

test('판정 지연은 설정으로 바꾼다', () => {
  const det = createFallDetector({ decisionDelayMs: 300 });
  const events = run(det, [frame(0, 4.0), ...seq(100, 100, QUIET(5))]);
  assert.strictEqual(events.length, 1);
});

test('정점이 계속 갱신돼도 상한(지연 2배)에서 판정한다', () => {
  const det = createFallDetector({ decisionDelayMs: 300 });
  // 매 프레임 조금씩 더 큰 충격 -> peakTs가 계속 밀리지만 600ms 상한에서 나가야 한다
  const rising = Array.from({ length: 20 }, (_, i) => 3.0 + i * 0.1);
  const events = run(det, [frame(0, 2.9), ...seq(100, 100, rising)]);
  assert.strictEqual(events.length, 1);
  assert.ok((events[0].ts as number) === 0);
});

test('자유낙하 없는 충격도 감지되고 freefall=false', () => {
  const det = createFallDetector();
  const events = run(det, [frame(0, 1), frame(100, 3.0), ...seq(200, 100, QUIET(30))]);
  assert.deepStrictEqual(events.map((e) => e.type), ['fall_detected']);
  assert.strictEqual(events[0].freefall, false);
});

test('충격 뒤 움직여도 아무 일 없다 — 자동 해제는 없다', () => {
  const det = createFallDetector();
  // 옛 규칙이면 여기서 fall_canceled가 나와 경보가 사라졌다.
  const frames = [frame(0, 3.0), ...seq(100, 100, [1, 1, 1, 1]),
    frame(500, 2.0), ...seq(600, 100, QUIET(30))];
  assert.deepStrictEqual(run(det, frames).map((e) => e.type), ['fall_detected']);
});

test('충격 파형이 임계를 여러 번 넘어도 한 건만 나간다', () => {
  const det = createFallDetector();
  // 실제 낙상 파형은 2.5g를 연속 표본으로 넘는다. 이게 전부 하나의 충격이어야 한다.
  const events = run(det, [...seq(0, 20, [4.0, 5.2, 6.1, 3.3, 2.9, 2.6]),
    ...seq(120, 20, QUIET(120))]);
  assert.strictEqual(events.length, 1);
  assert.strictEqual(events[0].peakAccel, 6.1, '정점은 6.1g');
  assert.strictEqual(events[0].ts, 0, '충격 시작 시각으로 낸다');
});

test('쿨다운이 지나면 다음 충격을 다시 감지한다', () => {
  const det = createFallDetector({ decisionDelayMs: 200, cooldownMs: 1000 });
  const events = run(det, [
    frame(0, 4.0), ...seq(100, 100, QUIET(3)),   // 200ms 지연 -> t=200에 발화
    frame(400, 4.0),                              // 쿨다운(1s) 안 — 무시
    ...seq(500, 100, QUIET(8)),                   // t=1200에 쿨다운 만료 -> IDLE
    frame(1400, 4.5), ...seq(1500, 100, QUIET(3)),
  ]);
  assert.strictEqual(events.length, 2);
  assert.deepStrictEqual(events.map((e) => e.ts), [0, 1400]);
});

test('reset은 쿨다운까지 풀어 다음 충격을 바로 받는다 — AI 기각 경로다', () => {
  const det = createFallDetector({ decisionDelayMs: 200 });
  assert.strictEqual(run(det, [frame(0, 4.0), ...seq(100, 100, QUIET(3))]).length, 1);
  det.reset('tag-watch');
  assert.strictEqual(
    run(det, [frame(400, 4.0), ...seq(500, 100, QUIET(3))]).length, 1,
    '기각된 충격은 쿨다운을 안 먹는다',
  );
});

test('임계 미만 충격은 감지하지 않는다', () => {
  const det = createFallDetector();
  assert.strictEqual(run(det, seq(0, 100, [1, 2.4, 2.49, 1, 1, 1, 1, 1, 1, 1])).length, 0);
});

test('과거 ts 프레임은 무시된다(단조 ts 가드)', () => {
  const det = createFallDetector();
  const out = run(det, [
    frame(0, 1),
    frame(5000, 1),   // lastTs를 5000으로 전진(아직 IDLE)
    frame(1000, 4.0), // 과거 ts(1000<5000) 충격: 무시되어 이벤트 안 나옴
    ...seq(5100, 100, QUIET(30)),
  ]);
  assert.strictEqual(out.length, 0, '과거 ts 충격은 무시');
  const out2 = run(det, [frame(9000, 4.0), ...seq(9100, 100, QUIET(30))]);
  assert.strictEqual(out2.filter((e) => e.type === 'fall_detected').length, 1);
});

test('태그마다 상태가 독립이다', () => {
  const det = createFallDetector({ decisionDelayMs: 200 });
  const feed = (tag: string) => run(det, [frame(0, 4.0, tag), ...[100, 200, 300]
    .map((t) => frame(t, 1, tag))]);
  assert.strictEqual(feed('tag-a').length, 1);
  assert.strictEqual(feed('tag-b').length, 1, '한 태그의 쿨다운이 다른 태그를 막으면 안 된다');
});

test('pos: position 있으면 마지막 좌표를 붙이고, 없으면 null', () => {
  const det = createFallDetector({ decisionDelayMs: 200 });
  const frames = [frame(0, 3.0), ...seq(100, 100, QUIET(3))];
  const withPos = run(det, frames, { pos: { x: 3, y: 4, z: 0 } });
  assert.deepStrictEqual(withPos[0].pos, { x: 3, y: 4, z: 0 });

  const det2 = createFallDetector({ decisionDelayMs: 200 });
  const noPos = run(det2, frames, null);
  assert.strictEqual(noPos[0].pos, null);
});

test('허용폭 안에서 늦게 도착한 정점 프레임도 peakAccel에 반영된다', () => {
  // 전송이 겹치면 도착 순서가 뒤집힌다(실측: 5개 중 1개가 약 100ms 늦음).
  // 예전에는 늦은 프레임을 통째로 버려서, 하필 그게 정점이면 peakAccel이 낮게 남았다.
  const det = createFallDetector();
  const out = run(det, [
    frame(0, 1),
    frame(100, 3.0),   // 충격 — 여기서 PENDING 진입
    frame(200, 1),
    frame(150, 4.5),   // 100ms 늦게 도착한 진짜 정점
    ...seq(300, 100, QUIET(30)),
  ]);
  const detected = out.filter((e) => e.type === 'fall_detected');
  assert.strictEqual(detected.length, 1);
  assert.strictEqual(detected[0].peakAccel, 4.5, '늦게 온 정점이 peakAccel에 잡혀야 한다');
});

test('늦게 온 프레임이 판정 시계를 되감지 않는다', () => {
  // 늦은 프레임의 ts를 그대로 쓰면 경과가 줄어 판정이 밀린다. 시계는 최신 시각을 유지해야 한다.
  const det = createFallDetector({ decisionDelayMs: 300 });
  const out = run(det, [
    frame(0, 4.0),     // 정점 t=0
    frame(100, 1),
    frame(50, 1),      // 늦은 프레임 — 시계를 100에서 50으로 되돌리면 안 된다
    frame(300, 1),     // 정점 뒤 300ms → 여기서 판정되어야 한다
  ]);
  assert.strictEqual(out.filter((e) => e.type === 'fall_detected').length, 1);
});

test('허용폭을 넘게 늦은 프레임은 여전히 버린다', () => {
  // 재정렬이 아니라 낡은/중복 프레임이다. 몇 초 전 충격을 지금 것으로 세면 경보가 헛나간다.
  const det = createFallDetector({ reorderToleranceMs: 200 });
  const out = run(det, [
    frame(0, 1),
    frame(5000, 1),
    frame(4000, 4.0),  // 1초 과거 — 허용폭 200ms를 한참 넘는다
    ...seq(5100, 100, QUIET(30)),
  ]);
  assert.strictEqual(out.length, 0);
});
