// 주입 클립 = 공개 낙상 데이터셋에서 잘라낸 실제 가속도 구간.
//
// 주입 버튼이 쓰는 신호는 지어낸 값이 아니라 이 클립이다. 클립은 clips/에 커밋되어 있고
// tools/clip.ts로 마스터 CSV에서 다시 만들 수 있다(마스터 CSV는 3.7GB라 git 제외).
//
// 값은 g 단위다(정지 ≈ 1g). 데이터셋이 g로 정규화돼 있고 특징 추출(detection/features.ts)도
// g로 계산하기 때문이다. ingest 스키마는 m/s^2이므로 재생할 때 중력상수를 곱한다.

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ClipSamples {
  ax: number[];
  ay: number[];
  az: number[];
}

export interface ClipSource {
  dataset: string;
  subject: string;
  activity: string;
  activityLabel: string;
  trial: string;
  placement: string;
  isFall: boolean;
  srcHz: number;
  /** 원본 trial에서 잘라낸 행 범위 [from, to) */
  rowRange: [number, number];
}

export interface ClipExpectation {
  /** 캐스케이드(고전+AI)가 내야 하는 이벤트 순서 */
  events: string[];
  /** AI를 끈 고전 단독이 내는 이벤트 순서. 둘이 다른 클립이 캐스케이드의 존재 이유다 */
  classicalEvents: string[];
  /** 후보 시점의 AI 점수. 기각된 클립은 후보 자체가 안 나가므로 null */
  aiScore: number | null;
}

export interface Clip {
  id: string;
  label: string;
  summary: string;
  hz: number;
  source: ClipSource;
  expect: ClipExpectation;
  samples: ClipSamples;
}

/** 클립 목록에 실릴 메타. 원신호(수백 KB)는 빼고 보낸다. */
export interface ClipSummary {
  id: string;
  label: string;
  summary: string;
  durationMs: number;
  source: ClipSource;
  expect: ClipExpectation;
}

export function clipDurationMs(clip: Clip): number {
  return Math.round((clip.samples.ax.length / clip.hz) * 1000);
}

export function clipSummary(clip: Clip): ClipSummary {
  return {
    id: clip.id,
    label: clip.label,
    summary: clip.summary,
    durationMs: clipDurationMs(clip),
    source: clip.source,
    expect: clip.expect,
  };
}

/**
 * 클립 JSON을 검증한다. 손상된 클립을 그냥 재생하면 주입 버튼이 조용히 이상한 신호를
 * 흘리게 되고, 그건 감지기 버그로 오인되기 딱 좋다. 로드 시점에 던진다.
 */
export function parseClip(value: unknown, origin: string): Clip {
  const clip = value as Clip;
  const fail = (reason: string): never => {
    throw new Error(`잘못된 클립 ${origin}: ${reason}`);
  };

  if (!clip || typeof clip !== 'object') fail('객체가 아닙니다');
  for (const key of ['id', 'label', 'summary'] as const) {
    if (typeof clip[key] !== 'string' || !clip[key].trim()) fail(`${key} 값이 비어 있습니다`);
  }
  if (!Number.isFinite(clip.hz) || clip.hz <= 0) fail('hz가 양수가 아닙니다');

  const s = clip.samples;
  if (!s || !Array.isArray(s.ax) || !Array.isArray(s.ay) || !Array.isArray(s.az)) {
    fail('samples.ax/ay/az가 배열이 아닙니다');
  }
  if (s.ax.length !== s.ay.length || s.ax.length !== s.az.length) {
    fail(`축 길이가 다릅니다 (${s.ax.length}/${s.ay.length}/${s.az.length})`);
  }
  if (s.ax.length === 0) fail('샘플이 비어 있습니다');
  for (const axis of ['ax', 'ay', 'az'] as const) {
    for (const v of s[axis]) {
      if (!Number.isFinite(v)) fail(`${axis}에 유한하지 않은 값이 있습니다`);
    }
  }
  if (!clip.expect || !Array.isArray(clip.expect.events)) fail('expect.events가 없습니다');
  if (!clip.source || typeof clip.source.dataset !== 'string') fail('source.dataset이 없습니다');

  return clip;
}

/** clips/ 아래 *.json을 파일명 순으로 읽는다. 순서가 곧 대시보드 드롭다운 순서다. */
export function loadClips(dir: string): Clip[] {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  const clips = files.map((f) => parseClip(
    JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')),
    f,
  ));

  const seen = new Set<string>();
  for (const clip of clips) {
    if (seen.has(clip.id)) throw new Error(`클립 id가 중복입니다: ${clip.id}`);
    seen.add(clip.id);
  }
  if (clips.length === 0) throw new Error(`클립이 없습니다: ${dir}`);
  return clips;
}
