// 맵 좌표 (x,y)가 든 첫 zone의 라벨을 반환(순수). 없으면 '미지정'.

export interface Zone {
  id: string;
  label: string;
  rect: [number, number, number, number];
  /** 사생활 구역(F-6). 여기 들어온 대상은 좌표를 남기지 않는다(spec 03 §1.1). */
  privacy?: boolean;
  /** 시뮬 배경 태그가 걸어도 되는 구역. 복도·라운지처럼 실제로 통행하는 곳만 표시한다. */
  walkable?: boolean;
}

export interface ZoneMap {
  zones: Zone[];
}

export function zoneAt(map: ZoneMap, x: number, y: number): string {
  for (const z of map.zones) {
    const [rx, ry, rw, rh] = z.rect;
    if (x >= rx && x <= rx + rw && y >= ry && y <= ry + rh) return z.label;
  }
  return '미지정';
}
