// 반출 확인용 이벤트 심기 — **개발 전용이다.**
//
// 학습 반출은 사고 발생 24시간 뒤 파기와 함께 일어난다(spec system 03 §7.2). 하루를
// 기다리지 않고 그 자리를 보려면 **이미 만료된 이벤트**가 필요하다. 이 도구가 그걸 만든다.
//
//   node tools/export-demo.ts [DATA_DIR]
//
// 기본 자리는 `server/data/export-demo`다 — 진짜 사고 기록(`server/data/events`)과 떨어져
// 있어야 한다. 실제로 개발 기기의 명부·기록을 건드려 본 적이 있어 자리를 갈라 뒀다.
//
// 심는 것은 넷이다. 관제사 판정이 붙은 셋과 아무도 안 본 하나.

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createEventStore } from '../server/events/store.ts';
import type { EventRecord } from '../server/events/recorder.ts';

const REPO = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_DIR = path.join(REPO, 'server', 'data', 'export-demo');

/** 번복 창(기본 24시간)을 확실히 넘긴 나이. 심자마자 파기 대상이 된다. */
const AGE_MS = 25 * 3_600_000;

const SEEDS = [
  { eventId: 'demo-fall-1', outcome: 'confirmed', peakAccel: 4.2, aiScore: 0.93 },
  { eventId: 'demo-fall-2', outcome: 'confirmed', peakAccel: 3.1, aiScore: 0.44 }, // 모델이 틀린 건
  { eventId: 'demo-false-1', outcome: 'false_alarm', peakAccel: 2.8, aiScore: 0.71 },
  { eventId: 'demo-unjudged', outcome: 'detected', peakAccel: 3.5, aiScore: 0.66 }, // 아무도 안 봤다
] as const;

const dataDir = process.argv[2] || DEFAULT_DIR;
const store = createEventStore(path.join(dataDir, 'events'));
const ts = Date.now() - AGE_MS;

for (const seed of SEEDS) {
  store.save(build(seed, ts));
}

console.log(`반출 확인용 이벤트 ${SEEDS.length}건을 심었다 (${AGE_MS / 3_600_000}시간 전 사고).`);
for (const seed of SEEDS) {
  const label = seed.outcome === 'confirmed' ? '낙상 → label 1'
    : seed.outcome === 'false_alarm' ? '오경보 → label 0'
      : '미판정 → 반출 안 됨';
  console.log(`  ${seed.eventId.padEnd(16)} ${seed.outcome.padEnd(12)} ${label}`);
}
// 리포 경로에 공백이 있을 수 있다(iCloud Drive). 안내 문구에 그대로 실으면 복붙이 깨진다.
const shown = path.relative(process.cwd(), dataDir) || dataDir;
console.log(`\n저장 위치: ${path.join(shown, 'events')}`);
console.log('다음: DATA_DIR을 같은 자리로 주고 서버를 띄우면 기동 시 파기와 함께 반출된다.');
console.log(`  DATA_DIR="${shown}" EXPORT_URL=http://localhost:9100/samples \\`);
console.log('    npm start -- --main-anchor-id phoneMain --sub-anchor-id phoneSub'
  + ' --anchor-distance 3 --half-plane positive');

/**
 * 실제 레코드와 같은 모양으로 만든다(spec system 03 §6.1). **식별 요소를 일부러 다 채운다** —
 * 반출물에 그중 하나라도 남으면 눈에 띄어야 하기 때문이다.
 */
function build(seed: (typeof SEEDS)[number], at: number): EventRecord {
  const samples = 40; // 50Hz로 0.8초. MIN_SAMPLES(10)를 넉넉히 넘긴다
  return {
    eventId: seed.eventId,
    tagId: 'tag-101',
    ts: at,
    alert: {
      eventId: seed.eventId,
      tagId: 'tag-101',
      ts: at,
      type: 'fall_detected',
      peakAccel: seed.peakAccel,
      freefall: true,
      aiScore: seed.aiScore,
      floor: '2F',
      zone: '화장실(여)',
      pos: { x: 3.1, y: 4.2 },
    },
    track: Array.from({ length: samples }, (_, i) => ({ ts: at + i * 20, x: 3 + i * 0.01, y: 4.2 })),
    // 충격 정점을 흉내낸 파형. 학습 표본으로서 그럴듯한 모양이면 충분하다
    accel: Array.from({ length: samples }, (_, i) => ({
      ts: at + i * 20,
      x: Math.sin(i / 3) * seed.peakAccel,
      y: Math.cos(i / 4) * 0.8,
      z: 9.8 + (i === 20 ? seed.peakAccel * 3 : 0),
    })),
    attachments: [],
    outcome: seed.outcome,
    ...(seed.outcome === 'detected' ? {} : { resolvedAt: at + 60_000, resolvedBy: 'op-1' }),
  };
}
