'use strict';

// 평가/스윕 결과를 콘솔 텍스트 표로 포매팅(순수 함수).

function pct(x) {
  return x == null ? '  -  ' : `${(x * 100).toFixed(1)}%`.padStart(5);
}

// 혼동행렬 지표 한 줄(candidate 또는 confirmed).
function metricsLine(m) {
  return `민감도 ${pct(m.sens)}  특이도 ${pct(m.spec)}  정밀도 ${pct(m.prec)}  헛경보 ${pct(m.fa)}  F1 ${pct(m.f1)}  균형정확도 ${pct(m.bacc)}  [tp${m.tp} fp${m.fp} fn${m.fn} tn${m.tn}]`;
}

// 데이터셋×위치 그룹 + 전체 혼동행렬 표(candidate/confirmed 각각).
function formatEvaluation(result, { title = '평가' } = {}) {
  const lines = [];
  lines.push(`=== ${title} ===`);
  const groups = [...result.byGroup.values()]
    .sort((a, b) => (a.dataset + a.placement).localeCompare(b.dataset + b.placement));
  for (const level of ['candidate', 'confirmed']) {
    lines.push('');
    lines.push(`[${level === 'candidate' ? 'CANDIDATE(충격 감지)' : 'CONFIRMED(충격+무동작 5초)'}]`);
    lines.push(`${'dataset'.padEnd(12)} ${'place'.padEnd(7)} | 민감도  특이도  정밀도  헛경보    F1   균형  | tp/fp/fn/tn`);
    for (const g of groups) {
      const m = g[level].metrics();
      lines.push(`${g.dataset.padEnd(12)} ${g.placement.padEnd(7)} | ${pct(m.sens)}  ${pct(m.spec)}  ${pct(m.prec)}  ${pct(m.fa)}  ${pct(m.f1)}  ${pct(m.bacc)} | ${m.tp}/${m.fp}/${m.fn}/${m.tn}`);
    }
    const om = result.overall[level].metrics();
    lines.push(`${'전체'.padEnd(11)} ${''.padEnd(7)} | ${pct(om.sens)}  ${pct(om.spec)}  ${pct(om.prec)}  ${pct(om.fa)}  ${pct(om.f1)}  ${pct(om.bacc)} | ${om.tp}/${om.fp}/${om.fn}/${om.tn}`);
  }
  return lines.join('\n');
}

// 임계 스윕 트레이드오프 곡선 표. sweep: sweepAll 반환값.
function formatSweep(sweep) {
  const lines = [];
  lines.push('=== 임계값 스윕 (트레이드오프 곡선) ===');
  lines.push('affects: candidate=충격판정만 / confirmed=확진만 / flag-only=판정무관(표시플래그만)');
  for (const [param, info] of Object.entries(sweep)) {
    lines.push('');
    lines.push(`--- ${param}  (기본 ${info.base}, affects: ${info.affects}) ---`);
    lines.push(`${'value'.padStart(8)} | cand: 민감도 특이도 헛경보 |  conf: 민감도 특이도 헛경보`);
    for (const p of info.points) {
      const c = p.candidate; const f = p.confirmed;
      const mark = String(p.value) === String(info.base) ? ' *' : '  ';
      lines.push(`${String(p.value).padStart(8)}${mark}| ${pct(c.sens)} ${pct(c.spec)} ${pct(c.fa)} | ${pct(f.sens)} ${pct(f.spec)} ${pct(f.fa)}`);
    }
  }
  lines.push('');
  lines.push('(* = 현재 기본값)');
  return lines.join('\n');
}

module.exports = { pct, metricsLine, formatEvaluation, formatSweep };
