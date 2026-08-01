// 이벤트 레코드 파일 저장소(spec 03 §6.1, R-1). 이벤트 하나가 파일 하나다.
//
// DB를 두지 않는 이유: 레코드는 한 번 쓰고 안 고친다. R-2~R-4가 붙이는 첨부도 같은 파일을
// 다시 쓰는 것뿐이라 질의가 필요 없다. 파일이면 데모 중에 그냥 열어볼 수도 있다.

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { EventRecord } from './recorder.ts';

/** 목록 응답 한 줄. 궤적·가속도 배열은 빼고 세기만 준다 — 목록이 수 MB가 되면 못 쓴다. */
export interface EventSummary {
  eventId: string;
  tagId: string;
  ts: number;
  type: unknown;
  peakAccel: unknown;
  freefall: unknown;
  aiScore: unknown;
  zone: unknown;
  pos: unknown;
  trackCount: number;
  accelCount: number;
  attachmentCount: number;
}

export interface EventStore {
  save(record: EventRecord): void;
  read(eventId: string): EventRecord | null;
  list(limit?: number): EventSummary[];
  dir: string;
}

export const DEFAULT_EVENT_LIST_LIMIT = 100;

/**
 * eventId는 그대로 파일 이름이 된다. `..`이나 슬래시가 섞이면 저장소 밖을 가리키게 되므로
 * 여기서 막는다. 발급 형식은 `evt-<tagId>-<ts>-<seq>`이고(detection/fall.ts), tagId까지
 * 이 문자 집합 안에 있다.
 */
const SAFE_EVENT_ID = /^[A-Za-z0-9._-]{1,128}$/;

export function isValidEventId(eventId: unknown): eventId is string {
  return typeof eventId === 'string' && SAFE_EVENT_ID.test(eventId) && !eventId.includes('..');
}

export function createEventStore(dir: string): EventStore {
  function save(record: EventRecord): void {
    if (!isValidEventId(record.eventId)) {
      throw new Error(`파일 이름으로 쓸 수 없는 eventId: ${String(record.eventId)}`);
    }
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${record.eventId}.json`);
    // 임시 파일에 다 쓰고 나서 이름을 바꾼다. 쓰는 중에 목록 요청이 들어와도
    // 반쪽짜리 JSON을 읽는 일이 없다.
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    fs.renameSync(temp, file);
  }

  function read(eventId: string): EventRecord | null {
    if (!isValidEventId(eventId)) return null;
    return readFile(path.join(dir, `${eventId}.json`));
  }

  function list(limit: number = DEFAULT_EVENT_LIST_LIMIT): EventSummary[] {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return []; // 아직 이벤트가 한 건도 없다 — 폴더가 없는 게 정상이다
    }

    // 전부 열어보고 정렬하면 이벤트가 쌓일수록 목록이 느려진다. 파일 시각으로 먼저 추리고
    // 필요한 것만 파싱한다.
    const candidates = names
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        const file = path.join(dir, name);
        let mtimeMs = 0;
        try {
          mtimeMs = fs.statSync(file).mtimeMs;
        } catch {
          return null; // 읽는 사이에 지워졌다
        }
        return { file, mtimeMs };
      })
      .filter((entry): entry is { file: string; mtimeMs: number } => entry !== null)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, Math.max(0, limit));

    return candidates
      .map((entry) => readFile(entry.file))
      .filter((record): record is EventRecord => record !== null)
      .map(summarize)
      // 파일 시각이 아니라 사고 시각 기준으로 최신순. 둘은 대개 같지만 첨부가 붙어
      // 파일이 다시 써지면(R-4) 어긋난다.
      .sort((a, b) => b.ts - a.ts);
  }

  return { save, read, list, dir };
}

export function summarize(record: EventRecord): EventSummary {
  const alert = (record.alert ?? {}) as Record<string, unknown>;
  return {
    eventId: record.eventId,
    tagId: record.tagId,
    ts: record.ts,
    type: alert.type,
    peakAccel: alert.peakAccel,
    freefall: alert.freefall,
    aiScore: alert.aiScore,
    zone: alert.zone,
    pos: alert.pos,
    trackCount: record.track?.length ?? 0,
    accelCount: record.accel?.length ?? 0,
    attachmentCount: record.attachments?.length ?? 0,
  };
}

function readFile(file: string): EventRecord | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as EventRecord;
    return typeof parsed?.eventId === 'string' ? parsed : null;
  } catch {
    return null; // 깨진 파일 하나가 목록 전체를 못 쓰게 만들지 않는다
  }
}
