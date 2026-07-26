// 클립 주입기 — 프레임을 만들어 파이프라인에 넘기는 부분만 본다.
// 타이머는 가짜로 갈아 끼워 실제 10초를 기다리지 않는다.

import * as assert from 'node:assert/strict';
import test from 'node:test';

import {
  createInjector, ClipNotFoundError, TagNotFoundError, type InjectFrame,
} from '../../server/inject/injector.ts';
import type { Clip } from '../../server/inject/clip.ts';

const GRAVITY = 9.80665;

function makeClip(id: string, n: number): Clip {
  return {
    id,
    label: `${id} 라벨`,
    summary: '테스트 클립',
    hz: 50,
    source: {
      dataset: 'Test', subject: 'Test:S1', activity: 'F01', activityLabel: 'test fall',
      trial: 'R01', placement: 'waist', isFall: true, srcHz: 200, rowRange: [0, n],
    },
    expect: { events: [], classicalEvents: [], aiScore: null },
    samples: {
      ax: Array.from({ length: n }, (_, i) => i / 100),
      ay: Array.from({ length: n }, (_, i) => -i / 100),
      az: Array.from({ length: n }, () => 1),
    },
  };
}

/** 예약된 콜백을 손으로 돌리는 가짜 타이머. now()도 같이 흐른다. */
function fakeClock() {
  let now = 1_000_000;
  let seq = 0;
  const pending = new Map<number, { at: number; run: () => void }>();
  return {
    now: () => now,
    schedule: (run: () => void, delay: number) => {
      const id = ++seq;
      pending.set(id, { at: now + delay, run });
      return id;
    },
    cancelSchedule: (timer: unknown) => { pending.delete(timer as number); },
    /** 예약된 것을 시각 순으로 끝까지 돌린다 */
    drain(limit = 10000): number {
      let ran = 0;
      while (pending.size > 0 && ran < limit) {
        const [id, task] = [...pending.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        pending.delete(id);
        now = Math.max(now, task.at);
        task.run();
        ran += 1;
      }
      return ran;
    },
    size: () => pending.size,
  };
}

interface Harness {
  frames: InjectFrame[];
  starts: string[];
  /** [tagId, clipId, 끝까지 갔는가] */
  ends: [string, string, boolean][];
  clock: ReturnType<typeof fakeClock>;
  injector: ReturnType<typeof createInjector>;
}

function harness(clips: Clip[], knownTags = ['tag-1', 'tag-2']): Harness {
  const frames: InjectFrame[] = [];
  const starts: string[] = [];
  const ends: [string, string, boolean][] = [];
  const clock = fakeClock();
  const injector = createInjector({
    clips,
    gravity: GRAVITY,
    rangesFor: (tagId) => (knownTags.includes(tagId)
      ? [{ anchorId: 'A', distance: 3 }, { anchorId: 'B', distance: 4 }]
      : null),
    onFrame: (frame) => frames.push(frame),
    onStart: (tagId) => starts.push(tagId),
    onEnd: (tagId, clip, completed) => ends.push([tagId, clip.id, completed]),
    now: clock.now,
    schedule: clock.schedule,
    cancelSchedule: clock.cancelSchedule,
  });
  return { frames, starts, ends, clock, injector };
}

test('클립 샘플 수만큼 ingest 프레임이 나간다', () => {
  const h = harness([makeClip('c1', 5)]);
  const handle = h.injector.start('tag-1', 'c1');
  h.clock.drain();

  assert.equal(handle.frames, 5);
  assert.equal(handle.durationMs, 100); // 5샘플 / 50Hz
  assert.equal(h.frames.length, 5);
});

test('g 단위 샘플이 m/s^2로 환산돼 나간다', () => {
  const clip = makeClip('c1', 3);
  const h = harness([clip]);
  h.injector.start('tag-1', 'c1');
  h.clock.drain();

  for (let i = 0; i < 3; i += 1) {
    assert.ok(Math.abs(h.frames[i].accel.x - clip.samples.ax[i] * GRAVITY) < 1e-9);
    assert.ok(Math.abs(h.frames[i].accel.z - GRAVITY) < 1e-9); // az = 1g
  }
});

test('ts는 클립 표본 간격으로 만든다 — 타이머 지터를 섞지 않는다', () => {
  const h = harness([makeClip('c1', 4)]);
  h.injector.start('tag-1', 'c1');
  h.clock.drain();

  const ts = h.frames.map((f) => f.ts);
  for (let i = 1; i < ts.length; i += 1) {
    assert.equal(ts[i] - ts[i - 1], 20, '50Hz면 간격은 정확히 20ms여야 한다');
  }
});

test('프레임에 UWB 거리가 실린다 — 측위까지 태우기 위한 조건이다', () => {
  const h = harness([makeClip('c1', 2)]);
  h.injector.start('tag-1', 'c1');
  h.clock.drain();

  assert.deepEqual(h.frames[0].ranges, [
    { anchorId: 'A', distance: 3 },
    { anchorId: 'B', distance: 4 },
  ]);
  assert.equal(h.frames[0].source, 'sim');
  assert.equal(h.frames[0].tagId, 'tag-1');
});

test('같은 태그에 다시 주입하면 앞 재생을 버린다', () => {
  const h = harness([makeClip('c1', 100), makeClip('c2', 4)]);
  h.injector.start('tag-1', 'c1');
  h.frames.length = 0;

  h.injector.start('tag-1', 'c2');
  h.clock.drain();

  // c2 프레임만 남아야 한다. 두 클립이 섞이면 감지기가 보는 파형이 실재하지 않는 신호가 된다.
  assert.equal(h.frames.length, 4);
  assert.deepEqual(h.ends, [
    ['tag-1', 'c1', false], // 앞 클립은 미완으로 버려지고
    ['tag-1', 'c2', true],  // 나중 클립만 끝까지 간다
  ]);
});

test('다른 태그끼리는 서로 간섭하지 않는다', () => {
  const h = harness([makeClip('c1', 3)]);
  h.injector.start('tag-1', 'c1');
  h.injector.start('tag-2', 'c1');
  h.clock.drain();

  assert.equal(h.frames.filter((f) => f.tagId === 'tag-1').length, 3);
  assert.equal(h.frames.filter((f) => f.tagId === 'tag-2').length, 3);
});

test('재생 시작과 끝을 알린다 — 시뮬 정지·재개를 서버가 여기에 건다', () => {
  const h = harness([makeClip('c1', 3)]);
  h.injector.start('tag-1', 'c1');
  assert.deepEqual(h.starts, ['tag-1']);
  assert.deepEqual(h.ends, []);

  h.clock.drain();
  assert.deepEqual(h.ends, [['tag-1', 'c1', true]]);
  assert.equal(h.injector.isPlaying('tag-1'), false);
});

test('중간에 멈추면 남은 프레임은 안 나간다', () => {
  const h = harness([makeClip('c1', 50)]);
  h.injector.start('tag-1', 'c1');
  h.injector.stop('tag-1');
  h.clock.drain();

  assert.equal(h.frames.length, 1); // 첫 프레임은 즉시 나간 뒤였다
  assert.deepEqual(h.ends, [['tag-1', 'c1', false]]);
});

test('모르는 클립은 있는 목록과 함께 거절한다', () => {
  const h = harness([makeClip('c1', 3)]);
  assert.throws(() => h.injector.start('tag-1', 'nope'), ClipNotFoundError);
  assert.throws(() => h.injector.start('tag-1', 'nope'), /c1/);
  assert.equal(h.frames.length, 0);
});

test('모르는 태그는 거절한다 — 좌표가 없으면 UWB 거리를 만들 수 없다', () => {
  const h = harness([makeClip('c1', 3)]);
  assert.throws(() => h.injector.start('없는태그', 'c1'), TagNotFoundError);
  assert.equal(h.starts.length, 0);
});

test('stopAll은 재생 중인 태그를 전부 거둔다', () => {
  const h = harness([makeClip('c1', 50)]);
  h.injector.start('tag-1', 'c1');
  h.injector.start('tag-2', 'c1');
  h.injector.stopAll();

  assert.equal(h.injector.isPlaying('tag-1'), false);
  assert.equal(h.injector.isPlaying('tag-2'), false);
  assert.equal(h.clock.size(), 0, '예약이 남으면 프로세스가 안 끝난다');
});
