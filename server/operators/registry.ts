// 관제사 명부 — 확인자료의 `actor`가 가리키는 사람 목록(spec operation 03 §2).
//
// 태그 명부(`tags/registry.ts`)와 같은 장부지만 **모드로 나누지 않는다.** 시뮬이든
// 실기기든 화면 앞에 앉은 사람은 같은 사람이라, 나눌 이유가 없는 것을 나누면 한쪽만
// 갱신되는 자리가 생긴다.
//
// **삭제해도 파일에는 남는다.** 확인자료에 이미 `op-1`로 찍힌 줄이 있는데 항목을 실제로
// 지워 버리면 그 ID가 누구였는지 영영 확인할 수 없다. `removedAt`만 찍고 목록에서 내린다 —
// 이름 대조는 계속 된다. 태그 반납과 같은 방식이다.

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface OperatorEntry {
  /** `op-1`부터 서버가 매긴다. **이름을 ID로 쓰지 않는다** — 아래 nextId 참고. */
  operatorId: string;
  /** 선택창과 상단바에 띄우는 이름. */
  name: string;
  addedAt: number;
  addedBy: string;
  /** 삭제 시각. 있으면 목록에서 내려간다. 항목 자체는 파일에 남는다. */
  removedAt?: number;
  removedBy?: string;
}

export interface OperatorRegistry {
  /** 추가한다. 같은 이름이 이미 활성이면 `null`(고르는 사람이 구분 못 한다). */
  add(name: string, by: string): OperatorEntry | null;
  /** 명부에서 내린다. 없거나 이미 내려갔으면 `null`. */
  remove(operatorId: string, by: string): OperatorEntry | null;
  get(operatorId: string): OperatorEntry | null;
  /** 지금 고를 수 있는 사람인가. 세션 발급이 프레임마다 묻는다. */
  isActive(operatorId: string): boolean;
  /** 삭제분까지 전부. 파일 그대로다. */
  list(): OperatorEntry[];
  /** 삭제되지 않은 사람만. **관문 화면에 나가는 명부다.** */
  active(): OperatorEntry[];
  file: string;
}

/**
 * 명부가 비어 있을 때 깔아 두는 기본값.
 *
 * 제출본을 받은 사람이 아무 준비 없이 서버를 띄워도 관제 화면에 들어갈 수 있어야 한다.
 * 시설은 이 명부를 선택창에서 바로 고친다.
 */
export const DEFAULT_OPERATOR_NAMES = ['관제사 1', '관제사 2', '관제사 3'] as const;

const MAX_NAME = 20;

/** 이름 검증. 빈 값과 지나치게 긴 값만 막는다 — 형식을 강제할 근거가 없다. */
export function normalizeOperatorName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim();
  if (!name || name.length > MAX_NAME) return null;
  return name;
}

/** ID 검증. 서버가 매긴 형식만 받는다. */
export function isValidOperatorId(raw: unknown): raw is string {
  return typeof raw === 'string' && /^op-[1-9][0-9]{0,5}$/.test(raw);
}

export interface OperatorRegistryOptions {
  now?: () => number;
  fileName?: string;
  /** 비어 있을 때 깔 이름들. 테스트가 시드를 끄려면 빈 배열을 준다. */
  seed?: readonly string[];
}

export function createOperatorRegistry(
  dir: string,
  options: OperatorRegistryOptions = {},
): OperatorRegistry {
  const now = options.now ?? Date.now;
  const file = path.join(dir, options.fileName ?? 'operators.json');
  const entries = new Map<string, OperatorEntry>();

  load();
  if (entries.size === 0) {
    for (const name of options.seed ?? DEFAULT_OPERATOR_NAMES) addEntry(name, 'system');
    if (entries.size > 0) save();
  }

  function load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { operators?: OperatorEntry[] };
      for (const entry of raw.operators ?? []) {
        if (isValidOperatorId(entry?.operatorId) && typeof entry.name === 'string') {
          entries.set(entry.operatorId, entry);
        }
      }
    } catch {
      // 명부가 없으면 기본값으로 시작한다.
    }
  }

  function save(): void {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify({ operators: [...entries.values()] }, null, 2)}\n`, 'utf8');
    } catch (error: unknown) {
      // 명부를 못 써도 관제는 계속 돌아야 한다. 다만 조용히 넘어가면 재기동 때 삭제한
      // 항목이 되살아나므로 콘솔에는 남긴다.
      console.error('[operators] 명부 저장 실패', error);
    }
  }

  /**
   * 다음 번호. **파일에 있는 최대 번호 + 1이다** — 삭제한 항목의 번호를 재사용하면
   * 옛 확인자료의 `op-3`이 새 사람을 가리키게 된다.
   */
  function nextId(): string {
    let max = 0;
    for (const id of entries.keys()) max = Math.max(max, Number(id.slice(3)));
    return `op-${max + 1}`;
  }

  function addEntry(name: string, by: string): OperatorEntry {
    const entry: OperatorEntry = { operatorId: nextId(), name, addedAt: now(), addedBy: by };
    entries.set(entry.operatorId, entry);
    return entry;
  }

  return {
    add(name, by) {
      // 남아 있는 사람끼리만 막는다. 삭제한 사람과 같은 이름은 다시 들어올 수 있다 —
      // 실제로 새로 온 동명이인일 수 있고, ID가 다르므로 기록은 갈린다.
      for (const entry of entries.values()) {
        if (entry.removedAt == null && entry.name === name) return null;
      }
      const entry = addEntry(name, by);
      save();
      return entry;
    },
    remove(operatorId, by) {
      const entry = entries.get(operatorId);
      if (!entry || entry.removedAt != null) return null;
      entry.removedAt = now();
      entry.removedBy = by;
      save();
      return entry;
    },
    get: (operatorId) => entries.get(operatorId) ?? null,
    isActive(operatorId) {
      const entry = entries.get(operatorId);
      return !!entry && entry.removedAt == null;
    },
    list: () => [...entries.values()].sort((a, b) => a.addedAt - b.addedAt),
    active: () => [...entries.values()]
      .filter((e) => e.removedAt == null)
      .sort((a, b) => a.addedAt - b.addedAt),
    file,
  };
}
