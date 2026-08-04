// 수신 ingest 프레임을 콘솔 한 줄로 포맷(순수 함수 — 테스트 가능). server.ts가 이 문자열을 찍는다.
// ts=에폭ms(시:분:초.밀리초), src=ni/sim, ranges=앵커 거리(main/sub 슬롯 고정, 없으면 '-'),
// pos=삼각측량 좌표(2앵커면 (x,y), 부족하면 (-,-)), |a|=가속도 크기(m/s²·g). 정지 ≈9.81 m/s²(1g).
// 사생활 구역 프레임은 좌표도 거리도 안 찍고 구역명만 남긴다(spec system 03 §1.1).

export const DEFAULT_GRAVITY = 9.80665; // m/s² per 1g

export interface IngestRange {
  anchorId: string;
  distance: number;
}

export interface IngestAccel {
  x?: number;
  y?: number;
  z?: number;
}

export interface IngestPayload {
  tagId: string;
  ts: number;
  source: string;
  ranges?: IngestRange[];
  accel?: IngestAccel;
  [key: string]: unknown;
}

export interface IngestPosition {
  pos: { x: number; y: number; z?: number } | null;
  /** 사생활 구역 정책으로 좌표가 지워진 프레임(spec 03 §1.1). 로그에도 좌표를 남기지 않는다. */
  privacy?: boolean;
  zone?: string;
}

export interface FormatIngestLineOptions {
  mainAnchorId?: string;
  subAnchorId?: string;
  gravity?: number;
}

export function formatIngestLine(
  payload: IngestPayload,
  position: IngestPosition | null | undefined,
  options: FormatIngestLineOptions = {},
): string {
  const mainAnchorId = options.mainAnchorId || 'phoneMain';
  const subAnchorId = options.subAnchorId || 'phoneSub';
  const gravity = options.gravity || DEFAULT_GRAVITY;
  const f = (v: unknown): string => (typeof v === 'number' ? v.toFixed(2) : '-');

  const d = new Date(payload.ts);
  const p2 = (v: number): string => String(v).padStart(2, '0');
  const time = Number.isFinite(payload.ts)
    ? `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`
    : String(payload.ts);

  // 사생활 구역은 좌표도 앵커 거리도 찍지 않는다. 거리 둘이면 삼각측량으로 그 자리가
  // 다시 나오므로, pos만 가리고 ranges를 남기면 가린 게 아니다(spec 03 §1.1).
  if (position?.privacy) {
    const a0 = payload.accel || {};
    const mag0 = Math.hypot(a0.x || 0, a0.y || 0, a0.z || 0);
    return (
      `[ingest] ${payload.tagId}  ${time}  src=${payload.source}  ranges: (사생활 구역 · 미기록)  `
      + `pos=(사생활 구역 · ${position.zone || '구역 미지정'})  `
      + `a=(${f(a0.x)},${f(a0.y)},${f(a0.z)}) m/s²  |a|=${mag0.toFixed(2)} m/s² (${(mag0 / gravity).toFixed(2)}g)`
    );
  }

  // main/sub 두 슬롯은 값이 없어도 '-'로 항상 찍는다 → "안 온 건지/없는 건지" 구분 가능.
  const ranges = Array.isArray(payload.ranges) ? payload.ranges : [];
  const byId = new Map(ranges.map((r) => [r.anchorId, r.distance]));
  const slot = (id: string): string => `${id}=${byId.has(id) ? `${f(byId.get(id))}m` : '-'}`;
  const known = [slot(mainAnchorId), slot(subAnchorId)];
  const extra = ranges
    .filter((r) => r.anchorId !== mainAnchorId && r.anchorId !== subAnchorId)
    .map((r) => `${r.anchorId}=${f(r.distance)}m`);
  const rangeStr = `${[...known, ...extra].join(' ')}${ranges.length ? '' : '  (accel-only)'}`;

  const posStr = position?.pos
    ? `pos=(${f(position.pos.x)}, ${f(position.pos.y)})`
    : 'pos=(-, -)'; // 앵커 1대뿐(서브 미연결) → 좌표 보류, 빈 값 표기

  const a = payload.accel || {};
  const mag = Math.hypot(a.x || 0, a.y || 0, a.z || 0);

  return (
    `[ingest] ${payload.tagId}  ${time}  src=${payload.source}  ranges: ${rangeStr}  ${posStr}  ` +
    `a=(${f(a.x)},${f(a.y)},${f(a.z)}) m/s²  |a|=${mag.toFixed(2)} m/s² (${(mag / gravity).toFixed(2)}g)`
  );
}
