// 사고 현장 3D 기록 페이지(/recon) 동작.
//
// 흐름: 영상 고르기 → 낙상 기록 고르기 → 설정 → 업로드(= 재구성 착수) → 폴링으로 진행 표시.
//
// 실제 전송은 마지막 버튼 한 번이다. 화면에서는 영상을 먼저 고르지만 수백 MB를 보내는 건
// 이벤트와 설정이 정해진 뒤다 — 먼저 올려두려면 임시 보관소가 필요한데 그럴 이유가 없다.
//
// 진행은 SSE가 아니라 폴링이다. 재구성이 몇 분짜리라 실시간 스트림에 얹을 이유가 없고,
// 관제(/stream)와 섞이면 안 된다.

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
  eventId: null,
  events: [],
  /** 지금 보고 있는 재구성 { eventId, attachmentId } */
  watching: null,
  timer: null,
  viewer: null,
  viewerLoading: null,
};

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

async function getJson(path) {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
}

// ── 1. 영상 ──
function bindFilePicker() {
  const input = $('file');
  $('pick').onclick = () => input.click();
  input.onchange = () => {
    const file = input.files[0];
    state.file = file || null;
    const meta = $('filemeta');
    meta.innerHTML = '';
    if (!file) {
      meta.append(el('span', null, '선택된 영상이 없다'));
      return updateGo();
    }
    meta.append(el('b', null, file.name));
    // 해상도·길이는 브라우저가 메타데이터만 읽어 채운다. 파일은 아직 안 보낸다.
    const line = el('span', null, `${mb(file.size)} · 읽는 중…`);
    meta.append(line);
    const probe = document.createElement('video');
    probe.preload = 'metadata';
    probe.onloadedmetadata = () => {
      line.textContent = `${mb(file.size)} · ${probe.videoWidth}×${probe.videoHeight} · ${Math.round(probe.duration)}초`;
      URL.revokeObjectURL(probe.src);
    };
    probe.onerror = () => { line.textContent = `${mb(file.size)} · 브라우저가 못 읽는 코덱(변환은 서버가 한다)`; };
    probe.src = URL.createObjectURL(file);
    updateGo();
  };
}

// ── 2. 낙상 기록 ──
async function loadEvents() {
  const list = $('events');
  list.innerHTML = '';
  let events = [];
  try {
    events = (await getJson('/events?limit=100')).events;
  } catch {
    list.append(el('div', 'empty', '이벤트를 못 불러왔다'));
    return;
  }
  state.events = events;
  $('eventCount').textContent = `${events.length}건`;

  if (!events.length) {
    list.append(el('div', 'empty', '낙상 기록이 없다. 관제 화면에서 클립을 주입해 하나 만든다'));
    return updateGo();
  }

  for (const [index, event] of events.entries()) {
    const row = el('label', 'evt');
    const radio = el('input');
    radio.type = 'radio';
    radio.name = 'evt';
    radio.value = event.eventId;
    if (index === 0) { radio.checked = true; state.eventId = event.eventId; }
    radio.onchange = () => {
      state.eventId = event.eventId;
      for (const other of list.querySelectorAll('.evt')) other.classList.remove('sel');
      row.classList.add('sel');
      updateGo();
    };

    const main = el('div', 'evtmain');
    const head = el('div');
    head.append(el('b', null, clock(event.ts)));
    head.append(el('span', 'tag', event.tagId));
    head.append(el('span', 'zone', event.zone ?? '미지정'));
    main.append(head);
    main.append(el('div', 'sub',
      `${event.peakAccel}g · ${event.freefall ? '자유낙하' : '충격만'}`
      + ` · AI ${event.aiScore != null ? Number(event.aiScore).toFixed(2) : '-'}`
      + ` · 궤적 ${event.trackCount}점`));

    const has3d = event.attachmentCount > 0;
    const badge = el('span', `badge ${has3d ? 'ok' : 'warn'}`, has3d ? `첨부 ${event.attachmentCount}` : '첨부 없음');

    row.append(radio, main, badge);
    if (index === 0) row.classList.add('sel');
    list.append(row);
  }
  updateGo();
}

// ── 3. 설정 → 업로드 ──
function tuningQuery() {
  const params = new URLSearchParams({ kind: 'video' });
  for (const [id, key] of [['frames', 'frames'], ['frameWidth', 'frameWidth'], ['iters', 'iters']]) {
    const value = $(id).value.trim();
    if (value !== '') params.set(key, value);
  }
  // 라벨과 실측치는 둘 다 있을 때만 보낸다 — 하나만 가면 서버가 400으로 막는다.
  params.set('gpu', $('gpu').checked ? '1' : '0');
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
  const ready = Boolean(state.file && state.eventId);
  go.disabled = !ready || go.dataset.busy === '1';
  go.textContent = go.dataset.busy === '1' ? '업로드 중…'
    : !state.file ? '영상을 먼저 고른다'
      : !state.eventId ? '낙상 기록을 고른다'
        : '업로드하고 변환 시작';
}

async function startUpload() {
  const go = $('go');
  go.dataset.busy = '1';
  updateGo();
  setSteps({ status: 'running', step: 'upload' });
  $('progressHint').textContent = `${mb(state.file.size)} 전송 중…`;

  try {
    const res = await fetch(`/events/${encodeURIComponent(state.eventId)}/attachments?${tuningQuery()}`, {
      method: 'POST',
      headers: { 'Content-Type': state.file.type || 'application/octet-stream' },
      body: state.file,
    });
    const body = await res.json();
    if (!res.ok || !body.ok) throw new Error(body.error || `HTTP ${res.status}`);
    state.watching = { eventId: state.eventId, attachmentId: body.attachment.attachmentId };
    poll();
  } catch (error) {
    setSteps({ status: 'failed', step: 'upload', error: String(error.message || error) });
  } finally {
    go.dataset.busy = '0';
    updateGo();
  }
}

// ── 진행 폴링 ──
function setSteps(recon) {
  const list = $('steps');
  list.innerHTML = '';
  const current = recon?.step ?? null;
  const failed = recon?.status === 'failed';
  const done = recon?.status === 'done';
  const at = STEPS.findIndex((s) => s.key === current);

  for (const [index, step] of STEPS.entries()) {
    const li = el('li');
    const passed = done || (at >= 0 && index < at);
    const running = !done && !failed && index === at;
    const broke = failed && index === at;
    li.className = broke ? 'bad' : passed ? 'done' : running ? 'run' : '';
    li.append(el('span', 'mk', broke ? '×' : passed ? '✓' : running ? '●' : '○'));
    const name = el('span');
    name.append(el('b', null, `${index + 1}/${STEPS.length} ${step.label}`));
    name.append(el('span', 'what', ` ${step.what}`));
    // 지금 도는 단계에만 막대를 붙인다. 전체 %로 합치지 않는 이유는 단계별 소요가
    // 입력에 따라 뒤집혀(학습 30000회 vs 프레임 500장) 없는 가중치를 지어내게 되기 때문이다.
    if (running && recon?.progress) {
      const bar = el('div', 'bar');
      const fill = el('div', 'fill');
      const pct = recon.progress.percent;
      fill.style.width = pct == null ? '100%' : `${pct}%`;
      if (pct == null) fill.classList.add('unknown');
      bar.append(fill);
      name.append(bar);
    }
    li.append(name);
    li.append(el('span', 'd', running ? runningDetail(recon) : detailFor(step.key, recon)));
    list.append(li);
  }
  // 상태 낱말을 앞에 박는다. 사유만 있으면 성공인지 실패인지가 한눈에 안 들어온다.
  // 번호는 **화면 기준**으로만 센다. 서버의 stepIndex는 도구 5단계 기준이라 화면의
  // 6단계(업로드 포함)와 어긋난다 — 섞으면 3/6인지 4/6인지 알 수 없어진다.
  const shown = at >= 0 ? at + 1 : 0;
  $('progressHint').textContent = failed ? `실패 — ${recon.error ?? '원인 불명'}`
    : done ? '완료'
      : recon?.status === 'running' && shown ? `${shown}/${STEPS.length} 단계 진행 중…`
        : recon?.status === 'running' ? '진행 중…'
          : recon?.status === 'pending' ? '대기 중…' : '';
  $('progressHint').className = `hint${failed ? ' bad' : ''}`;
}

/** 지금 도는 단계의 오른쪽 숫자. 막대는 근사여도 이 값은 도구가 준 그대로다. */
function runningDetail(recon) {
  const p = recon?.progress;
  if (!p) return '…';
  return p.percent == null ? p.label : `${p.label} · ${p.percent}%`;
}

function detailFor(key, recon) {
  if (!recon) return '';
  if (key === 'frames' && recon.frames) return `${recon.frames}장`;
  if (key === 'colmap:map' && recon.registeredImages == null && recon.tuning?.targetFrames) return '';
  if (key === 'colmap:map' && recon.registeredImages != null) {
    return `등록 ${recon.registeredImages}장 · 점 ${recon.points ?? 0}`;
  }
  if (key === 'opensplat' && recon.tuning?.numIters) return `${recon.tuning.numIters}회`;
  if (key === 'colmap:extract' && recon.tuning?.useGpu != null) return recon.tuning.useGpu ? 'GPU' : 'CPU';
  return '';
}

async function poll() {
  clearTimeout(state.timer);
  if (!state.watching) return;
  const { eventId, attachmentId } = state.watching;
  let recon = null;
  try {
    const record = await getJson(`/events/${encodeURIComponent(eventId)}`);
    recon = (record.attachments || []).find((a) => a.attachmentId === attachmentId)?.recon ?? null;
  } catch { /* 서버가 잠깐 안 받으면 다음 차례에 다시 본다 */ }

  setSteps(recon);
  rememberWatching();
  await refreshLog();

  if (recon && (recon.status === 'done' || recon.status === 'failed')) {
    state.watching = null;
    rememberWatching();
    await loadEvents();
    await loadRecords();
    if (recon.status === 'done' && recon.outputAttachmentId) {
      openViewer(eventId, recon.outputAttachmentId);
    }
    return;
  }
  state.timer = setTimeout(poll, 3000);
}

async function refreshLog() {
  if (!state.watching) return;
  const { eventId, attachmentId } = state.watching;
  try {
    // 로그는 첫 단계가 뭔가 쓰기 전까지 없다. 404는 정상이라 조용히 넘긴다.
    const res = await fetch(`/events/${encodeURIComponent(eventId)}/attachments/${encodeURIComponent(attachmentId)}/log?tail=40`, { cache: 'no-store' });
    if (!res.ok) return;
    const text = await res.text();
    const box = $('log');
    box.textContent = text;
    box.scrollTop = box.scrollHeight;
  } catch { /* 로그는 있으면 좋은 것뿐이다 */ }
}

// ── 기존 기록 ──
async function loadRecords() {
  const body = $('records');
  body.innerHTML = '';
  let events = [];
  try {
    events = (await getJson('/events?limit=100')).events;
  } catch {
    return;
  }

  // 목록 요약에는 첨부 상세가 없다. 첨부가 있는 것만 전문을 열어 본다.
  const rows = await Promise.all(events.map(async (event) => {
    if (!event.attachmentCount) return { event, attachments: [] };
    try {
      const record = await getJson(`/events/${encodeURIComponent(event.eventId)}`);
      return { event, attachments: record.attachments || [] };
    } catch {
      return { event, attachments: [] };
    }
  }));

  if (!rows.length) {
    body.append(el('tr')).append(Object.assign(el('td', 'none', '기록이 없다'), { colSpan: 6 }));
    return;
  }

  for (const { event, attachments } of rows) {
    const video = attachments.find((a) => a.kind === 'video');
    const splat = attachments.find((a) => a.kind === 'splat');
    const tr = el('tr');
    tr.append(el('td', null, clock(event.ts)));
    tr.append(el('td', null, event.tagId));
    tr.append(el('td', null, event.zone ?? '미지정'));
    tr.append(video ? el('td', null, mb(video.bytes)) : el('td', 'none', '없음'));

    const cell = el('td');
    const recon = video?.recon;
    if (splat) {
      cell.append(el('span', 'badge ok', mb(splat.bytes)));
      if (recon?.registeredImages != null) {
        cell.append(el('span', 'sub', ` 등록 ${recon.registeredImages}/${recon.frames ?? '?'}장`));
      }
    } else if (recon?.status === 'failed') {
      cell.append(el('span', 'badge bad', '실패'));
      cell.append(el('span', 'sub', ` ${recon.error ?? ''}`));
    } else if (recon?.status === 'running' || recon?.status === 'pending') {
      cell.append(el('span', 'badge warn', recon.status === 'running' ? '변환 중' : '대기'));
    } else {
      cell.append(el('span', 'none', '—'));
    }
    tr.append(cell);

    const act = el('td', 'act');
    if (splat) {
      const view = el('button', 'btn sm', '3D 보기');
      view.onclick = () => openViewer(event.eventId, splat.attachmentId);
      const get = el('a', 'btn sm', '받기');
      get.href = `/events/${encodeURIComponent(event.eventId)}/attachments/${encodeURIComponent(splat.attachmentId)}`;
      get.download = '';
      act.append(view, get);
    }
    if (video) {
      const retry = el('button', 'btn sm', splat ? '다시 변환' : '변환');
      retry.onclick = () => retryRecon(event.eventId, video.attachmentId);
      act.append(retry);
      if (recon?.status === 'failed' || recon?.status === 'done') {
        const logBtn = el('button', 'btn sm', '로그');
        logBtn.onclick = () => showLog(event.eventId, video.attachmentId);
        act.append(logBtn);
      }
    }
    tr.append(act);
    body.append(tr);
  }
}

async function retryRecon(eventId, attachmentId) {
  const params = tuningQuery();
  params.delete('kind');
  params.delete('name');
  try {
    const res = await fetch(`/events/${encodeURIComponent(eventId)}/attachments/${encodeURIComponent(attachmentId)}/recon?${params}`, { method: 'POST' });
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

async function showLog(eventId, attachmentId) {
  const res = await fetch(`/events/${encodeURIComponent(eventId)}/attachments/${encodeURIComponent(attachmentId)}/log?tail=200`, { cache: 'no-store' });
  $('log').textContent = res.ok ? await res.text() : '로그가 없다';
  $('logWrap').open = true;
  $('progress').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// ── 뷰어 ──
async function openViewer(eventId, attachmentId) {
  const url = `/events/${encodeURIComponent(eventId)}/attachments/${encodeURIComponent(attachmentId)}`;
  const note = $('stagenote');
  $('viewerHint').textContent = clock(state.events.find((e) => e.eventId === eventId)?.ts ?? Date.now());
  note.textContent = '3D 현장 불러오는 중…';
  try {
    // three·gaussian-splats-3d는 무거워서(약 1.4MB) 볼 때 처음 받는다.
    if (!state.viewerLoading) state.viewerLoading = import('./splat-view.js');
    const mod = await state.viewerLoading;
    await mod.show($('stage'), url, (text) => { note.textContent = text; });
    note.textContent = '';
  } catch (error) {
    note.textContent = `3D를 못 띄웠다 — ${error.message || error}`;
    console.error('[recon] viewer', error);
  }
}

// ── 시작 ──
/**
 * 보고 있던 재구성을 주소에 남긴다. 15분짜리 작업 중에 새로고침하거나 창을 닫으면
 * 진행 화면을 통째로 잃는데, 주소만 있으면 다시 붙는다.
 */
function rememberWatching() {
  const url = new URL(location.href);
  if (state.watching) {
    url.searchParams.set('watch', `${state.watching.eventId}/${state.watching.attachmentId}`);
  } else {
    url.searchParams.delete('watch');
  }
  history.replaceState(null, '', url);
}

function restoreWatching() {
  const raw = new URL(location.href).searchParams.get('watch');
  if (!raw) return;
  const slash = raw.lastIndexOf('/');
  if (slash <= 0) return;
  state.watching = { eventId: raw.slice(0, slash), attachmentId: raw.slice(slash + 1) };
  poll();
}

bindFilePicker();
$('go').onclick = startUpload;
$('reload').onclick = () => { loadEvents(); loadRecords(); };
setSteps(null);
loadEvents();
loadRecords();
restoreWatching();
