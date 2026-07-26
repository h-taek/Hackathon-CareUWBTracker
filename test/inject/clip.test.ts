// 클립 로드·검증. 손상된 클립을 조용히 재생하면 감지기 버그로 오인하기 딱 좋다.

import * as assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseClip, loadClips, clipDurationMs, clipSummary, type Clip,
} from '../../server/inject/clip.ts';

const CLIP_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'server', 'inject', 'clips',
);

function valid(): Clip {
  return {
    id: 'c1',
    label: '라벨',
    summary: '요약',
    hz: 50,
    source: {
      dataset: 'Test', subject: 'Test:S1', activity: 'F01', activityLabel: 'test',
      trial: 'R01', placement: 'waist', isFall: true, srcHz: 200, rowRange: [0, 3],
    },
    expect: { events: ['fall_candidate'], classicalEvents: ['fall_candidate'], aiScore: 0.9 },
    samples: { ax: [0, 1, 2], ay: [0, 1, 2], az: [1, 1, 1] },
  };
}

test('정상 클립은 그대로 통과한다', () => {
  assert.doesNotThrow(() => parseClip(valid(), 'c1.json'));
});

test('축 길이가 다르면 던진다', () => {
  const clip = valid();
  clip.samples.ay = [0, 1];
  assert.throws(() => parseClip(clip, 'c1.json'), /축 길이가 다릅니다/);
});

test('샘플이 비면 던진다', () => {
  const clip = valid();
  clip.samples = { ax: [], ay: [], az: [] };
  assert.throws(() => parseClip(clip, 'c1.json'), /샘플이 비어 있습니다/);
});

test('NaN이 섞이면 던진다 — 감지기까지 흘러가면 조용히 오작동한다', () => {
  const clip = valid();
  clip.samples.az[1] = NaN;
  assert.throws(() => parseClip(clip, 'c1.json'), /유한하지 않은 값/);
});

test('hz가 0 이하면 던진다', () => {
  const clip = valid();
  clip.hz = 0;
  assert.throws(() => parseClip(clip, 'c1.json'), /hz가 양수가 아닙니다/);
});

test('id·label이 비면 던진다', () => {
  const clip = valid();
  clip.label = '  ';
  assert.throws(() => parseClip(clip, 'c1.json'), /label 값이 비어 있습니다/);
});

test('오류 메시지에 파일명이 들어간다', () => {
  assert.throws(() => parseClip({}, '03-false-alarm.json'), /03-false-alarm\.json/);
});

test('길이는 샘플 수와 hz로 계산한다', () => {
  assert.equal(clipDurationMs(valid()), 60); // 3샘플 / 50Hz
});

test('목록용 요약에는 원신호를 싣지 않는다 — 수백 KB짜리 응답이 된다', () => {
  const summary = clipSummary(valid()) as unknown as Record<string, unknown>;
  assert.equal(summary.samples, undefined);
  assert.equal(summary.durationMs, 60);
  assert.equal(summary.id, 'c1');
  assert.ok(summary.source);
});

test('실제 clips/ 디렉터리가 로드된다', () => {
  const clips = loadClips(CLIP_DIR);
  assert.ok(clips.length >= 1);
  const ids = clips.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'id가 중복이면 드롭다운이 엉킨다');
});

test('id가 중복이면 던진다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clips-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify(valid()));
    fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify(valid()));
    assert.throws(() => loadClips(dir), /클립 id가 중복입니다: c1/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('클립이 하나도 없으면 던진다 — 주입 버튼이 조용히 죽는 것보다 낫다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clips-'));
  try {
    assert.throws(() => loadClips(dir), /클립이 없습니다/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('파일명 순서가 곧 드롭다운 순서다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clips-'));
  try {
    const second = { ...valid(), id: 'second' };
    fs.writeFileSync(path.join(dir, '02-b.json'), JSON.stringify(second));
    fs.writeFileSync(path.join(dir, '01-a.json'), JSON.stringify(valid()));
    assert.deepEqual(loadClips(dir).map((c) => c.id), ['c1', 'second']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
