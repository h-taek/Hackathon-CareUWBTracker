// 현장 영상 업로드 수신(R-2). `POST /incidents/<eventId>/attachments`
//
// multipart를 쓰지 않는다. 본문은 파일 바이트 그대로이고 메타는 질의 문자열로 받는다.
// 영상이 수백 MB라 통째로 메모리에 올리면 안 되는데, 스트리밍 multipart 파서를 직접 쓰면
// 경계 처리에서 실수하기 쉽다. 바이트를 그대로 흘리면 파서가 아예 필요 없다.
//
//   POST /incidents/<eventId>/attachments?kind=video&capturedAt=<ms>&name=<파일명>
//        &scaleLabel=<기준물체>&scaleMm=<실측 mm>
//   Content-Type: video/mp4   (본문 = 파일 바이트)

import type { IncomingMessage } from 'node:http';

import { AttachmentError, isAttachmentKind, type Attachment, type AttachmentStore, type ReceiveMeta } from './attachments.ts';
import { isValidEventId } from './store.ts';

export interface UploadResult {
  status: number;
  body: unknown;
}

/** `/incidents/<eventId>/attachments`면 eventId를, 아니면 null. */
export function parseAttachmentPath(pathname: string): string | null {
  const match = /^\/incidents\/([^/]+)\/attachments\/?$/.exec(pathname);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1]; // %가 깨진 경로. 아래 isValidEventId가 막는다
  }
}

/**
 * `POST /incidents/<eventId>/attachments/<attachmentId>/recon`이면 둘을, 아니면 null.
 * 실패한 재구성을 다시 걸거나, 자동 착수를 꺼둔 자리에서 손수 거는 데 쓴다.
 */
export function parseReconTriggerPath(pathname: string): { eventId: string; attachmentId: string } | null {
  const match = /^\/incidents\/([^/]+)\/attachments\/([^/]+)\/recon\/?$/.exec(pathname);
  if (!match) return null;
  const decode = (segment: string) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  };
  return { eventId: decode(match[1]), attachmentId: decode(match[2]) };
}

/**
 * 질의 문자열 → 첨부 메타. 값이 이상하면 여기서 400을 던진다 —
 * 파일을 디스크에 다 받아놓고 나서 거절하면 그 바이트가 낭비된다.
 */
export function parseUploadMeta(params: URLSearchParams, contentType?: string): ReceiveMeta {
  const kind = params.get('kind') ?? 'video';
  if (!isAttachmentKind(kind)) {
    throw new AttachmentError(`kind는 video | photo | splat 중 하나여야 합니다: ${kind}`, 400);
  }

  const meta: ReceiveMeta = { kind };
  if (contentType) meta.contentType = contentType;

  const capturedAtRaw = params.get('capturedAt');
  if (capturedAtRaw !== null) {
    const capturedAt = Number(capturedAtRaw);
    if (!Number.isFinite(capturedAt) || capturedAt <= 0) {
      throw new AttachmentError(`capturedAt은 양의 에폭 ms여야 합니다: ${capturedAtRaw}`, 400);
    }
    meta.capturedAt = capturedAt;
  }

  const name = params.get('name');
  if (name) meta.originalName = name;

  // 기준물체는 라벨과 실측치가 **둘 다** 있어야 뜻이 있다. 하나만 오면 스케일을 못 잡는데
  // 레코드에는 뭔가 적혀 있어 나중에 믿게 된다.
  const scaleLabel = params.get('scaleLabel');
  const scaleMmRaw = params.get('scaleMm');
  if (scaleLabel || scaleMmRaw) {
    const measuredMm = Number(scaleMmRaw);
    if (!scaleLabel || !Number.isFinite(measuredMm) || measuredMm <= 0) {
      throw new AttachmentError('scaleLabel과 scaleMm(양수)은 함께 와야 합니다', 400);
    }
    meta.scaleRef = { label: scaleLabel, measuredMm };
  }

  return meta;
}

export async function handleAttachmentUpload(
  request: IncomingMessage,
  eventId: string,
  params: URLSearchParams,
  attachments: AttachmentStore,
  /** 저장이 끝난 뒤 부른다. 서버가 여기서 재구성을 대기열에 넣는다(R-3). */
  onAttached?: (attachment: Attachment) => void,
): Promise<UploadResult> {
  if (request.method !== 'POST') {
    return { status: 405, body: { ok: false, error: 'POST만 받습니다' } };
  }
  if (!isValidEventId(eventId)) {
    return { status: 400, body: { ok: false, error: `잘못된 eventId: ${eventId}` } };
  }

  try {
    const meta = parseUploadMeta(params, request.headers['content-type']);
    const attachment: Attachment = await attachments.receive(eventId, meta, request);
    // 응답은 저장까지만 책임진다. 재구성은 여기서 돌지 않고 대기열로 간다 —
    // 몇십 분짜리 작업이라 응답을 붙잡아 둘 수 없다(spec 03 §6.2).
    onAttached?.(attachment);
    return { status: 201, body: { ok: true, attachment } };
  } catch (error: unknown) {
    if (error instanceof AttachmentError) {
      return { status: error.statusCode, body: { ok: false, error: error.message } };
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[event] ${eventId} 첨부 수신 실패`, error);
    return { status: 500, body: { ok: false, error: message } };
  }
}
