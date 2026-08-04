// 태그 명부 — 등록(배정)과 반납(해제). 개인위치정보 수집을 켜고 끄는 스위치다.
//
// **반납이 곧 수집 중단이다.** 위치정보법 제24조 제2항은 정보주체가 언제든 수집·이용·제공의
// 일시적인 중지를 요구할 수 있게 하고, 사업자는 거절할 수 없으며 **그 기술적 수단을 갖추도록**
// 요구한다. 거절 사유 규정이 없고, 수단 미비 자체가 제43조 제1항 제5호로 2천만원 이하
// 과태료다. 우리 서비스에서 그 수단이 이것이다 — 태그를 반납하면 서버가 그 태그의 프레임을
// 아예 처리하지 않는다(spec operation 02 §8).
//
// 명부에는 **화면에 띄울 표시명 하나만** 둔다. 개인정보보호법 제16조 제1항의 최소수집이고,
// "최소한이었다"는 입증책임이 우리에게 있다(같은 항 후단). 안 받아도 되는 건 안 받는 게 낫다.
//
// 파일 하나로 두는 이유는 이벤트 저장소와 같다 — 질의가 필요 없고, 데모 중에 그냥 열어본다.

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface TagEntry {
  tagId: string;
  /** 관제 화면에 띄우는 이름. 신원 항목이 아니라 표시용 문자열 하나다. */
  label: string;
  registeredAt: number;
  registeredBy: string;
  /** 반납 시각. 있으면 수집이 멈춘 상태다. */
  releasedAt?: number;
  releasedBy?: string;
}

export interface TagRegistry {
  /** 배정한다. 반납된 태그를 다시 등록하면 새 배정으로 덮어쓴다. */
  register(tagId: string, label: string, by: string): TagEntry;
  /** 반납한다. 이 순간부터 이 태그의 프레임은 처리되지 않는다. */
  release(tagId: string, by: string): TagEntry | null;
  /** 지금 수집해도 되는 태그인가. **ingest 진입점이 프레임마다 묻는다.** */
  isActive(tagId: string): boolean;
  get(tagId: string): TagEntry | null;
  /** 등록 순. 반납분까지 전부 준다 — 관리 화면이 이력을 보여준다. */
  list(): TagEntry[];
  /** 수집 중인 태그만. 관제 화면의 대상 명부다. */
  active(): TagEntry[];
  file: string;
}

export interface TagRegistryOptions {
  now?: () => number;
  /**
   * 장부 파일 이름. **시뮬과 실기기는 다른 장부를 쓴다**(server.ts에서 모드로 고른다).
   *
   * 한 파일을 같이 쓰면 시뮬로 띄울 때 자동 등록된 배경 태그가 파일에 남아, 다음에 실기기로
   * 띄워도 "수집 중" 세 명이 앉아 있다. 명부는 **지금 누구의 위치를 수집하고 있는가**를
   * 말하는 장부라 거짓말하면 안 된다 — 가짜 사람과 실제 대상자는 애초에 다른 장부다.
   */
  fileName?: string;
}

const MAX_LABEL = 40;

/** 표시명 검증. 빈 값과 지나치게 긴 값만 막는다 — 형식을 강제할 근거가 없다. */
export function normalizeLabel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const label = raw.trim();
  if (!label || label.length > MAX_LABEL) return null;
  return label;
}

/** 태그 ID 검증. 경로로 쓰이지는 않지만 파일에 들어가므로 좁게 잡는다. */
export function isValidTagId(raw: unknown): raw is string {
  return typeof raw === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(raw);
}

export function createTagRegistry(dir: string, options: TagRegistryOptions = {}): TagRegistry {
  const now = options.now ?? Date.now;
  const file = path.join(dir, options.fileName ?? 'registry.json');
  const entries = new Map<string, TagEntry>();

  load();

  function load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { tags?: TagEntry[] };
      for (const entry of raw.tags ?? []) {
        if (isValidTagId(entry?.tagId)) entries.set(entry.tagId, entry);
      }
    } catch {
      // 명부가 없으면 빈 상태로 시작한다. 첫 등록 때 파일이 생긴다.
    }
  }

  function save(): void {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify({ tags: [...entries.values()] }, null, 2)}\n`, 'utf8');
    } catch (error: unknown) {
      // 명부를 못 써도 관제는 계속 돌아야 한다. 다만 조용히 넘어가면 재기동 때
      // 반납한 태그가 되살아나므로 콘솔에는 남긴다.
      console.error('[tags] 명부 저장 실패', error);
    }
  }

  return {
    register(tagId, label, by) {
      const entry: TagEntry = { tagId, label, registeredAt: now(), registeredBy: by };
      entries.set(tagId, entry);
      save();
      return entry;
    },
    release(tagId, by) {
      const entry = entries.get(tagId);
      if (!entry || entry.releasedAt != null) return null;
      entry.releasedAt = now();
      entry.releasedBy = by;
      save();
      return entry;
    },
    isActive(tagId) {
      const entry = entries.get(tagId);
      return !!entry && entry.releasedAt == null;
    },
    get: (tagId) => entries.get(tagId) ?? null,
    list: () => [...entries.values()].sort((a, b) => a.registeredAt - b.registeredAt),
    active: () => [...entries.values()]
      .filter((e) => e.releasedAt == null)
      .sort((a, b) => a.registeredAt - b.registeredAt),
    file,
  };
}
