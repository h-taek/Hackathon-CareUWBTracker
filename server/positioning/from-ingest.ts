import { triangulateTwoAnchors } from './triangulate.ts';

interface IngestRange {
  anchorId: string;
  distance: number;
}

interface IngestPayload {
  tagId: string;
  ts: number;
  ranges?: IngestRange[];
  accel?: { x: number; y: number; z: number };
  source?: string;
}

export interface PositionFromIngestOptions {
  mainAnchorId: string;
  subAnchorId: string;
  anchorDistance: number;
  halfPlane?: 'positive' | 'negative';
  xyError?: number;
  zError?: number;
  /**
   * 켜면 서브 앵커 거리가 없을 때 메인 거리 하나로 좌표를 만든다(테스트 전용, 기본 꺼짐).
   * 거리 1개는 앵커를 중심으로 한 원일 뿐이라 방향이 없다 — 이 각도로 방향을 고정한다.
   */
  singleAnchorBearingDeg?: number;
}

export interface PositionResult {
  tagId: string;
  ts: number;
  pos: { x: number; y: number; z: number };
  err: { xy: number; z: number };
  accel?: { x: number; y: number; z: number };
  source: 'sim' | 'uwb+imu';
  /**
   * 삼각측량이 spec 03의 y 클램프를 탄 프레임에만 실린다(정상해면 아예 없다).
   * 있다는 것 자체가 "이 좌표는 두 거리와 앵커 간격이 안 맞는 상태에서 나왔다"는 신호다.
   */
  geom?: { clamped: true; error: number };
  /**
   * 서브 앵커 없이 거리 하나로 만든 좌표에만 실린다(--single-anchor-bearing).
   * 거리는 실측이지만 방향은 설정값이므로, 이 필드가 있는 좌표는 측위 결과가 아니라 테스트용 추정이다.
   */
  estimate?: { mode: 'single-anchor'; anchorId: string; bearingDeg: number };
  [key: string]: unknown;
}

export function positionFromIngest(payload: IngestPayload, options: PositionFromIngestOptions): PositionResult | null {
  validateOptions(options);

  // accel-only ingest면 ranges가 없거나 비어 있다 → 좌표 계산 보류(낙상은 가속도로 별도 판정).
  if (!Array.isArray(payload.ranges) || payload.ranges.length === 0) return null;

  const mainRange = payload.ranges.find((range) => range.anchorId === options.mainAnchorId);
  const subRange = payload.ranges.find((range) => range.anchorId === options.subAnchorId);
  if (!mainRange || !subRange) {
    // 앵커가 둘 다 있어야 삼각측량이 성립한다. 테스트 모드일 때만 메인 거리 하나로 대체한다.
    if (mainRange && options.singleAnchorBearingDeg !== undefined) {
      return positionFromSingleAnchor(payload, mainRange, options);
    }
    return null;
  }

  const { x, y, clamped, clampError } = triangulateTwoAnchors({
    rA: mainRange.distance,
    rB: subRange.distance,
    d: options.anchorDistance,
    halfPlane: options.halfPlane || 'positive',
  });

  return {
    tagId: payload.tagId,
    ts: payload.ts,
    pos: { x, y, z: 0 },
    err: { xy: options.xyError ?? 0.2, z: options.zError ?? 1.2 },
    accel: payload.accel,
    source: payload.source === 'sim' ? 'sim' : 'uwb+imu',
    // 정상해에는 안 싣는다 — 필드가 있다는 것 자체가 이상 신호가 되게 한다.
    ...(clamped ? { geom: { clamped: true as const, error: clampError } } : {}),
  };
}

/**
 * 서브 앵커가 없는 자리에서 화면을 확인하려는 테스트 경로다(spec 03 §5.1의 측위가 아니다).
 * 메인 앵커에서 잰 거리 r을 고정 방위각 θ에 얹어 (r·cosθ, r·sinθ)에 놓는다 —
 * 거리는 실측이라 태그가 멀어지면 마커도 실제로 멀어지지만, 방향은 전부 설정값이다.
 */
function positionFromSingleAnchor(
  payload: IngestPayload,
  mainRange: IngestRange,
  options: PositionFromIngestOptions,
): PositionResult | null {
  const r = mainRange.distance;
  if (!Number.isFinite(r) || r < 0) return null;

  const bearingDeg = options.singleAnchorBearingDeg as number;
  const theta = (bearingDeg * Math.PI) / 180;

  return {
    tagId: payload.tagId,
    ts: payload.ts,
    pos: { x: r * Math.cos(theta), y: r * Math.sin(theta), z: 0 },
    err: { xy: options.xyError ?? 0.2, z: options.zError ?? 1.2 },
    accel: payload.accel,
    source: payload.source === 'sim' ? 'sim' : 'uwb+imu',
    // 좌표만 보면 진짜 측위와 구분되지 않으므로 프레임마다 꼬리표를 남긴다.
    estimate: { mode: 'single-anchor', anchorId: mainRange.anchorId, bearingDeg },
  };
}

function validateOptions(options: PositionFromIngestOptions): void {
  if (!options || typeof options !== 'object') throw new TypeError('positioning options are required');
  requireNonEmptyString(options.mainAnchorId, 'mainAnchorId');
  requireNonEmptyString(options.subAnchorId, 'subAnchorId');
  if (options.mainAnchorId === options.subAnchorId) {
    throw new RangeError('mainAnchorId and subAnchorId must be different');
  }
}

function requireNonEmptyString(value: unknown, name: string): void {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}
