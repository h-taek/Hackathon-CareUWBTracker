// 평가/스윕 결과를 콘솔 텍스트 표로 포매팅(순수 함수).

import type { EvaluationResult, SweepResult } from './evaluate.ts';

export function pct(x: number | null | undefined): string {
  return x == null ? '  -  ' : `${(x * 100).toFixed(1)}%`.padStart(5);
}

// 데이터셋×위치 그룹 + 전체 혼동행렬 표. 판정 수준은 하나(fall_detected)다.
export function formatEvaluation(result: EvaluationResult, { title = '평가' }: { title?: string } = {}): string {
  const lines: string[] = [];
  lines.push(`=== ${title} ===`);
  const groups = [...result.byGroup.values()]
    .sort((a, b) => (a.dataset + a.placement).localeCompare(b.dataset + b.placement));
  lines.push('');
  lines.push('[DETECTED(충격 감지)]');
  lines.push(`${'dataset'.padEnd(12)} ${'place'.padEnd(7)} | 민감도  특이도  정밀도  헛경보    F1   균형  | tp/fp/fn/tn`);
  for (const g of groups) {
    const m = g.detected.metrics();
    lines.push(`${g.dataset.padEnd(12)} ${g.placement.padEnd(7)} | ${pct(m.sens)}  ${pct(m.spec)}  ${pct(m.prec)}  ${pct(m.fa)}  ${pct(m.f1)}  ${pct(m.bacc)} | ${m.tp}/${m.fp}/${m.fn}/${m.tn}`);
  }
  const om = result.overall.metrics();
  lines.push(`${'전체'.padEnd(11)} ${''.padEnd(7)} | ${pct(om.sens)}  ${pct(om.spec)}  ${pct(om.prec)}  ${pct(om.fa)}  ${pct(om.f1)}  ${pct(om.bacc)} | ${om.tp}/${om.fp}/${om.fn}/${om.tn}`);
  return lines.join('\n');
}

// 임계 스윕 트레이드오프 곡선 표. sweep: sweepAll 반환값.
export function formatSweep(sweep: SweepResult): string {
  const lines: string[] = [];
  lines.push('=== 임계값 스윕 (트레이드오프 곡선) ===');
  lines.push('affects: detected=감지 여부를 바꿈 / flag-only=감지무관(freefall 표시 플래그만)');
  for (const [param, info] of Object.entries(sweep)) {
    lines.push('');
    lines.push(`--- ${param}  (기본 ${info.base}, affects: ${info.affects}) ---`);
    lines.push(`${'value'.padStart(8)} | 민감도 특이도 헛경보    F1   균형`);
    for (const p of info.points) {
      const m = p.detected;
      const mark = String(p.value) === String(info.base) ? ' *' : '  ';
      lines.push(`${String(p.value).padStart(8)}${mark}| ${pct(m.sens)} ${pct(m.spec)} ${pct(m.fa)} ${pct(m.f1)} ${pct(m.bacc)}`);
    }
  }
  lines.push('');
  lines.push('(* = 현재 기본값)');
  return lines.join('\n');
}
