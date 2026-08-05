// 사고 현장 3D 기록 화면(/recon) 동작.
//
// 이 화면이 하는 일은 둘뿐이다 — **어느 사고에 붙일지 정하고, 영상을 올려 변환을 건다.**
// 사고 목록·상세·3D 뷰어는 관제 화면의 '사고 현장 3D' 탭에 있다. 같은 목록을 두 곳에
// 두면 어느 쪽이 최신인지 알 수 없어지고, 1.4MB짜리 뷰어 라이브러리가 등록만 하러 온
// 화면에도 딸려온다.
//
// 흐름: 붙일 사고 확정 → 영상 고르기 → 설정 → 업로드(= 재구성 착수) → 폴링으로 진행 표시.
//
// 실제 전송은 마지막 버튼 한 번이다. 화면에서는 영상을 먼저 고르지만 수백 MB를 보내는 건
// 사고와 설정이 정해진 뒤다 — 먼저 올려두려면 임시 보관소가 필요한데 그럴 이유가 없다.
//
// 진행은 SSE가 아니라 폴링이다. 재구성이 몇 분짜리라 실시간 스트림에 얹을 이유가 없고,
// 관제(/stream)와 섞이면 안 된다.
//
// **영상 등록도 사건 기록을 바꾸는 조작이라 관제사 세션이 있어야 한다**(spec operation 03).
// 서버도 같이 막는다 — 화면에서만 막으면 주소로 직접 올릴 수 있다.

import { initOperatorGate, requireOperator, guard } from './operator.js';

const $ = (id) => document.getElementById(id);

/** 파이프라인 단계. 서버 recon.step 이름과 짝이 맞아야 한다(server/events/recon/steps.ts). */
const STEPS = [
  { key: 'upload', label: '영상 업로드', what: '영상 파일을 서버로 보낸다' },
  { key: 'frames', label: '프레임 추출', what: '영상을 사진 여러 장으로 고르게 자른다' },
  { key: 'colmap:extract', label: '특징 추출', what: '사진마다 알아볼 수 있는 점을 찾는다' },
  { key: 'colmap:match', label: '프레임 매칭', what: '사진끼리 같은 점을 짝짓는다' },
  { key: 'colmap:map', label: '자세 계산', what: '촬영자가 어디서 찍었는지를 역산한다' },
  { key: 'opensplat', label: '3DGS 학습', what: '그 위치들에서 본 모습이 되도록 3D를 맞춰간다' },
];

const state = {
  file: null,
  /** 붙일 사고. `fixed`면 관제에서 지정해 온 것이라 화면에서 못 바꾼다. */
  eventId: null,
  fixed: false,
  /** 지금 보고 있는 재구성 { eventId, attachmentId } — attachmentId는 **영상** 쪽이다. */
  watching: null,
  /** 끝난 뒤 `다시 변환`이 쓸 마지막 대상. watching은 끝나면 비운다. */
  last: null,
  timer: null,
  /** 전송 중인 업로드의 중지 손잡이. 변환이 아니라 **전송**을 끊는다. */
  upload: null,
};

/** 더 볼 것이 없는 상태들. 폴링을 여기서 멈춘다. */
const SETTLED = ['done', 'failed', 'cancelled'];

/** 태그 이름표. 사고 기록에는 태그 ID만 있어 명부에서 이름을 끌어와야 한다. */
const roster = new Map();
/** 층 이름. 사고 기록의 floor는 `F2` 같은 식별자뿐이다. */
const floors = new Map();

// ── 유틸 ──
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
const clock = (ts) => {
  const d = new Date(ts);
  const p = (v) => String(v).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};
const nameOf = (tagId) => roster.get(tagId) || tagId;
const whereOf = (floor, zone) => [floors.get(floor) || floor, zone || '구역 미지정'].filter(Boolean).join(' — ');

/** 초를 사람이 읽는 길이로. 15분짜리 작업에 `761초`는 안 읽힌다. */
const span = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}초` : `${Math.floor(s / 60)}분 ${String(s % 60).padStart(2, '0')}초`;
};

async function getJson(path) {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}

// ── 1. 붙일 사고 ──
//
// 관제 화면의 `영상 등록`은 `/recon/?incident=<사고id>`로 이 화면을 연다. 그때는 그 사고에
// **고정한다** — 고를 수 있게 두면 3번째 사고를 등록하러 들어와 첫 사고에 붙는다.

async function loadNames() {
  const [tags, map] = await Promise.all([
    getJson('/tags').catch(() => []),
    getJson('/map').catch(() => null),
  ]);
  for (const tag of tags) roster.set(tag.id, tag.name);
  for (const floor of map?.floors ?? []) floors.set(floor.id, floor.name);
}

/** 레코드 전문에서 화면이 쓸 것만 뽑는다. 목록 요약과 필드 이름이 다르다(전문은 alert 밑에 있다). */
function factsOf(record) {
  const alert = record.alert ?? {};
  const attachments = record.attachments ?? [];
  return {
    eventId: record.eventId,
    tagId: record.tagId,
    ts: record.ts,
    floor: alert.floor,
    zone: alert.zone,
    peakAccel: alert.peakAccel,
    trackCount: record.track?.length ?? 0,
    video: attachments.find((a) => a.kind === 'video') ?? null,
    splat: attachments.find((a) => a.kind === 'splat') ?? null,
  };
}

async function showFixed(eventId) {
  let record = null;
  try {
    record = await getJson(`/incidents/${encodeURIComponent(eventId)}`);
  } catch {
    // 주소에 실려 온 사고가 없다(지워졌거나 오래된 주소다). 목록으로 떨어뜨린다.
    $('incidentHint').textContent = '주소의 사고를 못 찾았다';
    $('incidentHint').className = 'panel-hint is-bad';
    state.fixed = false;
    state.eventId = null;
    await showPicker('주소에 실린 사고를 못 찾았다. 아래에서 고른다.');
    return;
  }

  const f = factsOf(record);
  state.eventId = f.eventId;
  state.fixed = true;

  $('incName').textContent = `${nameOf(f.tagId)} · ${clock(f.ts)}`;
  $('incWhere').textContent = whereOf(f.floor, f.zone);

  const box = $('incFacts');
  box.innerHTML = '';
  const fact = (k, v) => {
    const cell = el('div');
    cell.append(el('div', 'fact-k', k));
    cell.append(el('div', 'fact-v', v));
    box.append(cell);
  };
  fact('태그', f.tagId);
  fact('충격', f.peakAccel != null ? `${Number(f.peakAccel).toFixed(1)} g` : '—');
  fact('궤적', `${f.trackCount} 점`);
  fact('첨부', f.splat ? '영상 · 3D' : f.video ? '영상만' : '없음');

  $('incidentHint').textContent = '관제 화면에서 지정';
  $('incidentHint').className = 'panel-hint';
  $('incidentLoading').hidden = true;
  $('incidentPick').hidden = true;
  $('incidentFixed').hidden = false;
  updateGo();
}

async function showPicker(reason, keep = null) {
  let incidents = [];
  try {
    incidents = (await getJson('/incidents?limit=100')).incidents;
  } catch {
    $('incidentLoading').textContent = '사고를 못 불러왔다. 서버가 떠 있는지 본다.';
    return;
  }

  const select = $('incidentSelect');
  select.innerHTML = '';
  // **아무것도 미리 고르지 않는다.** 기본 선택이 있으면 안 고른 채로 눌러 엉뚱한 사고에 붙는다.
  select.append(el('option', null, '— 사고를 고른다 —'));
  for (const e of incidents) {
    const option = el('option', null,
      `${nameOf(e.tagId)} · ${clock(e.ts)} · ${e.zone || '구역 미지정'}`
      + ` · ${e.hasSplat ? '3D 있음' : e.attachmentCount ? '영상만' : '첨부 없음'}`);
    option.value = e.eventId;
    select.append(option);
  }
  // 다시 그릴 때(변환이 끝나 첨부 표기가 바뀐 때) 고른 것을 잃지 않는다.
  if (keep) select.value = keep;
  state.eventId = select.value || null;
  select.onchange = () => { state.eventId = select.value || null; updateGo(); };

  $('incidentCount').textContent = `확인된 사고 ${incidents.length}건`;
  if (reason) $('pickNote').textContent = reason;
  $('incidentHint').textContent = '주소로 직접 열었다';
  $('incidentLoading').hidden = true;
  $('incidentFixed').hidden = true;
  $('incidentPick').hidden = false;
  updateGo();
}

// ── 2. 현장 영상 ──

function setFile(file) {
  state.file = file || null;
  // 드롭 영역은 고른 뒤에도 남는다. 그 자리가 곧 다시 고르는 자리라 `바꾸기`가 따로 없다.
  $('filePicked').hidden = !file;
  if (!file) return updateGo();

  $('fileName').textContent = file.name;
  const meta = $('fileMeta');
  meta.textContent = `${mb(file.size)} · 읽는 중…`;
  // 해상도·길이는 브라우저가 메타데이터만 읽어 채운다. 파일은 아직 안 보낸다.
  const probe = document.createElement('video');
  probe.preload = 'metadata';
  probe.onloadedmetadata = () => {
    meta.textContent = `${mb(file.size)} · ${probe.videoWidth}×${probe.videoHeight} · ${Math.round(probe.duration)}초`;
    URL.revokeObjectURL(probe.src);
  };
  probe.onerror = () => { meta.textContent = `${mb(file.size)} · 브라우저가 못 읽는 코덱(변환은 서버가 한다)`; };
  probe.src = URL.createObjectURL(file);
  updateGo();
}

function bindFilePicker() {
  const input = $('file');
  $('pick').onclick = () => input.click();
  input.onchange = () => setFile(input.files[0] || null);

  // 끌어다 놓기. 영역 밖에 떨어뜨렸을 때 브라우저가 그 영상을 **탭에 열어버리는** 것도
  // 같이 막는다 — 업로드 중이었다면 화면째 날아간다.
  const drop = $('drop');
  const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
  for (const type of ['dragenter', 'dragover']) {
    drop.addEventListener(type, (e) => { stop(e); drop.classList.add('is-over'); });
  }
  for (const type of ['dragleave', 'drop']) {
    drop.addEventListener(type, (e) => { stop(e); drop.classList.remove('is-over'); });
  }
  drop.addEventListener('drop', (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (file) setFile(file);
  });
  for (const type of ['dragover', 'drop']) window.addEventListener(type, (e) => e.preventDefault());
}

// ── 3. 설정 → 업로드 ──

function tuningQuery() {
  const params = new URLSearchParams({ kind: 'video' });
  for (const [id, key] of [['frames', 'frames'], ['frameWidth', 'frameWidth'], ['iters', 'iters']]) {
    const value = $(id).value.trim();
    if (value !== '') params.set(key, value);
  }
  params.set('gpu', $('gpu').checked ? '1' : '0');
  // 라벨과 실측치는 둘 다 있을 때만 보낸다 — 하나만 가면 서버가 400으로 막는다.
  const label = $('scaleLabel').value.trim();
  const mm = $('scaleMm').value.trim();
  if (label && mm) { params.set('scaleLabel', label); params.set('scaleMm', mm); }
  // 파일 이름은 URLSearchParams가 알아서 퍼센트 인코딩한다. 한글 파일명을 날것으로 붙이면
  // Node의 HTTP 파서가 요청 줄에서 거부해 본문 없는 400이 된다.
  if (state.file) params.set('name', state.file.name);
  return params;
}

function updateGo() {
  const go = $('go');
  const busy = go.dataset.busy === '1';

  go.disabled = !(state.file && state.eventId) || busy;
  go.textContent = busy ? '업로드 중…'
    : !state.eventId ? '붙일 사고를 고른다'
      : !state.file ? '영상을 먼저 고른다'
        : '업로드하고 변환 시작';
}

async function startUpload() {
  // 세션이 끊긴 채 수백 MB를 보내고 401을 받으면, 그 시간이 통째로 버려진다.
  if (!requireOperator()) return;
  const go = $('go');
  go.dataset.busy = '1';
  updateGo();
  state.upload = new AbortController();
  setSteps({ status: 'running', step: 'upload' });
  $('progressHint').textContent = `${mb(state.file.size)} 전송 중…`;

  try {
    const res = guard(await fetch(`/incidents/${encodeURIComponent(state.eventId)}/attachments?${tuningQuery()}`, {
      method: 'POST',
      headers: { 'Content-Type': state.file.type || 'application/octet-stream' },
      body: state.file,
      signal: state.upload.signal,
    }));
    const body = await res.json();
    if (!res.ok || !body.ok) throw new Error(body.error || `HTTP ${res.status}`);
    state.watching = { eventId: state.eventId, attachmentId: body.attachment.attachmentId };
    state.last = state.watching;
    poll();
  } catch (error) {
    // 중지로 끊은 전송은 실패가 아니다. 서버에는 반쪽짜리 첨부도 남지 않는다.
    const ended = error.name === 'AbortError'
      ? { status: 'cancelled', step: 'upload' }
      : { status: 'failed', step: 'upload', error: String(error.message || error) };
    setSteps(ended);
    showResult(ended, null);
  } finally {
    state.upload = null;
    go.dataset.busy = '0';
    updateGo();
  }
}

/**
 * 중지. 무엇을 끊는지는 지금 무엇이 도는지가 정한다 — 전송 중이면 전송을, 변환 중이면
 * 서버가 띄운 도구를 끊는다. **화면에서 폴링만 멈추지 않는다** — 그러면 화면에서만
 * 멈춘 것처럼 보이고 GPU는 계속 돈다.
 */
async function stopNow() {
  if (state.upload) {
    state.upload.abort();
    return;
  }
  if (!state.watching || !requireOperator()) return;
  const { eventId, attachmentId } = state.watching;
  $('stop').disabled = true;
  try {
    const res = guard(await fetch(
      `/incidents/${encodeURIComponent(eventId)}/attachments/${encodeURIComponent(attachmentId)}/recon`,
      { method: 'DELETE' },
    ));
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    // 끊긴 도구가 레코드에 `cancelled`로 적히기까지 한 박자 걸린다. 폴링이 그걸 가져온다.
    poll();
  } catch (error) {
    $('progressHint').textContent = `중지하지 못했다 — ${error.message || error}`;
    $('progressHint').className = 'panel-hint is-bad';
  } finally {
    $('stop').disabled = false;
  }
}

async function retryRecon() {
  if (!state.last || !requireOperator()) return;
  const { eventId, attachmentId } = state.last;
  const params = tuningQuery();
  params.delete('kind');
  params.delete('name');
  try {
    const res = guard(await fetch(
      `/incidents/${encodeURIComponent(eventId)}/attachments/${encodeURIComponent(attachmentId)}/recon?${params}`,
      { method: 'POST' },
    ));
    const body = await res.json();
    if (!body.ok) throw new Error(body.error);
    state.watching = { eventId, attachmentId };
    $('log').textContent = '';
    poll();
    $('progress').scrollIntoView({ behavior: 'smooth', block: 'center' });
  } catch (error) {
    setSteps({ status: 'failed', step: 'frames', error: String(error.message || error) });
  }
}

// ── 4. 진행 ──

function setSteps(recon) {
  const list = $('steps');
  list.innerHTML = '';
  list.hidden = !recon;
  $('logWrap').hidden = !recon;
  if (!recon) {
    $('progressHint').textContent = '';
    $('progressHint').className = 'panel-hint';
    $('stop').hidden = true;
    return;
  }

  const current = recon.step ?? null;
  const failed = recon.status === 'failed';
  const done = recon.status === 'done';
  const halted = recon.status === 'cancelled';
  const at = STEPS.findIndex((s) => s.key === current);
  // 도는 동안에만 중지가 있다. 끝난 뒤에 남아 있으면 뭘 끊는다는 것인지 알 수 없다.
  $('stop').hidden = done || failed || halted;

  for (const [index, step] of STEPS.entries()) {
    const passed = done || (at >= 0 && index < at);
    const running = !done && !failed && !halted && index === at;
    const broke = failed && index === at;
    const cut = halted && index === at;
    const li = el('li', broke ? 'is-bad' : cut ? 'is-cut' : passed ? 'is-done' : running ? 'is-run' : '');
    li.append(el('span', 'mk', broke ? '×' : cut ? '■' : passed ? '✓' : running ? '●' : '○'));
    li.append(el('span', 's-name', `${index + 1}/${STEPS.length} ${step.label}`));
    li.append(el('span', 's-d', running ? runningDetail(recon) : detailFor(step.key, recon)));
    li.append(el('span', 's-what', step.what));
    // 지금 도는 단계에만 막대를 붙인다. 전체 %로 합치지 않는 이유는 단계별 소요가
    // 입력에 따라 뒤집혀(학습 30000회 vs 프레임 500장) 없는 가중치를 지어내게 되기 때문이다.
    if (running && recon.progress) {
      const bar = el('div', 'bar');
      const fill = el('div', 'fill');
      const pct = recon.progress.percent;
      if (pct == null) fill.classList.add('is-unknown');
      else fill.style.width = `${pct}%`;
      bar.append(fill);
      li.append(bar);
    }
    list.append(li);
  }

  // 상태 낱말을 앞에 박는다. 사유만 있으면 성공인지 실패인지가 한눈에 안 들어온다.
  // 번호는 **화면 기준**으로만 센다. 서버의 stepIndex는 도구 5단계 기준이라 화면의
  // 6단계(업로드 포함)와 어긋난다 — 섞으면 3/6인지 4/6인지 알 수 없어진다.
  const shown = at >= 0 ? at + 1 : 0;
  $('progressHint').textContent = failed ? `실패 — ${recon.error ?? '원인 불명'}`
    : halted ? '중지됨'
      : done ? '완료'
        : recon.status === 'running' && shown ? `${shown}/${STEPS.length} 단계 진행 중…`
          : recon.status === 'running' ? '진행 중…'
            : recon.status === 'pending' ? '대기 중…' : '';
  $('progressHint').className = `panel-hint${failed ? ' is-bad' : ''}`;
}

/** 지금 도는 단계의 오른쪽 숫자. 막대는 근사여도 이 값은 도구가 준 그대로다. */
function runningDetail(recon) {
  const p = recon.progress;
  if (!p) return '…';
  return p.percent == null ? p.label : `${p.label} · ${p.percent}%`;
}

function detailFor(key, recon) {
  if (key === 'frames' && recon.frames) return `${recon.frames}장`;
  if (key === 'colmap:map' && recon.registeredImages != null) {
    return `등록 ${recon.registeredImages}장 · 점 ${(recon.points ?? 0).toLocaleString()}`;
  }
  if (key === 'opensplat' && recon.tuning?.numIters) return `${recon.tuning.numIters}회`;
  if (key === 'colmap:extract' && recon.tuning?.useGpu != null) return recon.tuning.useGpu ? 'GPU' : 'CPU';
  return '';
}

const stepLabel = (key) => STEPS.find((s) => s.key === key)?.label ?? '';

/**
 * 끝난 뒤의 한 줄. **여기서 3D를 띄우지 않는다** — 보는 자리는 관제 화면의 3D 탭이고,
 * 그 탭이 사고를 골라 여는 길(`/?scene=`)을 갖고 있다.
 */
function showResult(recon, record) {
  const box = $('resultBox');
  box.innerHTML = '';
  const done = recon?.status === 'done';
  const failed = recon?.status === 'failed';
  const halted = recon?.status === 'cancelled';
  box.hidden = !(done || failed || halted);
  if (!done && !failed && !halted) return;

  const row = el('div', `result ${done ? 'is-ok' : failed ? 'is-bad' : 'is-cut'}`);
  const ico = el('span', 'result-ico');
  ico.innerHTML = done
    ? '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="m8.5 12.5 2.5 2.5 4.5-5"></path></svg>'
    : failed
      ? '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="M12 8v5M12 16h.01"></path></svg>'
      : '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><rect x="9" y="9" width="6" height="6"></rect></svg>';

  const main = el('div');
  main.append(el('div', 'result-main',
    done ? '3D 현장이 이 사고에 붙었다'
      : halted ? '변환을 중지했다'
        : '변환이 끝나지 못했다'));

  const splat = (record?.attachments ?? []).find((a) => a.attachmentId === recon.outputAttachmentId);
  const took = recon.startedAt && recon.finishedAt ? span(recon.finishedAt - recon.startedAt) : null;
  main.append(el('div', 'result-sub', done
    ? [
      `등록 ${recon.registeredImages ?? '?'}/${recon.frames ?? '?'}장`,
      `점 ${(recon.points ?? 0).toLocaleString()}`,
      splat ? mb(splat.bytes) : null,
      took,
    ].filter(Boolean).join(' · ')
    // 중지는 원인을 적을 것이 없다. 어디서 끊겼는지와 그때까지 쓴 시간만 남긴다.
    : halted
      ? [stepLabel(recon.step), took ? `${took} 지점` : null].filter(Boolean).join(' · ') || '영상 등록 전'
      : recon.error ?? '원인 불명'));

  const acts = el('div', 'result-acts');
  if (done) {
    const open = el('button', 'act act-sm act-primary', '관제에서 3D 보기');
    open.type = 'button';
    const target = record?.eventId ?? state.last?.eventId ?? state.eventId ?? '';
    open.onclick = () => window.open(`/?scene=${encodeURIComponent(target)}`, '_blank', 'noopener');
    acts.append(open);
  }
  // 전송이 끊긴 건에는 다시 걸 첨부가 없다. 그때는 위에서 다시 올리는 게 유일한 길이라
  // 버튼을 만들지 않는다 — 눌러도 아무 일 없는 버튼이 제일 나쁘다.
  if (state.last) {
    const again = el('button', `act act-sm${done ? '' : ' act-primary'}`, '다시 변환');
    again.type = 'button';
    again.onclick = retryRecon;
    acts.append(again);
  }

  row.append(ico, main, el('span', 'spacer'), acts);
  box.append(row);
}

async function poll() {
  clearTimeout(state.timer);
  if (!state.watching) return;
  const { eventId, attachmentId } = state.watching;
  let record = null;
  let recon = null;
  try {
    record = await getJson(`/incidents/${encodeURIComponent(eventId)}`);
    recon = (record.attachments || []).find((a) => a.attachmentId === attachmentId)?.recon ?? null;
  } catch { /* 서버가 잠깐 안 받으면 다음 차례에 다시 본다 */ }

  setSteps(recon);
  showResult(recon, record);
  rememberWatching();
  await refreshLog();

  if (recon && SETTLED.includes(recon.status)) {
    state.watching = null;
    rememberWatching();
    // 첨부가 늘었으니 사고 카드(또는 목록의 `첨부 없음` 표기)도 같이 맞춘다.
    if (state.fixed) await showFixed(eventId);
    else await showPicker(null, state.eventId);
    return;
  }
  state.timer = setTimeout(poll, 3000);
}

async function refreshLog() {
  if (!state.last) return;
  const { eventId, attachmentId } = state.last;
  try {
    // 로그는 첫 단계가 뭔가 쓰기 전까지 없다. 404는 정상이라 조용히 넘긴다.
    const res = await fetch(
      `/incidents/${encodeURIComponent(eventId)}/attachments/${encodeURIComponent(attachmentId)}/log?tail=60`,
      { cache: 'no-store' },
    );
    if (!res.ok) return;
    const box = $('log');
    box.textContent = await res.text();
    box.scrollTop = box.scrollHeight;
  } catch { /* 로그는 있으면 좋은 것뿐이다 */ }
}

// ── 시작 ──
//
// 보고 있던 재구성을 주소에 남긴다. 15분짜리 작업 중에 새로고침하거나 창을 닫으면 진행
// 화면을 통째로 잃는데, 주소만 있으면 다시 붙는다.

function rememberWatching() {
  const url = new URL(location.href);
  if (state.watching) {
    url.searchParams.set('watch', `${state.watching.eventId}/${state.watching.attachmentId}`);
  } else {
    url.searchParams.delete('watch');
  }
  history.replaceState(null, '', url);
}

function parseWatch(raw) {
  if (!raw) return null;
  const slash = raw.lastIndexOf('/');
  if (slash <= 0) return null;
  return { eventId: raw.slice(0, slash), attachmentId: raw.slice(slash + 1) };
}

async function start() {
  // 세션이 없으면 이 호출이 화면을 관문(/operator)으로 넘긴다.
  initOperatorGate();
  bindFilePicker();
  $('go').onclick = startUpload;
  $('stop').onclick = stopNow;
  setSteps(null);

  const params = new URL(location.href).searchParams;
  const watching = parseWatch(params.get('watch'));
  // 보고 있던 재구성이 있으면 그 사고가 곧 붙일 사고다. 두 주소가 어긋날 일은 없다.
  const fixedId = params.get('incident') || watching?.eventId || null;

  await loadNames();
  if (fixedId) await showFixed(fixedId);
  else await showPicker(null);

  if (watching) {
    state.watching = watching;
    state.last = watching;
    poll();
  }
}

start();
