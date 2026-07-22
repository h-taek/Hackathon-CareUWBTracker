export interface IngestPayload {
  tagId: string;
  [key: string]: unknown;
}

const ALLOWED_SOURCES: Set<string> = new Set(['ni', 'sim']);

export class IngestValidationError extends Error {
  issues: string[];

  constructor(issues: string[]) {
    super(`invalid ingest: ${issues.join('; ')}`);
    this.name = 'IngestValidationError';
    this.issues = issues;
  }
}

export function validateIngest(payload: unknown): IngestPayload {
  const issues: string[] = [];

  if (!isPlainObject(payload)) {
    throw new IngestValidationError(['payload must be a JSON object']);
  }

  requireNonEmptyString(payload.tagId, 'tagId', issues);
  requireNonNegativeNumber(payload.ts, 'ts', issues);
  validateRanges(payload.ranges, issues);
  validateAccel(payload.accel, issues);

  if (!ALLOWED_SOURCES.has(payload.source as string)) {
    issues.push('source must be one of: ni, sim');
  }

  if (issues.length > 0) throw new IngestValidationError(issues);
  return payload as IngestPayload;
}

function validateRanges(ranges: unknown, issues: string[]): void {
  // accel-only ingest: 낙상 판정은 가속도만으로 하므로 NI(UWB)가 붙기 전/끊긴 구간엔
  // ranges가 비어 온다. 빈/없는 ranges는 허용하고 위치 계산만 보류한다(spec 03 §5.1).
  if (ranges === undefined || ranges === null || (Array.isArray(ranges) && ranges.length === 0)) {
    return;
  }
  if (!Array.isArray(ranges) || ranges.length > 2) {
    issues.push('ranges must be an array of at most two anchors');
    return;
  }

  const anchorIds = new Set<string>();
  ranges.forEach((range: unknown, index: number) => {
    const path = `ranges[${index}]`;
    if (!isPlainObject(range)) {
      issues.push(`${path} must be an object`);
      return;
    }

    requireNonEmptyString(range.anchorId, `${path}.anchorId`, issues);
    requireNonNegativeNumber(range.distance, `${path}.distance`, issues);

    if (typeof range.anchorId === 'string' && range.anchorId.trim()) {
      if (anchorIds.has(range.anchorId)) issues.push(`${path}.anchorId must be unique`);
      anchorIds.add(range.anchorId);
    }
  });
}

function validateAccel(accel: unknown, issues: string[]): void {
  if (!isPlainObject(accel)) {
    issues.push('accel must be an object');
    return;
  }

  for (const axis of ['x', 'y', 'z'] as const) {
    if (!Number.isFinite(accel[axis] as number)) issues.push(`accel.${axis} must be a finite number`);
  }
}

function requireNonEmptyString(value: unknown, path: string, issues: string[]): void {
  if (typeof value !== 'string' || !value.trim()) issues.push(`${path} must be a non-empty string`);
}

function requireNonNegativeNumber(value: unknown, path: string, issues: string[]): void {
  if (!Number.isFinite(value as number) || (value as number) < 0) {
    issues.push(`${path} must be a non-negative finite number`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
