// 첨부 파일 내려주기. `GET /events/<eventId>/attachments/<attachmentId>`
//
// 뷰어가 재구성 산출 `.ply`를 URL로 받아야 하고(R-5), 관제사가 원본 영상을 되받을 수도
// 있어야 한다. `server/data/`를 통째로 정적 서빙하지 않는 이유는 레코드 JSON까지 같이
// 열리기 때문이다 — 조회는 `/events/<id>`가 이미 담당한다.
//
// 경로는 레코드에 적힌 첨부만 따라간다. 요청 문자열로 파일 이름을 만들지 않는다.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { AttachmentStore } from './attachments.ts';
import { isValidEventId } from './store.ts';

export interface AttachmentTarget {
  eventId: string;
  attachmentId: string;
}

const CONTENT_TYPES: Record<string, string> = {
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  heic: 'image/heic',
  heif: 'image/heif',
  webp: 'image/webp',
  // 스플랫 3종은 표준 MIME이 없다. 뷰어는 확장자로 판별하므로 옥텟이면 충분하다.
  ply: 'application/octet-stream',
  splat: 'application/octet-stream',
  ksplat: 'application/octet-stream',
  spz: 'application/octet-stream',
};

/** `/events/<eventId>/attachments/<attachmentId>`면 둘을, 아니면 null. */
export function parseAttachmentFilePath(pathname: string): AttachmentTarget | null {
  const match = /^\/events\/([^/]+)\/attachments\/([^/]+)$/.exec(pathname);
  if (!match) return null;
  return { eventId: decodeSegment(match[1]), attachmentId: decodeSegment(match[2]) };
}

/** `/events/<eventId>/attachments/<attachmentId>/log`면 둘을, 아니면 null. */
export function parseReconLogPath(pathname: string): AttachmentTarget | null {
  const match = /^\/events\/([^/]+)\/attachments\/([^/]+)\/log\/?$/.exec(pathname);
  if (!match) return null;
  return { eventId: decodeSegment(match[1]), attachmentId: decodeSegment(match[2]) };
}

/** 로그 꼬리 몇 줄. COLMAP이 몇 분씩 조용해서, 화면이 "돌고는 있다"를 보이려면 이게 필요하다. */
export const DEFAULT_LOG_TAIL_LINES = 60;

export function readReconLogTail(
  eventsDir: string,
  target: AttachmentTarget,
  lines: number = DEFAULT_LOG_TAIL_LINES,
): string | null {
  if (!isValidEventId(target.eventId) || !isValidEventId(target.attachmentId)) return null;
  const file = path.join(eventsDir, target.eventId, 'recon', target.attachmentId, 'recon.log');
  try {
    // 로그가 수십 MB가 될 수 있다(OpenSplat이 10스텝마다 한 줄). 끝쪽만 읽는다.
    const size = fs.statSync(file).size;
    const window = Math.min(size, 256 * 1024);
    const handle = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(window);
      fs.readSync(handle, buffer, 0, window, size - window);
      const text = buffer.toString('utf8');
      return text.split('\n').slice(-Math.max(1, lines)).join('\n');
    } finally {
      fs.closeSync(handle);
    }
  } catch {
    return null; // 아직 안 돌았거나 지워졌다
  }
}

/** 처리했으면 true. 첨부가 없으면 false를 돌려 호출부가 404를 내게 한다. */
export function serveAttachment(
  request: IncomingMessage,
  response: ServerResponse,
  target: AttachmentTarget,
  attachments: AttachmentStore,
): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  if (!isValidEventId(target.eventId)) return false;

  const attachment = attachments.get(target.eventId, target.attachmentId);
  if (!attachment) return false;

  const file = attachments.absolutePathOf(attachment);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
    if (!stat.isFile()) return false;
  } catch {
    return false; // 레코드에는 있는데 파일이 사라졌다
  }

  const extension = attachment.path.split('.').pop()?.toLowerCase() ?? '';
  response.writeHead(200, {
    'Content-Type': CONTENT_TYPES[extension] ?? 'application/octet-stream',
    'Content-Length': String(stat.size),
    // 이름이 attachmentId라 원래 파일명을 여기서 돌려준다.
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(attachment.originalName ?? attachment.path)}`,
    'Cache-Control': 'no-cache',
  });

  if (request.method === 'HEAD') {
    response.end();
    return true;
  }

  const stream = fs.createReadStream(file);
  stream.on('error', () => response.destroy());
  stream.pipe(response);
  return true;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
