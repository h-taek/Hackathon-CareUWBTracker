// 커밋된 클립이 라벨대로 동작하는지 확인한다.
//
// 이 테스트가 이 리포에서 하는 일이 하나 있다: 데모 화면의 문구와 실제 감지 결과를 묶어 둔다.
// "낙상 감지 클립"이라고 적어 놓고 감지기가 이벤트를 안 내면 데모가 거짓말을 하는 것이고,
// 그건 임계값 한 줄, 모델 파일 한 번 교체로 조용히 일어난다. 여기서 잡는다.

import * as assert from 'node:assert/strict';
import test from 'node:test';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadClips, clipDurationMs, type Clip } from '../../server/inject/clip.ts';
import { createCascadeDetector } from '../../server/detection/cascade.ts';
import { WINDOW } from '../../server/detection/features.ts';

const CLIP_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'server', 'inject', 'clips',
);
const GRAVITY = 9.80665;
const clips = loadClips(CLIP_DIR);

/** 클립을 실제 감지기에 50Hz로 흘려 이벤트 종류만 뽑는다. */
function run(clip: Clip, aiEnabled: boolean): { types: string[]; scores: (number | null)[] } {
  const detector = createCascadeDetector({ aiEnabled });
  const stepMs = 1000 / clip.hz;
  const types: string[] = [];
  const scores: (number | null)[] = [];

  for (let i = 0; i < clip.samples.ax.length; i += 1) {
    const events = detector.observe(
      {
        tagId: 'clip',
        ts: Math.round(i * stepMs),
        accel: {
          x: clip.samples.ax[i] * GRAVITY,
          y: clip.samples.ay[i] * GRAVITY,
          z: clip.samples.az[i] * GRAVITY,
        },
      },
      { pos: { x: 3, y: 2, z: 0 } },
    );
    for (const event of events) {
      types.push(event.type);
      scores.push(event.aiScore ?? null);
    }
  }
  return { types, scores };
}

test('클립이 하나 이상 실려 있다', () => {
  assert.ok(clips.length >= 1);
});

for (const clip of clips) {
  test(`${clip.id} — 캐스케이드 판정이 expect.events와 같다`, () => {
    assert.deepEqual(run(clip, true).types, clip.expect.events);
  });

  test(`${clip.id} — 고전 단독 판정이 expect.classicalEvents와 같다`, () => {
    assert.deepEqual(run(clip, false).types, clip.expect.classicalEvents);
  });

  test(`${clip.id} — AI 채점창(${WINDOW}샘플)이 채워진 뒤에 첫 판정이 난다`, () => {
    // 앞이 짧으면 링버퍼를 가장자리 복제로 메워 채점해(cascade.ts) 원본과 다른 답이 난다.
    // 클립을 다시 자를 때 이 조건을 깨기 쉬워서 못 박아 둔다.
    assert.ok(clip.samples.ax.length > WINDOW, `${clip.id}의 샘플이 채점창보다 짧다`);
  });

  test(`${clip.id} — 데모에 쓸 만한 길이다`, () => {
    const ms = clipDurationMs(clip);
    assert.ok(ms >= 3000 && ms <= 20000, `${clip.id} 길이 ${ms}ms`);
  });
}

test('낙상 클립은 감지 이벤트 하나를 낸다 — 승격도 해제도 없다', () => {
  const clip = clips.find((c) => c.id === 'fall-detected');
  assert.ok(clip, 'fall-detected 클립이 없다');
  assert.deepEqual(run(clip, true).types, ['fall_detected']);
  assert.equal(clip.source.isFall, true, '낙상 클립은 실제 낙상 trial이어야 한다');
});

test('헛경보 클립은 고전만 켜면 울리고 AI가 전부 막는다', () => {
  const clip = clips.find((c) => c.id === 'false-alarm');
  assert.ok(clip, 'false-alarm 클립이 없다');
  assert.equal(clip.source.isFall, false, '헛경보 클립은 낙상이 아닌 trial이어야 한다');
  // 캐스케이드를 넣은 이유가 이 한 줄이다. 둘이 같아지면 클립이 의미를 잃는다.
  assert.deepEqual(run(clip, true).types, []);
  assert.deepEqual(run(clip, false).types, ['fall_detected']);
});

test('클립 출처가 남아 있다 — 어느 데이터셋의 어느 trial인지 추적 가능해야 한다', () => {
  for (const clip of clips) {
    for (const key of ['dataset', 'subject', 'activity', 'trial', 'placement'] as const) {
      assert.ok(String(clip.source[key]).trim(), `${clip.id}.source.${key}가 비어 있다`);
    }
    assert.equal(clip.source.placement, 'waist', '착용 위치는 허리로 통일한다(research 02 §1)');
  }
});
