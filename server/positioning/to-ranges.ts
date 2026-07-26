// triangulate의 역함수: (x,y) 좌표 → 두 앵커까지의 거리.
//
// 쓰는 곳은 클립 주입이다. 공개 낙상 데이터셋에는 가속도만 있고 UWB 거리가 없어서,
// 클립을 실제 측위 경로로 통과시키려면 "이 자리에 있는 태그라면 앵커가 이렇게 쟀을 것"이라는
// 거리를 만들어 넣어야 한다. 좌표를 직접 꽂지 않고 거리로 되돌리는 이유는, 그래야
// from-ingest → triangulate → smoother가 실측과 똑같이 돌기 때문이다.

export interface AnchorGeometry {
  mainAnchorId: string;
  subAnchorId: string;
  /** 두 앵커 사이 거리 d. 메인은 (0,0), 서브는 (d,0) */
  anchorDistance: number;
  halfPlane?: 'positive' | 'negative';
}

export interface RangeReading {
  anchorId: string;
  distance: number;
}

/**
 * 삼각측량은 반평면 하나만 되돌려 준다(두 원의 교점이 기준선 대칭으로 둘이라 부호를 못 정한다).
 * 그래서 설정된 반평면 밖의 점을 그대로 쓰면 측위 결과가 기준선 너머로 뒤집혀 나온다.
 * 여기서 미리 접어 넣어 왕복이 정확히 맞게 한다.
 */
export function rangesForPoint(
  point: { x: number; y: number },
  geometry: AnchorGeometry,
): RangeReading[] {
  const { mainAnchorId, subAnchorId, anchorDistance: d } = geometry;
  if (!Number.isFinite(d) || d <= 0) {
    throw new RangeError('anchorDistance must be a positive finite number');
  }
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new RangeError('point must have finite x and y');
  }

  const y = geometry.halfPlane === 'negative' ? -Math.abs(point.y) : Math.abs(point.y);
  return [
    { anchorId: mainAnchorId, distance: round(Math.hypot(point.x, y)) },
    { anchorId: subAnchorId, distance: round(Math.hypot(point.x - d, y)) },
  ];
}

// UWB 거리는 cm 단위까지가 의미 있는 자리다. 실측 프레임과 자릿수를 맞춘다.
function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
