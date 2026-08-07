// 사건 첨부에서 "지금 보여줄 것"을 고른다. 관제 화면(console.js)과 등록 화면(recon.js)이
// 같은 규칙을 써야 해서 여기 한 벌만 둔다.
//
// **`find`를 쓰지 않는다.** 첨부는 시간순으로 배열 뒤에 붙으므로 `find`는 언제나 가장
// 오래된 것을 준다. 같은 사건에 영상을 두 번 올려 3D를 두 번 뽑으면, 화면이 계속 첫
// 번째만 집어 **두 번째가 등록되지 않은 것처럼 보였다.** 기록에는 멀쩡히 들어 있었다.
//
// 브라우저 전용 코드지만 순수 함수뿐이라 node로도 그대로 검사한다(test/static/scene-pick).

/** 그 종류의 첨부 중 최신 하나. 없으면 null. */
export function latestOf(attachments, kind) {
  let best = null;
  for (const attachment of attachments ?? []) {
    if (!attachment || attachment.kind !== kind) continue;
    // `>=`라 시각이 같거나 없을 때는 **나중에 붙은 쪽**이 이긴다. uploadedAt이 없는
    // 옛 기록에서도 배열 순서가 곧 등록 순서라 이 규칙이 맞다.
    if (!best || (attachment.uploadedAt ?? 0) >= (best.uploadedAt ?? 0)) best = attachment;
  }
  return best;
}

/**
 * 화면 한 장이 쓸 세 가지.
 *
 * - `video`  최신 현장 영상. 진행 상태(변환 중·실패)를 읽는 자리다.
 * - `splat`  최신 3D 산출물.
 * - `source` 그 3D를 만든 영상. **성적(등록 장수·점 개수)은 여기서 읽어야 한다** —
 *            최신 영상과 3D를 낸 영상이 다를 수 있어, 최신 영상에서 읽으면 짝이 안 맞는
 *            숫자가 뜬다. 원본이 지워졌으면 null이다.
 */
export function pickScene(attachments) {
  const list = Array.isArray(attachments) ? attachments : [];
  const splat = latestOf(list, 'splat');
  const source = splat?.sourceAttachmentId
    ? list.find((a) => a?.attachmentId === splat.sourceAttachmentId) ?? null
    : null;
  return { video: latestOf(list, 'video'), splat, source };
}
