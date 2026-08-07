// attachments.js의 타입. 화면 코드는 브라우저가 그대로 받는 .js라 여기에만 타입을 둔다.
//
// 서버의 `Attachment`(server/events/attachments.ts)를 그대로 쓰지 않는다 — 화면은 서버가
// 준 JSON을 믿지 않고 있는 것만 골라 쓰므로, 여기서 요구하는 필드도 그만큼이어야 한다.

/** 화면이 첨부에서 실제로 읽는 것. 나머지 필드는 있어도 그만이다. */
export interface SceneAttachment {
  attachmentId?: string;
  kind?: string;
  uploadedAt?: number;
  sourceAttachmentId?: string;
  [key: string]: unknown;
}

export interface ScenePick<T> {
  /** 최신 현장 영상. 진행 상태(변환 중·실패)를 읽는 자리다. */
  video: T | null;
  /** 최신 3D 산출물. */
  splat: T | null;
  /** 그 3D를 만든 영상. 성적(등록 장수·점 개수)은 여기서 읽는다. */
  source: T | null;
}

export function latestOf<T extends SceneAttachment>(
  attachments: readonly T[] | null | undefined,
  kind: string,
): T | null;

export function pickScene<T extends SceneAttachment>(
  attachments: readonly T[] | null | undefined,
): ScenePick<T>;
