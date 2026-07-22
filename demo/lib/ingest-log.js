'use strict';

// 수신 ingest 프레임을 콘솔 한 줄로 포맷(순수 함수 — 테스트 가능). server.ts가 이 문자열을 찍는다.
// ts=에폭ms(시:분:초.밀리초), src=ni/sim, ranges=앵커 거리(main/sub 슬롯 고정, 없으면 '-'),
// pos=삼각측량 좌표(2앵커면 (x,y), 부족하면 (-,-)), |a|=가속도 크기(m/s²·g). 정지 ≈9.81 m/s²(1g).

const DEFAULT_GRAVITY = 9.80665; // m/s² per 1g

function formatIngestLine(payload, position, options = {}) {
  const mainAnchorId = options.mainAnchorId || 'phoneMain';
  const subAnchorId = options.subAnchorId || 'phoneSub';
  const gravity = options.gravity || DEFAULT_GRAVITY;
  const f = (v) => (typeof v === 'number' ? v.toFixed(2) : '-');

  const d = new Date(payload.ts);
  const p2 = (v) => String(v).padStart(2, '0');
  const time = Number.isFinite(payload.ts)
    ? `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`
    : String(payload.ts);

  // main/sub 두 슬롯은 값이 없어도 '-'로 항상 찍는다 → "안 온 건지/없는 건지" 구분 가능.
  const ranges = Array.isArray(payload.ranges) ? payload.ranges : [];
  const byId = new Map(ranges.map((r) => [r.anchorId, r.distance]));
  const slot = (id) => `${id}=${byId.has(id) ? `${f(byId.get(id))}m` : '-'}`;
  const known = [slot(mainAnchorId), slot(subAnchorId)];
  const extra = ranges
    .filter((r) => r.anchorId !== mainAnchorId && r.anchorId !== subAnchorId)
    .map((r) => `${r.anchorId}=${f(r.distance)}m`);
  const rangeStr = `${[...known, ...extra].join(' ')}${ranges.length ? '' : '  (accel-only)'}`;

  const posStr = position
    ? `pos=(${f(position.pos.x)}, ${f(position.pos.y)})`
    : 'pos=(-, -)'; // 앵커 1대뿐(서브 미연결) → 좌표 보류, 빈 값 표기

  const a = payload.accel || {};
  const mag = Math.hypot(a.x || 0, a.y || 0, a.z || 0);

  return (
    `[ingest] ${payload.tagId}  ${time}  src=${payload.source}  ranges: ${rangeStr}  ${posStr}  ` +
    `a=(${f(a.x)},${f(a.y)},${f(a.z)}) m/s²  |a|=${mag.toFixed(2)} m/s² (${(mag / gravity).toFixed(2)}g)`
  );
}

module.exports = { formatIngestLine, DEFAULT_GRAVITY };
