// 도면과 map.json은 한 몸이다(spec system 03 §5.2.1).
//
// 같은 층을 둘이 따로 적으므로 어긋날 수 있고, **가장 흔한 것은 이름 어긋남**이다 —
// 도면 글자는 `301호`인데 라벨은 `201호`인 상태. 화면에는 301호가 보이고 경보 문구와
// 사고 기록에는 201호가 남는데, 두 글자가 한 화면에 같이 뜨지 않아 눈으로는 못 잡는다.
//
// 좌표 어긋남(마커가 벽 속에 찍히는 것)은 화면에 바로 보이므로 여기서 안 본다.

import * as assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { parseFacilityMap } from '../../server/map/floors.ts';

const SERVER_DIR = path.join(import.meta.dirname, '..', '..', 'server');
const map = parseFacilityMap(JSON.parse(fs.readFileSync(path.join(SERVER_DIR, 'map.json'), 'utf8')));

/**
 * 도면의 실명. `id="roomLabels"` 그룹 안의 `<text>`만 읽는다.
 *
 * 보조 표기(`4인실`·`사생활 구역`·`위험구역`)는 구역이 아니라 설명이므로 대조 대상이
 * 아니다. 그래서 도면이 그 둘을 그룹으로 갈라 두는 것이고, 여기서도 그 경계를 따른다.
 */
function roomLabelsOf(svg: string): string[] {
  const group = /<g[^>]*id="roomLabels"[\s\S]*?<\/g>/.exec(svg);
  assert.ok(group, '도면에 id="roomLabels" 그룹이 없다 — 실명을 대조할 수 없다');
  return [...group[0].matchAll(/<text[^>]*>([^<]*)<\/text>/g)]
    .map((m) => m[1]!.trim())
    .filter(Boolean);
}

const planPathOf = (plan: string) => path.join(SERVER_DIR, 'public', plan.replace(/^\//, ''));

test('층마다 도면 파일이 있다', () => {
  for (const floor of map.floors) {
    assert.ok(fs.existsSync(planPathOf(floor.plan)), `${floor.id}의 도면이 없다: ${floor.plan}`);
  }
});

test('층마다 도면이 다른 파일이다 — 한 장을 공유하면 가벽 차이를 표현할 수 없다', () => {
  const plans = map.floors.map((f) => f.plan);
  assert.equal(new Set(plans).size, plans.length, `도면 경로가 겹친다: ${plans.join(', ')}`);
});

test('도면의 실명이 그 층 zones 라벨에 다 있다', () => {
  for (const floor of map.floors) {
    const svg = fs.readFileSync(planPathOf(floor.plan), 'utf8');
    const labels = new Set(floor.zones.map((z) => z.label));
    for (const drawn of roomLabelsOf(svg)) {
      assert.ok(labels.has(drawn),
        `${floor.id} 도면에 "${drawn}"이 그려져 있는데 zones에는 없다`
        + ` — 도면이나 map.json 한쪽만 고쳤다`);
    }
  }
});

// 같은 글자가 두 번 그려져 있으면 어느 구역을 가리키는지 알 수 없다.
test('한 도면 안에 같은 실명이 두 번 나오지 않는다', () => {
  for (const floor of map.floors) {
    const drawn = roomLabelsOf(fs.readFileSync(planPathOf(floor.plan), 'utf8'));
    assert.equal(new Set(drawn).size, drawn.length,
      `${floor.id} 도면에 같은 실명이 두 번 있다: ${drawn.join(', ')}`);
  }
});

// 통행 구역이 없으면 시뮬 태그가 그 층에서 갈 곳이 없어 경계 안을 아무렇게나 걷는다.
test('층마다 통행 구역과 사생활 구역이 하나씩은 있다', () => {
  for (const floor of map.floors) {
    assert.ok(floor.zones.some((z) => z.walkable), `${floor.id}에 walkable 구역이 없다`);
    assert.ok(floor.zones.some((z) => z.privacy), `${floor.id}에 사생활 구역이 없다`);
  }
});

// 도면은 viewBox 3200x2000에 100px = 1m로 그려져 있다. 구역이 그 밖으로 나가면
// 마커가 도면 밖에 찍힌다.
test('구역 사각형이 맵 경계 안에 있다', () => {
  const [x0, x1] = map.bounds.x;
  const [y0, y1] = map.bounds.y;
  for (const floor of map.floors) {
    for (const zone of [...floor.zones, ...floor.hazards]) {
      const [zx, zy, zw, zh] = zone.rect;
      assert.ok(zx >= x0 && zy >= y0 && zx + zw <= x1 && zy + zh <= y1,
        `${floor.id} ${zone.label}이 경계를 벗어난다: ${JSON.stringify(zone.rect)}`);
    }
  }
});
