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

test('정상 낙상: 자유낙하->충격->5초 정지 => candidate 그리고 confirmed', () => {
  const det = createFallDetector();
  // 정지 1g 몇 프레임 -> 자유낙하 0.1g -> 충격 4g -> 이후 5.2초간 1g 정지(정착 0.4s 포함)
  const frames = [
    ...seq(0, 100, [1, 1, 0.1, 0.1]),   // t=200,300: freefall
    frame(400, 4.0),                     // 충격
    ...seq(500, 100, Array(54).fill(1)), // 500~5800ms 정지(>=5000ms 창)
  ];
  const events = run(det, frames);
  const types = events.map((e) => e.type);
  assert.ok(types.includes('fall_candidate'), '후보 발행');
  assert.ok(types.includes('fall_confirmed'), '확진 발행');
  assert.strictEqual(types.filter((t) => t === 'fall_canceled').length, 0, '취소 없음');
  const cand = events.find((e) => e.type === 'fall_candidate')!;
  assert.strictEqual(cand.confidence, 'candidate');
  assert.strictEqual(cand.freefall, true, '직전 자유낙하 감지');
  assert.ok((cand.peakAccel as number) >= 4.0);
});

test('자유낙하 없는 충격도 후보->확진, freefall=false', () => {
  const det = createFallDetector();
  const frames = [frame(0, 1), frame(100, 3.0), ...seq(200, 100, Array(54).fill(1))];
  const events = run(det, frames);
  const cand = events.find((e) => e.type === 'fall_candidate')!;
  assert.strictEqual(cand.freefall, false);
  assert.ok(events.some((e) => e.type === 'fall_confirmed'));
});

test('정착 이후 움직임 재개 => canceled, 확진 없음', () => {
  const det = createFallDetector();
  // 충격 -> 정착(0.4s) 지나고 500ms 시점 큰 움직임(2g)
  const frames = [frame(0, 3.0), ...seq(100, 100, [1, 1, 1, 1]), frame(500, 2.0)];
  const events = run(det, frames);
  assert.ok(events.some((e) => e.type === 'fall_canceled'));
  assert.ok(!events.some((e) => e.type === 'fall_confirmed'));
});

test('정착 구간 내 튐은 취소하지 않는다(바운스 무시)', () => {
  const det = createFallDetector();
  // 충격 -> 정착창(0.4s) 안 200ms에 6g 바운스 -> 이후 5.2초 정지
  const frames = [frame(0, 3.0), frame(200, 6.0), ...seq(300, 100, Array(54).fill(1))];
  const events = run(det, frames);
  assert.ok(!events.some((e) => e.type === 'fall_canceled'), '바운스로 취소 안 됨');
  assert.ok(events.some((e) => e.type === 'fall_confirmed'));
  const conf = events.find((e) => e.type === 'fall_confirmed')!;
  assert.ok((conf.peakAccel as number) >= 6.0, 'peak은 관찰 구간 최대');
});

test('무동작 창 미달 시 아직 확진 없음', () => {
  const det = createFallDetector();
  const frames = [frame(0, 3.0), ...seq(100, 100, Array(30).fill(1))]; // 100~3000ms(<5000)
  const events = run(det, frames);
  assert.ok(events.some((e) => e.type === 'fall_candidate'));
  assert.ok(!events.some((e) => e.type === 'fall_confirmed'));
});

test('cooldown 재무장: 확진 후 움직였다가 다시 충격 => 새 후보', () => {
  const det = createFallDetector();
  const first = [frame(0, 3.0), ...seq(100, 100, Array(54).fill(1))]; // 확진까지
  const move = [frame(5500, 2.0)];                                    // 움직임 -> IDLE 재무장
  const second = [frame(5700, 3.5)];                                  // 새 충격
  const events = run(det, [...first, ...move, ...second]);
  assert.strictEqual(events.filter((e) => e.type === 'fall_candidate').length, 2);
});

test('정착 이후 밴드~움직임 사이 흔들림은 무동작 시계를 리셋해 확진을 지연한다', () => {
  const det = createFallDetector();
  // 충격 -> 정지 3초 -> 갭(0.3g 움직임, 취소 아님) 한 프레임 -> 다시 정지. 갭 이후 5초 지나야 확진.
  const frames = [
    frame(0, 3.0),
    ...seq(100, 100, Array(30).fill(1)), // 100~3000ms 정지 (아직 확진 전, <5000)
    frame(3100, 1.3),                    // 갭: motion 0.3 (밴드 0.25 초과, 움직임 0.4 미만) -> 시계 리셋
    ...seq(3200, 100, Array(60).fill(1)),// 3200~9100ms 정지: 리셋 시점(3100)+5000=8100에 확진
  ];
  const events = run(det, frames);
  assert.ok(!events.some((e) => e.type === 'fall_canceled'), '갭은 취소가 아니다');
  const conf = events.find((e) => e.type === 'fall_confirmed');
  assert.ok(conf, '확진은 발생한다');
  assert.ok((conf!.ts as number) >= 8100, `확진이 갭 이후로 지연됨(ts=${conf!.ts})`);
});

test('과거 ts 프레임은 무시된다(단조 ts 가드)', () => {
  const det = createFallDetector();
  const out = run(det, [
    frame(0, 1),
    frame(5000, 1),   // lastTs를 5000으로 전진(아직 IDLE)
    frame(1000, 4.0), // 과거 ts(1000<5000) 충격: 무시되어 candidate 안 나옴
  ]);
  assert.strictEqual(out.length, 0, '과거 ts 충격은 무시');
  const out2 = run(det, [frame(6000, 4.0)]); // 미래 ts 충격은 정상
  assert.strictEqual(out2.filter((e) => e.type === 'fall_candidate').length, 1);
});

test('pos: position 있으면 마지막 좌표를 붙이고, 없으면 null', () => {
  const det = createFallDetector();
  const pos = { pos: { x: 3, y: 4, z: 0 } };
  const withPos = run(det, [frame(0, 3.0)], pos);
  assert.deepStrictEqual(withPos[0].pos, { x: 3, y: 4, z: 0 });

  const det2 = createFallDetector();
  const noPos = run(det2, [frame(0, 3.0)], null);
  assert.strictEqual(noPos[0].pos, null);
});
