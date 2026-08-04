// 처리사실 확인자료와 접속기록(spec 11 §4.6).
//
// **좌표는 지우고 이 기록은 남긴다.** 방향이 반대인 이유는 목적이 다르기 때문이다 —
// 좌표 파기는 정보주체를 지키는 것이고, 이 기록은 "우리가 함부로 쓴 적 없다"를 나중에
// 증명하기 위한 것이다. 위치정보법 제23조 제1항 본문이 파기 대상에서 이 자료를 뺀다.
//
// 근거가 둘 겹친다. 위치정보법 제16조 제2항(수집·이용·제공사실 확인자료를 자동 기록·보존)과
// 개인정보보호법 시행령 제30조 제1항 제5호(접속기록 보관). **한 번 만들면 둘을 같이 채운다.**
//
// 미이행은 과태료가 아니라 형사처벌이다 — 위치정보법 제41조 제4의2호, 1년 이하 징역.

import * as fs from 'node:fs';
import * as path from 'node:path';

/** 수집 / 이용 / 제공 / 접근. 조문이 앞 셋을 열거하고, 넷째는 시행령 제30조의 접속기록이다. */
export const AUDIT_KINDS = ['collect', 'use', 'provide', 'access'] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];

export interface AuditEntry {
  at: number;
  kind: AuditKind;
  /** 대상 태그. 시스템 동작이면 없다. */
  tagId?: string;
  /** 행위자. 관제사 ID(`op-N`) 아니면 'system'이다(spec operation 03 §5). */
  actor: string;
  /** 무엇을 했는지 한 줄. **좌표를 여기 적으면 그 자체가 위반이다.** */
  detail: string;
}

export interface AuditLog {
  record(entry: Omit<AuditEntry, 'at'> & { at?: number }): void;
  /** 태그의 수집 세션을 연다. 이미 열려 있으면 아무 일도 안 한다. */
  openCollect(tagId: string): void;
  /** 열린 세션을 닫고 지속 시간을 남긴다. 안 열려 있으면 아무 일도 안 한다. */
  closeCollect(tagId: string): void;
  /** 지금 열려 있는 수집 세션을 전부 닫는다(종료·테스트용). */
  closeAll(): void;
  dir: string;
}

/**
 * 수집 세션이 이만큼 조용하면 끝난 것으로 본다. 프레임이 5Hz~50Hz로 들어오므로
 * 이보다 오래 비면 태그가 꺼졌거나 범위를 벗어난 것이다.
 */
export const COLLECT_IDLE_MS = 30_000;

export interface AuditLogOptions {
  now?: () => number;
  /** 테스트가 파일을 안 건드리고 확인하는 창구. */
  onEntry?: (entry: AuditEntry) => void;
}

export function createAuditLog(dir: string, options: AuditLogOptions = {}): AuditLog {
  const now = options.now ?? Date.now;
  /** 태그별로 열려 있는 수집 세션의 개시 시각. */
  const openSince = new Map<string, number>();

  function write(entry: AuditEntry): void {
    options.onEntry?.(entry);
    try {
      fs.mkdirSync(dir, { recursive: true });
      // 날짜별 파일이라 하루치를 통째로 반출할 수 있고, 한 파일이 무한정 자라지 않는다.
      fs.appendFileSync(path.join(dir, `${dayOf(entry.at)}.jsonl`), `${JSON.stringify(entry)}\n`, 'utf8');
    } catch (error: unknown) {
      // 확인자료를 못 써도 관제는 멈추면 안 된다. 다만 조용히 넘어가면 보존 의무가
      // 깨진 걸 아무도 모르게 되므로 콘솔에는 남긴다.
      console.error('[audit] 기록 실패', error);
    }
  }

  function record(entry: Omit<AuditEntry, 'at'> & { at?: number }): void {
    write({ ...entry, at: entry.at ?? now() });
  }

  function openCollect(tagId: string): void {
    if (openSince.has(tagId)) return;
    const at = now();
    openSince.set(tagId, at);
    write({ at, kind: 'collect', tagId, actor: 'system', detail: '측위 수집 개시' });
  }

  function closeCollect(tagId: string): void {
    const since = openSince.get(tagId);
    if (since === undefined) return;
    openSince.delete(tagId);
    const at = now();
    write({
      at,
      kind: 'collect',
      tagId,
      actor: 'system',
      detail: `측위 수집 종료 · ${Math.round((at - since) / 1000)}초`,
    });
  }

  return {
    record,
    openCollect,
    closeCollect,
    closeAll: () => { for (const tagId of [...openSince.keys()]) closeCollect(tagId); },
    dir,
  };
}

/**
 * 수집 세션을 프레임이 아니라 **세션 단위**로 남기기 위한 시계.
 *
 * 프레임마다 기록하면 초당 수십 줄이 쌓인다. 조문이 요구하는 것은 처리 사실이지
 * 프레임 단위 이력이 아니다. ingest가 들어올 때마다 여기를 두드리고, 조용해지면
 * 세션이 닫힌다.
 */
export function createCollectTracker(log: AuditLog, options: { idleMs?: number; now?: () => number } = {}) {
  const idleMs = options.idleMs ?? COLLECT_IDLE_MS;
  const now = options.now ?? Date.now;
  const lastSeen = new Map<string, number>();

  return {
    /** ingest 프레임 하나가 들어왔다. */
    touch(tagId: string): void {
      const at = now();
      // 다른 태그들이 조용해졌는지 같이 본다. 태그마다 타이머를 두지 않으려는 것이다.
      for (const [id, seen] of lastSeen) {
        if (id !== tagId && at - seen > idleMs) {
          lastSeen.delete(id);
          log.closeCollect(id);
        }
      }
      lastSeen.set(tagId, at);
      log.openCollect(tagId);
    },
    /** 전부 닫는다(종료·테스트용). */
    flush(): void {
      lastSeen.clear();
      log.closeAll();
    },
  };
}

function dayOf(at: number): string {
  const d = new Date(at);
  const p2 = (v: number): string => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}
