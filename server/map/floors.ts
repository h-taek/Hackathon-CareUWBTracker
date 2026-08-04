// 층 모델 — 맵 파일을 읽어 검증하고, 앵커 ID로 층을 찾아준다(spec system 03 §5.1·§5.2).
//
// **층은 좌표가 아니라 앵커가 정한다.** UWB z를 어디에도 쓰지 않으므로(spec system 05 §3)
// 높이로 층을 맞히는 경로가 없고, 애초에 층은 앵커 설치 단위로 갈린다. 그래서 이 파일이
// 하는 일은 둘뿐이다 — 선언을 검증하는 것과, `ranges[].anchorId`를 층으로 바꾸는 것.
//
// 검증을 시작할 때 다 끝내고 던지는 이유는, **틀린 층으로 도는 서버가 가장 나쁘기** 때문이다.
// 사고 기록에 그대로 박히고 나중에 되돌릴 방법이 없다. 도는 중에 알아내면 이미 늦었다.

import type { Zone, ZoneMap } from '../lib/zone.ts';

/** 한 층. `zones`를 가지므로 ZoneMap이 요구하는 것을 그대로 만족한다 — 구역 판정 함수를 그대로 쓴다. */
export interface Floor extends ZoneMap {
  id: string;
  /** 화면 표시명. "2층 · 요양생활실" */
  name: string;
  /** 그 층 도면 SVG 경로. 서버는 이 파일을 열지 않는다 — 화면이 받아 간다. */
  plan: string;
  /** 그 층에 설치된 앵커 ID. `[메인, 서브]` 순서다. */
  anchors: string[];
  zones: Zone[];
  hazards: Zone[];
}

export interface FacilityMap {
  name: string;
  /** 전 층 공통 도면 좌표계. 가벽으로 바뀌는 것은 내부지 건물 외곽이 아니다. */
  bounds: { x: [number, number]; y: [number, number] };
  floors: Floor[];
}

/** 맵 선언이 틀렸다. 서버는 이걸 받으면 시작하지 않는다. */
export class MapConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MapConfigError';
  }
}

function fail(message: string): never {
  throw new MapConfigError(message);
}

function requireText(value: unknown, what: string): string {
  if (typeof value !== 'string' || !value.trim()) fail(`${what}가 비었습니다`);
  return (value as string).trim();
}

function parseZone(raw: unknown, what: string): Zone {
  const z = raw as Record<string, unknown> | null;
  if (!z || typeof z !== 'object') fail(`${what}가 객체가 아닙니다`);
  const rect = z.rect;
  if (!Array.isArray(rect) || rect.length !== 4 || rect.some((n) => typeof n !== 'number')) {
    fail(`${what}.rect는 숫자 4개여야 합니다`);
  }
  const zone: Zone = {
    id: requireText(z.id, `${what}.id`),
    label: requireText(z.label, `${what}.label`),
    rect: rect as [number, number, number, number],
  };
  if (z.privacy === true) zone.privacy = true;
  if (z.walkable === true) zone.walkable = true;
  return zone;
}

/**
 * 맵 JSON을 검증해 층 배열로 만든다. 어긋난 데가 있으면 MapConfigError를 던진다.
 *
 * 앵커 중복을 막는 이유는 층 판정이 모호해지기 때문이다 — 같은 앵커가 2층과 3층에
 * 적혀 있으면 그 앵커가 잡은 프레임이 어느 층인지 정할 방법이 없다.
 */
export function parseFacilityMap(raw: unknown): FacilityMap {
  const doc = raw as Record<string, unknown> | null;
  if (!doc || typeof doc !== 'object') fail('맵이 객체가 아닙니다');

  const bounds = doc.bounds as { x?: unknown; y?: unknown } | undefined;
  if (!bounds || !Array.isArray(bounds.x) || !Array.isArray(bounds.y)
    || bounds.x.length !== 2 || bounds.y.length !== 2) {
    fail('bounds.x·bounds.y는 각각 숫자 2개여야 합니다');
  }

  const rawFloors = doc.floors;
  if (!Array.isArray(rawFloors) || rawFloors.length === 0) {
    fail('floors가 비었습니다. 맵은 층의 배열이어야 합니다(spec system 03 §5.2)');
  }

  const seenFloorIds = new Set<string>();
  const anchorOwner = new Map<string, string>();
  const floors: Floor[] = rawFloors.map((rawFloor, index) => {
    const f = rawFloor as Record<string, unknown> | null;
    if (!f || typeof f !== 'object') fail(`floors[${index}]가 객체가 아닙니다`);

    const id = requireText(f.id, `floors[${index}].id`);
    if (seenFloorIds.has(id)) fail(`층 id가 중복입니다: ${id}`);
    seenFloorIds.add(id);

    if (!Array.isArray(f.anchors) || f.anchors.some((a) => typeof a !== 'string' || !a.trim())) {
      fail(`${id}.anchors는 앵커 ID 문자열 배열이어야 합니다`);
    }
    const anchors = (f.anchors as string[]).map((a) => a.trim());
    for (const anchorId of anchors) {
      const owner = anchorOwner.get(anchorId);
      // 여기서 막지 않으면 그 앵커의 프레임이 어느 층인지 정할 수 없다.
      if (owner) fail(`앵커 ${anchorId}가 ${owner}와 ${id} 두 층에 적혀 있습니다`);
      anchorOwner.set(anchorId, id);
    }

    if (!Array.isArray(f.zones) || f.zones.length === 0) fail(`${id}.zones가 비었습니다`);
    const zones = f.zones.map((z, i) => parseZone(z, `${id}.zones[${i}]`));
    const rawHazards = f.hazards;
    if (rawHazards !== undefined && !Array.isArray(rawHazards)) fail(`${id}.hazards는 배열이어야 합니다`);
    const hazards = ((rawHazards as unknown[]) ?? []).map((z, i) => parseZone(z, `${id}.hazards[${i}]`));

    return {
      id,
      name: requireText(f.name, `${id}.name`),
      plan: requireText(f.plan, `${id}.plan`),
      anchors,
      zones,
      hazards,
    };
  });

  return {
    name: typeof doc.name === 'string' ? doc.name : '',
    bounds: { x: bounds.x as [number, number], y: bounds.y as [number, number] },
    floors,
  };
}

/** 프레임에 실려 오는 앵커 거리. 층을 찾는 데는 `anchorId`만 본다. */
export interface AnchorRange {
  anchorId: string;
}

export interface FloorIndex {
  map: FacilityMap;
  floors: Floor[];
  /** 층 id로 찾는다. 없으면 null. */
  byId(floorId: string): Floor | null;
  /** 앵커 ID가 속한 층. 어느 층에도 없으면 null. */
  byAnchor(anchorId: string): Floor | null;
  /**
   * 프레임의 앵커 거리에서 층을 찾는다. **처음 알아본 앵커가 이긴다** —
   * 한 프레임의 거리들은 같은 앵커 쌍에서 오므로 둘이 갈릴 일이 없고,
   * 갈린다면 그건 앵커 배치가 틀린 것이라 조용히 고르는 게 오히려 위험하다.
   */
  ofRanges(ranges: readonly AnchorRange[] | undefined): Floor | null;
  /**
   * 실행 인자로 받은 앵커 쌍이 속한 층. **둘이 같은 층에 있어야 한다.**
   * 아니면 실측 프레임이 어느 층 것인지 정할 수 없으므로 던진다.
   */
  requireAnchorPair(mainAnchorId: string, subAnchorId: string): Floor;
}

export function createFloorIndex(map: FacilityMap): FloorIndex {
  const byIdMap = new Map(map.floors.map((f) => [f.id, f]));
  const byAnchorMap = new Map<string, Floor>();
  for (const floor of map.floors) {
    for (const anchorId of floor.anchors) byAnchorMap.set(anchorId, floor);
  }

  const byAnchor = (anchorId: string): Floor | null => byAnchorMap.get(anchorId) ?? null;

  return {
    map,
    floors: map.floors,
    byId: (floorId) => byIdMap.get(floorId) ?? null,
    byAnchor,
    ofRanges(ranges) {
      if (!Array.isArray(ranges)) return null;
      for (const range of ranges) {
        const floor = range && typeof range.anchorId === 'string' ? byAnchor(range.anchorId) : null;
        if (floor) return floor;
      }
      return null;
    },
    requireAnchorPair(mainAnchorId, subAnchorId) {
      const main = byAnchor(mainAnchorId);
      if (!main) {
        fail(`실행 인자의 메인 앵커 ${mainAnchorId}가 맵의 어느 층에도 없습니다`
          + ` (map.json의 floors[].anchors에 적어야 합니다)`);
      }
      const sub = byAnchor(subAnchorId);
      if (!sub) {
        fail(`실행 인자의 서브 앵커 ${subAnchorId}가 맵의 어느 층에도 없습니다`
          + ` (map.json의 floors[].anchors에 적어야 합니다)`);
      }
      if (main.id !== sub.id) {
        fail(`앵커 쌍이 서로 다른 층에 있습니다: ${mainAnchorId}=${main.id}, ${subAnchorId}=${sub.id}`);
      }
      return main;
    },
  };
}
