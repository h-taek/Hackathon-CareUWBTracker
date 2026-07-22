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
}

export interface PositionResult {
  tagId: string;
  ts: number;
  pos: { x: number; y: number; z: number };
  err: { xy: number; z: number };
  accel?: { x: number; y: number; z: number };
  source: 'sim' | 'uwb+imu';
  [key: string]: unknown;
}

export function positionFromIngest(payload: IngestPayload, options: PositionFromIngestOptions): PositionResult | null {
  validateOptions(options);

  // accel-only ingest면 ranges가 없거나 비어 있다 → 좌표 계산 보류(낙상은 가속도로 별도 판정).
  if (!Array.isArray(payload.ranges) || payload.ranges.length === 0) return null;

  const mainRange = payload.ranges.find((range) => range.anchorId === options.mainAnchorId);
  const subRange = payload.ranges.find((range) => range.anchorId === options.subAnchorId);
  if (!mainRange || !subRange) return null;

  const { x, y } = triangulateTwoAnchors({
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
