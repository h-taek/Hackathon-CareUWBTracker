// 실시간 관제 화면(F10). /map으로 좌표계를 받고 /stream(SSE)의 position·alert를 그린다.
//
// 얇은 클라이언트다(plan/04 §7). 여기서 계산하는 것은 화면 표현뿐이고, 측위·구역 판정·낙상
// 판정은 전부 서버가 한다. 특히 경보는 감지기만 낸다 — 이 파일에 경보를 만드는 경로는 없고,
// 데모 버튼도 /inject-fall로 실제 파이프라인을 태운다.
//
// 그리기 규칙 하나: 목록의 DOM 노드는 지웠다 새로 만들지 않고 제자리에서 고쳐 쓴다.
// 좌표가 초당 15~30번 들어오는데 그때마다 노드를 갈아치우면 커서 밑 요소가 사라졌다 생겨
// :hover가 깜빡이고, 스크롤 위치도 튄다.
//
// 화면 구조와 클래스는 index.html · assets/css/console.css를 함께 본다.

const $ = (id) => document.getElementById(id);
const tpl = (id) => $(id).content.firstElementChild;

// 끊김은 서버가 알려주지 않는다 — 태그가 죽으면 아무 프레임도 안 올 뿐이다.
// 시뮬 5Hz / 실측 10Hz 기준으로 이만큼 조용하면 끊긴 것으로 본다.
const OFFLINE_MS = 4000;

const ZOOM_MIN = 0.6;
const ZOOM_MAX = 2.5;

const LABEL = { ok: '정상', sel: '선택', off: '끊김', alarm: '낙상' };

// 관제사 판정(spec operation 02 §3). 이 값이 confirmed가 되면 사건 사본이 만들어진다.
const OUTCOME_LABEL = {
  detected: '판정 대기',
  confirmed: '낙상',
  false_alarm: '오보',
};
/** 번복 창. 서버 /events가 실제 값을 알려주면 그걸로 바뀐다. */
let undoWindowMs = 24 * 3600 * 1000;

// 층은 아직 서버에 개념이 없다. 1층만 데이터가 있고 나머지는 자리만 잡아둔다.
const FLOORS = [
  { id: 'F1', name: '1층 · 요양생활실', ready: true },
  { id: 'F2', name: '2층 · 요양생활실', ready: false },
  { id: 'F3', name: '3층 · 재활실', ready: false },
  { id: 'F4', name: '4층 · 관리동', ready: false },
];

const state = {
  frames: new Map(),        // tagId -> 최신 position 페이로드 (+ seenAt)
  alert: null,              // 진행 중 경보 1건. 종료는 관제사만 한다
  events: [],               // 이벤트 로그. /events 기록 + 이번 세션에 종료한 경보
  eventsDirty: true,        // 로그가 바뀌었을 때만 다시 그린다
  // 방금 판정했는데 서버 목록에는 아직 없는 건. 기록은 후행 창 10초가 찬 뒤에야 파일이 되고,
  // 그 사이에 목록을 통째로 갈아끼우면 방금 만든 줄이 사라졌다 되살아난다.
  freshEvents: new Map(),
  eventFilter: 'all',       // all | judged | pending
  judging: null,            // 판정 창에 올라온 이벤트
  modal: false,             // 팝업 창이 떠 있나(판정 또는 삭제 확인)
  scenes: [],               // 확인된 사고 + 그 3D 첨부(사고 현장 3D 탭)
  scenesDirty: true,
  sceneOpen: null,          // 지금 뷰어에 올라간 eventId
  scenesLoading: false,
  selected: null,
  live: false,
  bounds: { x: [0, 32], y: [0, 20] },   // 서버 /map이 오면 그 값이 이긴다
  floor: 'F1',
  floorsOpen: false,
  leftOpen: true,
  rightOpen: true,
  tab: 'tags',
  zoom: 1,
  pan: { x: 0, y: 0 },
  clipId: null,             // /clips에서 고른 낙상 클립
  demoNote: '',
};

// ── 표시 형식 ──────────────────────────────────────────────

const pad2 = (n) => String(n).padStart(2, '0');
const fmtClock = (ms) => {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};
const fmtG = (v) => (Number.isFinite(v) ? `${v.toFixed(1)} g` : '—');
const errOf = (f) => (f.err && typeof f.err.xy === 'number' ? f.err.xy : 0.3);
const clampZoom = (z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

const isOffline = (f, now) => (f.seenAt != null ? now - f.seenAt > OFFLINE_MS : !!f.offline);

function stateOf(f, now) {
  if (state.alert && state.alert.tagId === f.tagId) return 'alarm';
  if (isOffline(f, now)) return 'off';
  if (f.tagId === state.selected) return 'sel';
  return 'ok';
}

/**
 * 태그 이름. 실시간 프레임에 있으면 그걸 쓰고, 없으면 `/tags` 명부에서 찾는다.
 *
 * 지난 사고를 다룰 때는 프레임만으로 부족하다 — 그 태그가 지금 조용하거나 첫 좌표가
 * 아직 안 왔으면 화면에 `tag-101` 같은 내부 ID가 그대로 뜬다.
 */
const roster = new Map();

const nameOf = (tagId) => {
  const f = state.frames.get(tagId);
  return (f && f.name) || roster.get(tagId) || tagId;
};

const selectedPos = () => {
  const f = state.selected ? state.frames.get(state.selected) : null;
  return (f && f.pos) || null;
};

// ── 뷰 변환 ────────────────────────────────────────────────
// 줌·패닝은 CSS 변수 몇 개가 전부다. 드래그와 휠은 이 함수만 부른다 — 목록까지 다시 그리면
// 포인터 이벤트마다 수십 개 노드를 만지느라 프레임이 떨어진다.

/**
 * 커스텀 속성(--zoom 같은 것)을 쓰지 않는다.
 *
 * 처음에는 이 값들을 .app에 얹었는데, .app은 화면 전체의 조상이라 값 하나 바꿀 때마다
 * 하위 트리 전체의 스타일이 무효화됐다 — 드래그 2초에 스타일 재계산 214회 124ms.
 * 쓰는 요소에 그 속성을 직접 쓰면 그 요소만 무효화된다. transform과 background-position은
 * 상속되지 않는 속성이라 아래로 번지지도 않는다.
 */
let appliedZoom = 0;

function applyView() {
  const z = state.zoom;
  const px = state.pan.x;
  const py = state.pan.y;
  $('plan').style.transform = `scale(${z}) translate(${px.toFixed(1)}px, ${py.toFixed(1)}px)`;
  // 청사진 모눈도 같은 양만큼 민다. 화면 이동량은 줌이 곱해진 값이다.
  $('app').style.backgroundPosition = `${(px * z).toFixed(1)}px ${(py * z).toFixed(1)}px`;
  if (z !== appliedZoom) {
    appliedZoom = z;
    // 마커 내용물이 배율을 되감아 화면상 크기를 유지한다. 줌이 바뀔 때만 건드린다 —
    // 패닝에는 배율이 안 변하니 드래그 중에는 이 줄이 아예 안 돈다.
    $('markers').style.setProperty('--inv-zoom', String(1 / z));
    setText($('zoomLabel'), `${Math.round(z * 100)}%`);
  }
}

/**
 * 도면의 변환 이전 중심을 화면 좌표로 돌려준다.
 *
 * `transform: scale(z) translate(p)`는 transform-origin이 가운데라 확대해도 중심이 안 움직이고,
 * translate만 중심을 z*p 만큼 민다. getBoundingClientRect는 변환 '후' 사각형을 주므로
 * 그만큼 되돌려야 원래 중심이 나온다. 커서 기준 확대가 이 값 위에서 성립한다.
 */
function planCenter() {
  const r = $('plan').getBoundingClientRect();
  return {
    x: r.left + r.width / 2 - state.zoom * state.pan.x,
    y: r.top + r.height / 2 - state.zoom * state.pan.y,
    w: r.width / state.zoom,
    h: r.height / state.zoom,
  };
}

/** 화면상의 한 점(sx, sy)을 붙잡은 채 배율만 바꾼다. 휠 확대가 커서를 따라가게 하는 계산. */
function zoomAround(nextZoom, sx, sy) {
  const z1 = clampZoom(nextZoom);
  const z0 = state.zoom;
  if (z1 === z0) return;
  const c = planCenter();
  const k = 1 / z1 - 1 / z0;
  state.pan = { x: state.pan.x + (sx - c.x) * k, y: state.pan.y + (sy - c.y) * k };
  state.zoom = z1;
  applyView();
}

// ── 마커 ───────────────────────────────────────────────────

const markerEls = new Map();   // tagId -> .marker. 재사용해야 CSS 전환이 걸린다

/**
 * 도면의 '변환 이전' 픽셀 크기. 마커를 px로 옮기려면 이게 있어야 한다.
 *
 * ResizeObserver의 contentRect는 transform을 적용하기 전 크기를 준다 — 줌·패닝에는 반응하지
 * 않고 실제 레이아웃이 바뀔 때(창 크기, 패널 접기)만 갱신된다. 그래서 매 프레임 재는 대신
 * 여기 받아두고 쓴다. getBoundingClientRect를 프레임마다 부르면 그 자체가 레이아웃을 강제한다.
 */
let planSize = { w: 0, h: 0 };
new ResizeObserver((entries) => {
  const r = entries[0].contentRect;
  planSize = { w: r.width, h: r.height };
  scheduleRender();
}).observe($('plan'));

function renderMarkers(list, now) {
  if (planSize.w === 0) return;   // 첫 레이아웃 전
  const [bx0, bx1] = state.bounds.x;
  const [, by1] = state.bounds.y;
  const bw = bx1 - bx0 || 32;
  const bh = state.bounds.y[1] - state.bounds.y[0] || 20;
  const seen = new Set();

  for (const f of list) {
    if (!f.pos) continue;         // 사생활 구역·측위 실패는 마커를 그리지 않는다(A-P2)
    seen.add(f.tagId);
    let el = markerEls.get(f.tagId);
    if (!el) {
      el = tpl('tplMarker').cloneNode(true);
      el.$name = el.querySelector('.marker-name');
      el.$state = el.querySelector('.marker-state');
      markerEls.set(f.tagId, el);
      $('markers').appendChild(el);
    }
    const st = stateOf(f, now);
    const cls = `marker is-${st}`;
    if (el.className !== cls) el.className = cls;
    setVar(el, '--mx', `${((f.pos.x - bx0) / bw * planSize.w).toFixed(1)}px`);
    setVar(el, '--my', `${((by1 - f.pos.y) / bh * planSize.h).toFixed(1)}px`);
    // 후광 크기. 백분율이라 실제로는 테두리만 남는다 — 오차 반경을 원으로 키우지
    // 않는 것은 의도한 선택이다(디자인 원본과 같다).
    setVar(el, '--err-w', `${(errOf(f) * 2 / bw * 100).toFixed(2)}%`);
    setText(el.$name, f.name || f.tagId);
    setText(el.$state, LABEL[st]);
  }

  for (const [tagId, el] of markerEls) {
    if (seen.has(tagId)) continue;
    el.remove();
    markerEls.delete(tagId);
  }
}

// 값이 같으면 건드리지 않는다. 커서 밑 노드를 괜히 만지지 않으려는 것이기도 하고,
// 같은 값을 다시 써도 브라우저는 스타일을 다시 계산하기 때문이다.
function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}
function setVar(el, name, value) {
  if (el.style.getPropertyValue(name) !== value) el.style.setProperty(name, value);
}

// ── 대상 목록 ──────────────────────────────────────────────

const rosterEls = new Map();   // tagId -> .roster-item

function renderRoster(list, now) {
  const box = $('roster');
  const empty = list.length === 0;
  box.classList.toggle('is-empty', empty);
  $('rosterEmpty').textContent = state.live ? '수신 중인 태그가 없다' : '스트림 연결을 기다리는 중…';
  $('rosterEmpty').hidden = !empty;

  const seen = new Set();
  for (const f of list) {
    seen.add(f.tagId);
    let el = rosterEls.get(f.tagId);
    if (!el) {
      el = tpl('tplRoster').cloneNode(true);
      el.$name = el.querySelector('.roster-name');
      el.$detail = el.querySelector('.roster-detail');
      el.$pill = el.querySelector('.pill');
      el.onclick = () => {
        state.selected = state.selected === f.tagId ? null : f.tagId;
        render();
      };
      rosterEls.set(f.tagId, el);
      box.appendChild(el);
    }
    const st = stateOf(f, now);
    // 선택 여부와 건강 상태는 따로 표시한다 — 선택했다고 상태가 가려지면 안 된다.
    const health = st === 'sel' ? 'ok' : st;
    const cls = `roster-item is-${health}${st === 'sel' ? ' is-sel' : ''}${f.privacy ? ' is-priv' : ''}`;
    if (el.className !== cls) el.className = cls;
    setText(el.$name, f.name || f.tagId);
    setText(el.$detail, detailOf(f, now));
    setText(el.$pill, f.privacy ? '사생활' : LABEL[health]);
  }

  for (const [tagId, el] of rosterEls) {
    if (seen.has(tagId)) continue;
    el.remove();
    rosterEls.delete(tagId);
  }
}

function detailOf(f, now) {
  // 사생활 구역은 정상 동작이고 측위 실패는 경고다. 둘을 문구로 갈라놓는다(A-P4).
  if (f.privacy) return `${f.zone || '구역'} · 체류 중 · 위치 미기록`;
  if (isOffline(f, now)) return `측위 끊김 · 마지막 수신 ${f.seenAt ? fmtClock(f.seenAt) : '미상'}`;
  return (f.zone || '구역 미지정') + (f.pos ? ` · ±${errOf(f).toFixed(1)}m` : '');
}

// ── 이벤트 로그 ────────────────────────────────────────────

/**
 * 받침에 따라 '으로'와 '로'를 고른다. 받침이 없거나 ㄹ이면 '로'다 —
 * "오경보로 확정"이지 "오경보으로 확정"이 아니다.
 */
function withRo(word) {
  const last = word.charCodeAt(word.length - 1) - 0xac00;
  const jong = last >= 0 && last <= 11171 ? last % 28 : 0;
  return `${word}${jong === 0 || jong === 8 ? '로' : '으로'}`;
}

/** 판정이 끝난 건인가. 필터와 대기 건수가 같은 기준을 쓴다. */
const isJudged = (e) => e.outcome === 'confirmed' || e.outcome === 'false_alarm';

/** 이 판정을 아직 뒤집을 수 있나(spec 11 §3). 판정 전이면 애초에 번복이 아니다. */
function canUndo(e, now) {
  if (!isJudged(e)) return false;
  return Number.isFinite(e.resolvedAt) && now < e.resolvedAt + undoWindowMs;
}

const FILTERS = {
  all: () => true,
  judged: isJudged,
  pending: (e) => !isJudged(e),
};

const EMPTY_TEXT = {
  all: '기록된 감지 없음',
  judged: '판정된 사고 없음',
  pending: '판정 대기 없음',
};

function renderEvents() {
  const pending = state.events.filter((e) => !isJudged(e)).length;
  setText($('eventCountLabel'), pending > 0 ? `${state.events.length}건 · 판정 ${pending}` : `${state.events.length}건`);
  for (const button of $('eventFilter').children) {
    const on = button.dataset.filter === state.eventFilter;
    button.classList.toggle('is-active', on);
    button.setAttribute('aria-selected', String(on));
  }
  if (!state.eventsDirty) return;      // 로그는 자주 안 바뀐다. 바뀔 때만 다시 만든다
  state.eventsDirty = false;

  const box = $('eventLog');
  box.textContent = '';
  const shown = state.events.filter(FILTERS[state.eventFilter] || FILTERS.all);
  if (shown.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = EMPTY_TEXT[state.eventFilter] || EMPTY_TEXT.all;
    box.appendChild(empty);
    return;
  }
  for (const e of shown) {
    const node = tpl('tplEvent').cloneNode(true);
    const card = node.querySelector('.event');
    card.className = `event is-${e.outcome}`;
    card.querySelector('.event-title').textContent = `${e.name} · 낙상 감지`;
    card.querySelector('.event-time').textContent = fmtClock(e.ts);
    card.querySelector('.event-status').textContent = OUTCOME_LABEL[e.outcome] || e.outcome;
    card.querySelector('.event-where').textContent =
      (e.zone || '구역 미지정')
      + (e.privacy ? ' · 좌표 미기록' : '')
      + (e.purged ? ' · 좌표 파기됨' : '');
    card.querySelector('.event-meta').textContent = fmtG(e.peakAccel);
    card.onclick = () => openJudge(e);

    // 판정이 무엇이든 로그는 지울 수 있다. 확인된 사고는 이미 사건 저장소에 사본이
    // 있으므로, 여기서 지워도 좌측 사건 목록은 그대로다(spec operation 02 §2).
    node.querySelector('.event-x').onclick = () => confirmDelete('event', e);
    box.appendChild(node);
  }
}

// ── 팝업 창 ────────────────────────────────────────────────
//
// 판정과 삭제 확인이 같은 창을 쓴다. 내용과 버튼만 갈아 끼운다.

/** actions: [{ text, onclick, primary?, disabled?, id? }] */
function openModal({ kicker, title, note, actions }) {
  setText($('modalKicker'), kicker);
  setText($('modalTitle'), title);
  setText($('modalNote'), note);
  const box = $('modalActs');
  box.textContent = '';
  for (const a of actions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `alert-resolve${a.primary ? ' is-confirm' : ''}`;
    if (a.id) button.id = a.id;
    button.textContent = a.text;
    button.disabled = !!a.disabled;
    button.onclick = a.onclick;
    box.appendChild(button);
  }
  state.modal = true;
  $('modal').hidden = false;
}

function closeModal() {
  state.modal = false;
  state.judging = null;
  $('modal').hidden = true;
}

/** 카드를 누르면 열린다. 판정과 번복이 같은 창을 쓴다. */
function openJudge(e) {
  state.judging = e;
  const judged = isJudged(e);
  const open = !judged || canUndo(e, Date.now());
  openModal({
    kicker: '사고 판정',
    title: `${e.name} · ${fmtClock(e.ts)}`,
    note: judgeNote(e, judged, open),
    actions: [
      // 지금 상태와 같은 쪽은 누를 수 없다. 서버도 409로 막지만 눌러지면 안 된다.
      { id: 'judgeFall', text: '낙상', primary: true, disabled: !open || e.outcome === 'confirmed', onclick: () => sendOutcome(e.id, 'confirmed') },
      {
        id: 'judgeFalse',
        text: '오보',
        disabled: !open || e.outcome === 'false_alarm',
        // 낙상이었던 건을 오보로 뒤집으면 사건 사본이 지워진다. 붙여둔 영상·3D까지 같이 간다.
        onclick: () => (e.outcome === 'confirmed'
          ? confirmUndo(e)
          : sendOutcome(e.id, 'false_alarm')),
      },
    ],
  });
}

/** 낙상 → 오보 번복. 사건 사본이 함께 지워지므로 판정 창 위에 한 번 더 묻는다. */
function confirmUndo(e) {
  openModal({
    kicker: '오보로 번복',
    title: `${e.name} · ${fmtClock(e.ts)}`,
    note: '사건 기록과 포함된 현장 영상·3D 함께 삭제 · 복구 불가',
    actions: [
      { id: 'undoCancel', text: '취소', onclick: () => openJudge(e) },
      { id: 'undoGo', text: '오보로 변경', primary: true, onclick: () => sendOutcome(e.id, 'false_alarm') },
    ],
  });
}

function judgeNote(e, judged, open) {
  const where = (e.zone || '구역 미지정') + (e.purged ? ' · 좌표 파기됨' : '');
  if (!judged) return `${where} · 판정 대기`;
  const hours = Math.round(undoWindowMs / 3600000);
  if (!open) return `${where} · ${OUTCOME_LABEL[e.outcome]} 확정 · 정정 기한 ${hours}시간 경과`;
  // 남은 시간과 현재 판정은 안 쓴다. 지금 판정이 무엇인지는 눌리지 않는 버튼이 이미 말한다.
  return '판정 수정';
}

/**
 * 수동 삭제는 반드시 한 번 더 묻는다. 되돌릴 수 없고, 영상·3D까지 폴더째 사라진다.
 * 무엇이 같이 지워지는지를 문구로 먼저 보여준다.
 */
/**
 * 수동 삭제는 반드시 한 번 더 묻는다. 되돌릴 수 없다.
 *
 * **감지 이벤트와 확인 사건은 다른 것을 지운다.** 로그의 X는 24시간짜리 운영 기록만
 * 지우고 사건은 건드리지 않는다. 사건 삭제는 영상·3D까지 함께 사라진다.
 */
function confirmDelete(kind, e) {
  const incident = kind === 'incident';
  const lost = incident
    ? ['사건 기록', e.hasVideo && '현장 영상', e.hasSplat && '3D'].filter(Boolean).join(' · ')
    : '감지 기록';
  openModal({
    kicker: incident ? '사건 삭제' : '기록 삭제',
    title: `${e.name} · ${fmtClock(e.ts)}`,
    note: `${e.zone || '구역 미지정'} · ${lost} 영구 삭제 · 복구 불가`,
    actions: [
      { id: 'deleteCancel', text: '취소', onclick: closeModal },
      { id: 'deleteGo', text: '삭제', primary: true, onclick: () => removeRecord(kind, e.id) },
    ],
  });
}

async function removeRecord(kind, id) {
  closeModal();
  const base = kind === 'incident' ? '/incidents' : '/events';
  try {
    const res = await fetch(`${base}/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const body = await res.json().catch(() => ({}));
    state.demoNote = res.ok
      ? `${kind === 'incident' ? '사건' : '기록'} 삭제됨`
      : `삭제 실패 — ${body.error || res.status}`;
  } catch {
    state.demoNote = '서버 연결 실패';
  }
  if (kind === 'incident') await loadScenes();
  else {
    state.freshEvents.delete(id);
    await loadHistory();
  }
  render();
}

// ── 사고 현장 3D ───────────────────────────────────────────
//
// **감지 이벤트와 다른 폴더를 읽는다**(spec operation 02 §2). 판정이 confirmed가 될 때
// 만들어진 사본이라, 우측 로그에서 원본을 지워도 여기 남는다. 영상·3D도 이쪽에 붙는다.
//
// 3D는 실시간 관제에 쓰지 않는다(spec system 01 §2.6). 이 탭은 사고 이후 열람 전용이라
// 탭을 벗어나면 뷰어를 내려 GPU를 놓는다.

/** 확인된 사고와 그 3D 첨부를 받는다. 탭을 열 때만 부른다 — 목록이 자주 안 바뀐다. */
async function loadScenes() {
  if (state.scenesLoading) return;
  state.scenesLoading = true;
  try {
    // 탭을 아주 빨리 누르면 명부가 아직 안 왔을 수 있다. 그러면 이름 대신 태그 ID가 뜬다.
    if (roster.size === 0) {
      const tags = await fetch('/tags').then((r) => r.json()).catch(() => []);
      for (const tag of tags) roster.set(tag.id, tag.name);
    }
    const { incidents = [] } = await fetch('/incidents?limit=50').then((r) => r.json());
    // 목록을 다시 받아도 펼쳐 둔 상세는 그대로 둔다.
    const before = new Map(state.scenes.map((s) => [s.id, s]));
    // 요약에는 첨부 상세가 없다. 첨부가 붙은 것만 전문을 열어 본다.
    state.scenes = await Promise.all(incidents.map(async (e) => {
      const kept = before.get(e.eventId);
      const base = {
        id: e.eventId, name: nameOf(e.tagId), zone: e.zone, ts: e.ts, splat: null, video: null,
        expanded: !!kept?.expanded, record: kept?.record ?? null, loading: false,
      };
      if (!e.attachmentCount) return base;
      try {
        const record = await fetch(`/incidents/${encodeURIComponent(e.eventId)}`).then((r) => r.json());
        const attachments = record.attachments || [];
        return {
          ...base,
          splat: attachments.find((a) => a.kind === 'splat') || null,
          video: attachments.find((a) => a.kind === 'video') || null,
        };
      } catch {
        return base;
      }
    }));
    state.scenesDirty = true;
    render();
  } catch {
    /* 목록을 못 받아도 실시간 관제는 계속 돈다 */
  } finally {
    state.scenesLoading = false;
  }
}

const sceneEls = new Map();

function renderScenes() {
  const withSplat = state.scenes.filter((s) => s.splat).length;
  setText($('sceneCount'), state.scenes.length === 0
    ? '없음'
    : `${state.scenes.length}건 · 3D ${withSplat}`);
  if (!state.scenesDirty) return;
  state.scenesDirty = false;

  const box = $('sceneList');
  box.textContent = '';
  sceneEls.clear();
  if (state.scenes.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = '확인된 사고 없음';
    box.appendChild(empty);
    return;
  }

  for (const s of state.scenes) {
    const node = tpl('tplScene').cloneNode(true);
    node.classList.toggle('has-splat', !!s.splat);
    node.classList.toggle('is-open', state.sceneOpen === s.id);
    node.classList.toggle('is-expanded', !!s.expanded);
    node.querySelector('.scene-name').textContent = `${s.name} · ${fmtClock(s.ts)}`;
    node.querySelector('.scene-detail').textContent = s.zone || '구역 미지정';
    node.querySelector('.scene-badge').textContent = s.splat ? '3D' : reconLabel(s);
    // 줄을 누르면 상세만 펼친다. 3D와 영상은 상세 안 버튼으로만 연다 —
    // 1.4MB 라이브러리를 받고 GPU를 잡는 일이 목록을 훑는 동작에 딸려오면 안 된다.
    node.querySelector('.scene-open').onclick = () => toggleDetail(s);

    node.querySelector('.scene-toggle').onclick = () => toggleDetail(s);
    sceneEls.set(s.id, node);
    box.appendChild(node);
    if (s.expanded) fillDetail(s);
  }
}

// ── 사고 상세 ──────────────────────────────────────────────

/** 펼칠 때 전문을 받는다. 궤적·가속도가 건당 50KB라 목록을 만들 때 미리 받지 않는다. */
async function toggleDetail(s) {
  s.expanded = !s.expanded;
  const node = sceneEls.get(s.id);
  if (!node) return;
  node.classList.toggle('is-expanded', s.expanded);
  node.querySelector('.scene-toggle').setAttribute('aria-expanded', String(s.expanded));
  node.querySelector('.scene-body').hidden = !s.expanded;
  if (!s.expanded) return;

  fillDetail(s);
  if (s.record || s.loading) return;
  s.loading = true;
  try {
    s.record = await fetch(`/events/${encodeURIComponent(s.id)}`).then((r) => r.json());
  } catch {
    s.record = null;
  }
  s.loading = false;
  fillDetail(s);
}

function fillDetail(s) {
  const node = sceneEls.get(s.id);
  if (!node) return;
  const body = node.querySelector('.scene-body');
  body.hidden = !s.expanded;
  body.textContent = '';
  if (!s.record) {
    body.appendChild(row('scene-none', s.loading ? '불러오는 중…' : '상세 불러오기 실패'));
    return;
  }

  const r = s.record;
  const track = Array.isArray(r.track) ? r.track : [];
  const accel = Array.isArray(r.accel) ? r.accel : [];
  const purged = Array.isArray(r.purged) && r.purged.includes('track');

  body.appendChild(fact('이동 경로',
    purged ? '보관기간 경과 · 파기됨' : `${span(track)}초 · ${walked(track).toFixed(1)}m · 시작 → 낙상`,
    track.length > 1 ? trackSvg(track) : null));

  body.appendChild(fact('가속도',
    accel.length ? `${span(accel)}초 · 최대 ${peakG(accel).toFixed(1)} g` : '없음',
    accel.length > 1 ? accelSvg(accel) : null));

  // 등록된 영상 — 3D와 같은 뷰어 자리에서 재생한다.
  const video = s.video;
  const videoFact = fact('등록된 영상',
    video ? `${mb(video.bytes)}MB · ${fmtClock(video.capturedAt || video.uploadedAt)}` : '없음', null);
  if (video) videoFact.appendChild(acts([['영상 보기', () => openVideo(s)]]));
  body.appendChild(videoFact);

  // 3DGS 맵
  const recon = video?.recon;
  const splatFact = fact('3DGS 맵',
    s.splat
      ? `${mb(s.splat.bytes)}MB · 등록 ${recon?.registeredImages ?? '?'}/${recon?.frames ?? '?'}장 · 점 ${(recon?.points ?? 0).toLocaleString()}`
      : reconLabel(s), null);
  if (s.splat) splatFact.appendChild(acts([['3D 보기', () => openScene(s)]]));
  body.appendChild(splatFact);

  // 목록 끝. 영상은 관제 화면에서 올리지 않는다 — 변환이 몇십 분짜리라 경보를 가린다.
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'scene-act scene-add';
  add.textContent = '영상 등록';
  add.onclick = () => openRecon(s);
  body.appendChild(add);

  // 사건 삭제는 상세를 펼쳐야 닿는다. 목록을 훑다가 눌리는 자리에 두면 안 되는 동작이다.
  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'scene-act scene-add is-danger';
  del.textContent = '사건 삭제';
  del.onclick = () => confirmDelete('incident', { ...s, hasSplat: !!s.splat, hasVideo: !!s.video });
  body.appendChild(del);

  // 상세의 끝을 긋는다. 접혀 있을 때는 .scene-body째 사라지므로 줄도 같이 사라진다.
  body.appendChild(row('scene-end', ''));
}

function row(className, text) {
  const el = document.createElement('div');
  el.className = className;
  el.textContent = text;
  return el;
}

function fact(label, meta, graph) {
  const box = document.createElement('div');
  box.className = 'scene-fact';
  const head = document.createElement('div');
  head.className = 'scene-fact-head';
  head.appendChild(row('', label));
  head.appendChild(row('scene-fact-meta', meta));
  box.appendChild(head);
  if (graph) box.appendChild(graph);
  return box;
}

function acts(pairs) {
  const box = document.createElement('div');
  box.className = 'scene-acts';
  for (const [text, onclick] of pairs) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'scene-act';
    button.textContent = text;
    button.onclick = onclick;
    box.appendChild(button);
  }
  return box;
}

const mb = (bytes) => (Number(bytes || 0) / 1024 / 1024).toFixed(1);

const walked = (track) => track.reduce((sum, p, i) =>
  (i === 0 ? 0 : sum + Math.hypot(p.x - track[i - 1].x, p.y - track[i - 1].y)), 0);

const peakG = (accel) => accel.reduce((max, a) =>
  Math.max(max, Math.hypot(a.x, a.y, a.z) / 9.80665), 0);

/** 표본이 걸친 시간(초). 창은 경보 시각 전후 10초다(spec system 03 §6.1). */
const span = (samples) => (samples.length < 2
  ? '0'
  : ((samples[samples.length - 1].ts - samples[0].ts) / 1000).toFixed(0));

/**
 * 경보 전후 20초 동안 대상이 실제로 지나간 자리를 위에서 내려다본 그림이다.
 * 도면과 같은 방향이고(위가 북쪽), 빈 원이 창의 시작, 붉은 점이 쓰러진 자리다.
 *
 * **가로세로 비율을 왜곡하지 않는다.** 데이터 범위에 맞춰 늘리면 복도를 따라 곧게 걸은
 * 7m가 화면을 가득 채운 곡선으로 보여서, 무엇을 본 것인지 알 수 없게 된다.
 */
function trackSvg(track) {
  // **뷰박스 자체가 4:3이다.** 상자만 4:3으로 만들고 뷰박스를 정사각으로 두면 `meet`이
  // 남는 폭을 여백으로 흘려보내 그림이 가운데 작게 박힌다. 비율 왜곡을 막는 것은
  // 아래 균일 배율(k)이므로, 뷰박스 모양은 상자와 맞추는 것이 맞다.
  const W = 100;
  const H = 75;
  const PAD = 6;
  const xs = track.map((p) => p.x);
  const ys = track.map((p) => p.y);
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  const [y0, y1] = [Math.min(...ys), Math.max(...ys)];
  // 거의 제자리에 있었던 경우에도 점이 한 곳에 뭉치지 않게 최소 폭을 준다.
  const w = Math.max(x1 - x0, 1);
  const h = Math.max(y1 - y0, 1);
  const k = Math.min((W - PAD * 2) / w, (H - PAD * 2) / h);
  const ox = (W - w * k) / 2;
  const oy = (H - h * k) / 2;
  // y는 도면과 같이 뒤집는다 — 세계 좌표는 위로 갈수록 크고 화면은 반대다.
  const at = (p) => [ox + (p.x - x0) * k, oy + (y1 - p.y) * k];
  const pts = track.map((p) => at(p).map((v) => v.toFixed(1)).join(',')).join(' ');
  const [sx, sy] = at(track[0]);
  const [ex, ey] = at(track[track.length - 1]);

  return svg(`<polyline points="${pts}" fill="none" stroke="#597ea3" stroke-width="1.4"
      stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"></polyline>
    <circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="1.5" fill="#fdfdfd" stroke="#8a8a8d"
      stroke-width="1" vector-effect="non-scaling-stroke"></circle>
    <circle cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="2" fill="#a6473a"></circle>`,
  W, H, 'xMidYMid meet', 'is-map');
}

/**
 * 가속도 크기 |a|의 파형. 봉우리 하나가 충격 순간이다.
 * 정지 기준선(1g)을 깔아 둬야 봉우리가 얼마나 튄 것인지 눈으로 가늠된다.
 */
function accelSvg(accel) {
  const mags = accel.map((a) => Math.hypot(a.x, a.y, a.z));
  const top = Math.max(...mags, 1);
  const step = 100 / Math.max(mags.length - 1, 1);
  const y = (m) => 28 - (m / top) * 26;
  const pts = mags.map((m, i) => `${(i * step).toFixed(2)},${y(m).toFixed(1)}`).join(' ');
  const base = y(9.80665).toFixed(1);
  return svg(`<line x1="0" y1="${base}" x2="100" y2="${base}" stroke="#c9c9cb" stroke-width="1"
      stroke-dasharray="3 3" vector-effect="non-scaling-stroke"></line>
    <polyline points="${pts}" fill="none" stroke="#3f7d55" stroke-width="1.2"
      stroke-linejoin="round" vector-effect="non-scaling-stroke"></polyline>`, 100, 30);
}

/**
 * 이동 경로는 비율을 지켜야 하고(meet), 파형은 시간축을 가로로 꽉 채워야 한다(none).
 * 둘의 요구가 반대라 여기서 갈라 준다.
 */
function svg(inner, w, h, fit = 'none', cls = '') {
  const box = document.createElement('div');
  box.className = `scene-graph ${cls}`.trim();
  box.innerHTML = `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="${fit}">${inner}</svg>`;
  return box;
}

/** 3D가 아직 없는 건의 상태 한 단어. 변환이 도는 중인지 실패했는지를 구분한다. */
function reconLabel(s) {
  const status = s.video?.recon?.status;
  if (status === 'running') return '변환 중';
  if (status === 'pending') return '대기';
  if (status === 'failed') return '실패';
  return s.video ? '미변환' : '촬영 없음';
}

/** 3D를 뷰어에 올린다. three·splat 라이브러리(약 1.4MB)는 여기서 처음 받는다. */
async function openScene(s) {
  state.sceneOpen = s.id;
  for (const [id, node] of sceneEls) node.classList.toggle('is-open', id === s.id);
  setText($('sceneStatus'), '3D 현장 불러오는 중…');
  setText($('sceneHint'), `${s.name} · ${fmtClock(s.ts)}`);
  const url = `/incidents/${encodeURIComponent(s.id)}/attachments/${encodeURIComponent(s.splat.attachmentId)}`;
  try {
    const mod = await viewerModule();
    await mod.show($('sceneStage'), url, (text) => setText($('sceneStatus'), text));
    // 다 뜬 뒤에야 안내를 걷는다. 로딩 몇 초 동안은 진행 문구가 보여야 한다.
    $('sceneEmpty').hidden = true;
  } catch (error) {
    state.sceneOpen = null;
    restoreStage(`3D 불러오기 실패 — ${error.message || error}`);
  }
}

/** 등록된 현장 영상을 3D와 같은 자리에서 튼다. 둘을 나란히 두면 좁은 패널이 더 좁아진다. */
async function openVideo(s) {
  if (!s.video) return;
  state.sceneOpen = s.id;
  for (const [id, node] of sceneEls) node.classList.toggle('is-open', id === s.id);
  // 스플랫 뷰어가 떠 있으면 먼저 내린다. 둘이 같은 자리를 쓴다.
  if (viewerLoading) await (await viewerLoading).dispose().catch(() => {});

  const stage = $('sceneStage');
  stage.textContent = '';
  const video = document.createElement('video');
  video.className = 'scene-video';
  video.src = `/incidents/${encodeURIComponent(s.id)}/attachments/${encodeURIComponent(s.video.attachmentId)}`;
  video.controls = true;
  video.playsInline = true;
  video.preload = 'metadata';
  stage.appendChild(video);
  $('sceneEmpty').hidden = true;
}

/** 변환은 관제 화면에서 하지 않는다. 몇십 분짜리 작업이라 경보를 가리면 안 된다. */
function openRecon(s) {
  window.open(`/recon/?incident=${encodeURIComponent(s.id)}`, '_blank', 'noopener');
}

// ── 전체화면 ──────────────────────────────────────────────
//
// 브라우저 전체화면(Fullscreen API)을 안 쓴다. 경보가 오면 자동으로 접어야 하는데
// 사용자 제스처 없이 빠져나오는 것이 브라우저마다 다르게 막히기 때문이다.
//
// 뷰어를 body로 옮기는 이유: 패널의 `backdrop-filter`가 fixed 위치의 기준점을 만들어,
// 패널 안에 둔 채로는 화면 전체를 못 덮는다.

function setFullscreen(on) {
  const frame = $('sceneFrame');
  if (on === frame.classList.contains('is-full')) return;
  frame.classList.toggle('is-full', on);
  $('sceneBackdrop').hidden = !on;
  $('sceneHold').hidden = !on;
  $('sceneFs').setAttribute('aria-label', on ? '전체화면 해제' : '전체화면');
  if (on) document.body.appendChild(frame);
  else $('sceneHold').before(frame);
}

const isFullscreen = () => $('sceneFrame').classList.contains('is-full');

let viewerLoading = null;
const viewerModule = () => (viewerLoading ??= import('./splat-view.js'));

/** 뷰어를 내리고 안내 문구로 되돌린다. 탭을 나갈 때마다 부른다. */
async function closeScene(message) {
  setFullscreen(false);
  if (!state.sceneOpen && !message) return;
  state.sceneOpen = null;
  if (viewerLoading) await (await viewerLoading).dispose().catch(() => {});
  restoreStage(message);
}

function restoreStage(message) {
  $('sceneStage').textContent = '';
  $('sceneEmpty').hidden = false;
  setText($('sceneStatus'), message || '3DGS · 영상 뷰어');
  setText($('sceneHint'), '');
  for (const node of sceneEls.values()) node.classList.remove('is-open');
}

// ── 포커스 ────────────────────────────────────────────────

/**
 * 도면 좌표 하나를 화면 중앙으로 민다. 하단 위치 버튼과 경보 자동 포커스가 같은 길을 쓴다.
 * 이미 그보다 크게 확대해 놓았으면 배율은 건드리지 않는다 — 관제사가 맞춰둔 것을 되돌리지 않는다.
 */
function focusOn(pos) {
  if (!pos) return false;
  const c = planCenter();
  const [bx0, bx1] = state.bounds.x;
  const [by0, by1] = state.bounds.y;
  const bw = bx1 - bx0 || 32;
  const bh = by1 - by0 || 20;
  state.zoom = Math.max(state.zoom, 1.6);
  state.pan = {
    x: (0.5 - (pos.x - bx0) / bw) * c.w,
    y: (0.5 - (by1 - pos.y) / bh) * c.h,
  };
  applyView();
  return true;
}

/** 판정·번복을 서버에 보낸다. 화면 상태는 서버 응답을 받고 나서 바꾼다 — 창 밖이면 409다. */
async function sendOutcome(eventId, outcome) {
  closeModal();
  try {
    const res = await fetch(`/events/${encodeURIComponent(eventId)}/outcome?outcome=${outcome}`, { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      state.demoNote = `정정 불가 — ${body.error || res.status}`;
      // 서버가 막았으면 화면이 틀린 것이다. 기록을 다시 받아 맞춘다.
      return void loadHistory();
    }
    await loadHistory();
  } catch {
    state.demoNote = '서버 연결 실패';
    render();
  }
}

// ── 층 선택 ────────────────────────────────────────────────

const floorEls = new Map();

function buildFloorMenu() {
  const menu = $('floorMenu');
  for (const f of FLOORS) {
    const node = tpl('tplFloor').cloneNode(true);
    node.querySelector('.floormenu-id').textContent = f.id;
    node.querySelector('.floormenu-name').textContent = f.name;
    node.$badge = node.querySelector('.floormenu-badge');
    node.onclick = () => { state.floor = f.id; state.floorsOpen = false; render(); };
    floorEls.set(f.id, node);
    menu.appendChild(node);
  }
}

function renderFloors(online) {
  const cur = FLOORS.find((f) => f.id === state.floor) || FLOORS[0];
  setText($('floorId'), cur.id);
  setText($('floorName'), cur.name);
  setText($('floorMeta'), cur.ready ? `태그 ${state.frames.size} · 연결 ${online}` : '데이터 대기');

  $('floorMenu').hidden = !state.floorsOpen;
  $('floorToggle').setAttribute('aria-expanded', String(state.floorsOpen));
  if (!state.floorsOpen) return;

  for (const f of FLOORS) {
    const node = floorEls.get(f.id);
    const cls = `floormenu-item${f.id === state.floor ? ' is-current' : ''}${f.ready ? '' : ' is-pending'}`;
    if (node.className !== cls) node.className = cls;
    setText(node.$badge, f.ready ? `태그 ${state.frames.size}` : '데이터 대기');
  }
}

// ── 경보 ───────────────────────────────────────────────────

function renderAlert() {
  const a = state.alert;
  $('alertCard').hidden = !a;
  $('zoneAlert').hidden = !(a && a.privacy);   // A-P5: 강조할 마커가 없으면 구역을 강조한다
  if (!a) return;
  setText($('alertHead'), `${a.name || nameOf(a.tagId)} · ${a.zone || '구역 미지정'}`);
  setText($('alertWhere'), a.pos
    ? `(${a.pos.x.toFixed(1)}, ${a.pos.y.toFixed(1)})m`
    : '좌표 미기록 (사생활 구역)');
  setText($('alertPeak'), fmtG(a.peakAccel));
  setText($('alertTime'), fmtClock(a.ts));
}

// ── 전체 렌더 ──────────────────────────────────────────────
// position이 초당 15~30개씩 들어오므로 프레임마다 그리지 않고 다음 화면 갱신에 한 번 몰아 그린다.

let rafId = 0;
function scheduleRender() {
  if (rafId) return;
  rafId = requestAnimationFrame(() => { rafId = 0; render(); });
}

function render() {
  const now = Date.now();
  const list = Array.from(state.frames.values());
  const online = list.filter((f) => !isOffline(f, now)).length;

  renderMarkers(list, now);
  renderRoster(list, now);
  renderEvents();
  renderFloors(online);
  renderAlert();

  setText($('countLabel'), `전체 ${list.length}명`);
  setText($('cOnline'), String(online));
  setText($('cOffline'), String(list.length - online));
  setText($('cEvent'), state.alert ? '1' : '0');
  $('cEventWrap').classList.toggle('is-alarm', !!state.alert);

  $('conn').classList.toggle('is-live', state.live);
  setText($('connLabel'), state.live ? '스트림 연결됨' : '스트림 끊김 · 재연결 중…');
  setText($('sourceLabel'), state.live ? 'LIVE · uwb+imu' : '대기');
  setText($('demoNote'), state.demoNote);

  const app = $('app');
  // 경보 중에는 화면 가장자리가 붉게 뛴다. 관제사가 도면 어디를 보고 있어도 걸린다.
  app.classList.toggle('is-alarming', !!state.alert);
  app.classList.toggle('is-left-collapsed', !state.leftOpen);
  app.classList.toggle('is-right-collapsed', !state.rightOpen);
  $('locate').classList.toggle('is-armed', !!selectedPos());

  $('tabTags').classList.toggle('is-active', state.tab === 'tags');
  $('tabScene').classList.toggle('is-active', state.tab === 'scene');
  $('tabTags').setAttribute('aria-selected', String(state.tab === 'tags'));
  $('tabScene').setAttribute('aria-selected', String(state.tab === 'scene'));
  $('paneTags').hidden = state.tab !== 'tags';
  $('paneScene').hidden = state.tab !== 'scene';
  if (state.tab === 'scene') renderScenes();

  applyView();
}

// ── 서버 연결 ──────────────────────────────────────────────

// 좌표계 범위는 서버가 쥔다(spec 03 §4). 도면과 map.json은 같은 건물이어야 한다 —
// server/public/README.md의 "도면과 map.json은 한 몸이다" 참고.
async function loadMap() {
  try {
    const m = await (await fetch('/map')).json();
    if (m && m.bounds && Array.isArray(m.bounds.x) && Array.isArray(m.bounds.y)) {
      state.bounds = m.bounds;
      scheduleRender();
    }
  } catch { /* 맵을 못 받으면 도면 기본 범위로 계속 간다 */ }
}

// 데모 조작에 쓸 클립과, 지난 사고 기록.
async function loadHistory() {
  try {
    const [clips, tags, history] = await Promise.all([
      fetch('/clips').then((r) => r.json()),
      fetch('/tags').then((r) => r.json()),
      fetch('/events?limit=20').then((r) => r.json()),
    ]);
    // 낙상으로 판정되는 클립을 고른다. 기각 클립(false-alarm)을 주입하면 경보가 안 뜬다.
    const fall = clips.find((c) => ((c.expect && c.expect.events) || []).includes('fall_detected'));
    state.clipId = (fall || clips[0] || {}).id || null;

    for (const tag of tags) roster.set(tag.id, tag.name);
    const named = nameOf;
    // 판정은 서버가 쥔다(spec 11 §3). 화면은 그 값을 그대로 보여줄 뿐이고,
    // 새로고침해도 어제 내린 판정이 그대로 남는다.
    if (Number.isFinite(history.undoWindowMs) && history.undoWindowMs > 0) {
      undoWindowMs = history.undoWindowMs;
    }
    const fromServer = (history.events || []).map((e) => ({
      id: e.eventId, name: named(e.tagId), zone: e.zone, ts: e.ts,
      peakAccel: e.peakAccel, privacy: !e.pos,
      outcome: e.outcome || 'detected',
      resolvedAt: e.resolvedAt,
      purged: Array.isArray(e.purged) && e.purged.includes('track'),
      hasSplat: !!e.hasSplat,
      hasVideo: (e.attachmentCount || 0) > (e.hasSplat ? 1 : 0),
    }));
    // 서버가 이미 아는 건은 낙관적 줄을 버린다. 아직 모르는 건만 얹어 둔다 —
    // 그래야 방금 판정한 줄이 목록에서 깜빡이지 않는다.
    const known = new Set(fromServer.map((e) => e.id));
    for (const id of [...state.freshEvents.keys()]) {
      if (known.has(id)) state.freshEvents.delete(id);
    }
    state.events = [...state.freshEvents.values(), ...fromServer]
      .sort((a, b) => b.ts - a.ts);
    state.eventsDirty = true;
    scheduleRender();
    // 판정이 바뀌면 사건 사본이 생기거나 사라진다. 탭을 보고 있을 때만 다시 받는다.
    if (state.tab === 'scene') loadScenes();
  } catch { /* 기록을 못 받아도 실시간 관제는 계속 돈다 */ }
}

function connect() {
  const es = new EventSource('/stream');
  es.addEventListener('position', (e) => {
    const f = JSON.parse(e.data);
    const prev = state.frames.get(f.tagId) || {};
    state.frames.set(f.tagId, {
      ...prev, ...f,
      name: prev.name || f.name || f.tagId,
      // 프레임은 누적 병합이라 안 실린 필드는 직전 값이 남는다. privacy는 그러면 안 된다 —
      // 화장실에서 나온 프레임에 이 필드가 없으면 마커가 영영 안 돌아온다.
      privacy: f.privacy === true,
      seenAt: Date.now(),
    });
    // 사생활 구역에 들어간 대상을 기다리고 있었다면 지금이 주입할 때다.
    if (f.privacy === true) privacyInject.arrived(f.tagId);
    scheduleRender();
  });
  es.addEventListener('alert', (e) => {
    const a = JSON.parse(e.data);
    state.alert = { ...a, name: nameOf(a.tagId) };
    // 경보 카드는 우측 패널 안에 있다. 접혀 있으면 낙상이 떠도 화면에 아무 일도 안 일어난다 —
    // 놓치면 안 되는 유일한 이벤트라 여기서만 접힌 패널을 강제로 편다.
    // 새 경보가 올 때뿐이다. 경보를 보다가 관제사가 접었다면 그 판단은 그대로 둔다.
    state.rightOpen = true;
    // 크게 띄운 3D가 도면을 덮고 있으면 접는다. 3D는 사고 이후 열람용이라
    // 지금 일어나는 낙상보다 앞설 수 없다(spec system 01 §2.6).
    setFullscreen(false);
    // 쓰러진 대상을 화면 중앙으로 끌어온다. 사생활 구역이면 좌표가 없어 그냥 넘어가고,
    // 그때는 구역 강조(.zone-alert)가 대신 알린다.
    state.selected = a.tagId;
    render();
    focusOn(a.pos);
    // 레코드는 후행 창(10초)이 찬 뒤에야 파일로 닫힌다. 그때 로그를 다시 받아
    // '판정 대기' 줄을 띄운다 — 관제사가 경보 카드를 그냥 닫아도 판정할 자리가 남는다.
    setTimeout(loadHistory, 13000);
  });
  es.onopen = () => { state.live = true; render(); };
  es.onerror = () => { state.live = false; render(); };
}

/**
 * 데모 주입. 데이터셋 클립을 실제 ingest 경로로 흘린다 — 낙상인지 아닌지는 감지기가 정하고
 * 화면은 그 결과를 SSE로 받는다. 이 구분이 무너지면 화면에 뜨는 경보가 감지기 성능과
 * 아무 상관이 없어진다.
 */
function inject(tagId, whenMissing) {
  if (!tagId || !state.clipId) {
    state.demoNote = whenMissing;
    return render();
  }
  state.demoNote = '주입 중…';
  render();
  fetch(`/inject-fall?tagId=${encodeURIComponent(tagId)}&clip=${encodeURIComponent(state.clipId)}`)
    .then((r) => r.json())
    .then((res) => {
      if (!res.ok) throw new Error(res.error || '주입 실패');
      state.demoNote = `${(res.durationMs / 1000).toFixed(1)}초 재생 중`;
      render();
      // 재생이 끝나도 서버는 따로 알려주지 않는다(경보만 SSE로 온다). 길이를 알고 있으니
      // 여기서 재어 끝을 표시한다 — 경보가 안 떴을 때 "끝났다"는 걸 알아야 한다.
      clearTimeout(inject.timer);
      inject.timer = setTimeout(() => {
        // 경보가 뜬 건 카드가 이미 말하고 있다. 안 떴을 때만 이유를 덧붙인다 —
        // 조용히 끝나면 주입이 실패한 건지 감지기가 기각한 건지 알 수 없다.
        state.demoNote = state.alert ? '재생 끝' : '재생 끝 · 감지기가 낙상으로 보지 않았다';
        render();
      }, res.durationMs + 300);
    })
    .catch((err) => { state.demoNote = `주입 실패: ${err.message}`; render(); });
}

/**
 * 사생활 구역 시연. 화장실에 아무도 없으면 먼저 한 명을 들여보내고, 좌표가 지워진 채로
 * 프레임이 오기 시작하면 그때 낙상을 주입한다.
 *
 * 대상이 도착했다는 신호는 SSE 프레임의 `privacy` 하나뿐이다 — 서버가 좌표를 지웠다는 건
 * 그 사람이 구역 안에 있다는 뜻이고, 화면이 알 수 있는 건 거기까지다. 시각으로 재지 않고
 * 이 신호를 기다리는 이유가 그것이다(걷는 속도가 태그마다 다르다).
 */
const privacyInject = {
  waitingFor: null,
  timer: null,
  arrived(tagId) {
    if (this.waitingFor !== tagId) return;
    this.cancel();
    inject(tagId, '');
  },
  cancel() {
    this.waitingFor = null;
    clearTimeout(this.timer);
    this.timer = null;
  },
  send() {
    this.cancel();
    state.demoNote = '대상을 화장실로 보내는 중…';
    render();
    fetch('/demo/privacy-enter', { method: 'POST' })
      .then((r) => r.json())
      .then((res) => {
        if (!res.ok) throw new Error(res.error || '이동 실패');
        this.waitingFor = res.tagId;
        const eta = Math.ceil(res.etaMs / 1000);
        state.demoNote = `${res.name || res.tagId} → ${res.zone} 이동 중 · 약 ${eta}초`;
        render();
        // 벽을 안 세고 잰 직선 거리라 실제로는 더 걸린다. 넉넉히 기다렸다가 포기한다 —
        // 아무 말 없이 멈춰 있으면 버튼이 고장 난 걸로 보인다.
        this.timer = setTimeout(() => {
          this.cancel();
          state.demoNote = '이동이 예상보다 오래 걸린다 — 도착하면 버튼을 다시 누른다';
          render();
        }, res.etaMs * 2 + 20000);
      })
      .catch((err) => { state.demoNote = `이동 실패: ${err.message}`; render(); });
  },
};

// ── 조작 ───────────────────────────────────────────────────

function bind() {
  $('toggleLeft').onclick = () => { state.leftOpen = !state.leftOpen; render(); };
  $('toggleRight').onclick = () => { state.rightOpen = !state.rightOpen; render(); };
  // 탭을 나가면 뷰어를 내린다. 3D는 실시간 관제에 쓰지 않으므로(spec system 01 §2.6)
  // 안 보이는 채로 GPU를 붙잡고 있으면 안 된다.
  $('tabTags').onclick = () => { state.tab = 'tags'; closeScene(); render(); };
  $('tabScene').onclick = () => { state.tab = 'scene'; render(); loadScenes(); };

  $('sceneFs').onclick = () => setFullscreen(!isFullscreen());
  $('sceneBackdrop').onclick = () => setFullscreen(false);
  $('floorToggle').onclick = () => { state.floorsOpen = !state.floorsOpen; render(); };

  // 버튼 확대는 화면 한가운데를 붙잡는다. 커서 위치를 쓰는 휠과 다르다.
  const centerOfView = () => ({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
  $('zoomIn').onclick = () => { const c = centerOfView(); zoomAround(round1(state.zoom + 0.2), c.x, c.y); };
  $('zoomOut').onclick = () => { const c = centerOfView(); zoomAround(round1(state.zoom - 0.2), c.x, c.y); };

  // 선택 인원이 화면 중앙에 오도록 도면을 민다.
  $('locate').onclick = () => focusOn(selectedPos());

  const wrap = $('planwrap');
  const app = $('app');

  // 휠 확대·축소. 커서 밑 지점을 붙잡고 배율만 바꾼다.
  // 전환이 걸린 채로 휠을 굴리면 배율이 손가락을 못 따라오므로 잠깐 꺼둔다.
  let wheelIdle = 0;
  wrap.addEventListener('wheel', (e) => {
    e.preventDefault();
    app.classList.add('is-navigating');
    clearTimeout(wheelIdle);
    wheelIdle = setTimeout(() => app.classList.remove('is-navigating'), 180);
    // 트랙패드는 잘게, 휠은 크게 온다. 지수로 받아 어느 쪽이든 같은 감각으로 움직인다.
    zoomAround(state.zoom * Math.exp(-e.deltaY * 0.0016), e.clientX, e.clientY);
  }, { passive: false });

  // 도면 드래그. translate가 scale 안쪽이라 화면 이동량을 줌으로 나눠야 커서를 따라간다.
  // 여기서는 applyView만 부른다 — 포인터 이벤트마다 목록까지 다시 그리면 프레임이 떨어진다.
  let drag = null;
  wrap.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY, pan: { ...state.pan }, zoom: state.zoom };
    try { wrap.setPointerCapture(e.pointerId); } catch { /* 캡처 불가 환경 */ }
    app.classList.add('is-dragging');
  });
  wrap.addEventListener('pointermove', (e) => {
    if (!drag) return;
    state.pan = {
      x: drag.pan.x + (e.clientX - drag.x) / drag.zoom,
      y: drag.pan.y + (e.clientY - drag.y) / drag.zoom,
    };
    applyView();
  });
  const endDrag = () => { if (!drag) return; drag = null; app.classList.remove('is-dragging'); };
  wrap.addEventListener('pointerup', endDrag);
  wrap.addEventListener('pointercancel', endDrag);

  // 경보를 끝내는 유일한 경로다. 서버에도 알려야 쓰러진 대상이 다시 걷는다.
  //
  // `outcome`이 null이면 **경보만 끄고 판정은 안 남긴다**(우상단 X). 그 건은 판정 대기로
  // 로그에 남고, 24시간 안에 아무도 안 보면 좌표가 파기되며 미판정이 된다
  // (spec operation 02 §3). 판정과 경보 해제는 다른 일이다.
  const resolveWith = (outcome) => {
    const a = state.alert;
    if (!a) return;
    state.alert = null;
    const at = Date.now();
    // 서버가 이 기록을 파일로 닫기까지 10초 남짓 걸린다. 그동안 화면에서 사라지지 않도록
    // 여기 담아 두고, 서버 목록에 나타나면 loadHistory가 알아서 걷어낸다.
    state.freshEvents.set(a.eventId, {
      id: a.eventId, name: a.name || nameOf(a.tagId), zone: a.zone, ts: a.ts,
      peakAccel: a.peakAccel, privacy: !a.pos,
      outcome: outcome || 'detected',
      ...(outcome ? { resolvedAt: at } : {}),
      purged: false, hasSplat: false, hasVideo: false,
    });
    state.events = [...state.freshEvents.values(), ...state.events.filter((e) => e.id !== a.eventId)]
      .sort((x, y) => y.ts - x.ts);
    state.eventsDirty = true;
    render();

    const query = `tagId=${encodeURIComponent(a.tagId)}`
      + `&eventId=${encodeURIComponent(a.eventId || '')}`
      + (outcome ? `&outcome=${outcome}` : '');
    fetch(`/alerts/resolve?${query}`, { method: 'POST' })
      .then(() => {
        // 사건은 서버가 판정 즉시 만든다. 3D 탭을 보고 있으면 바로 반영한다.
        if (state.tab === 'scene') loadScenes();
        // 기록은 후행 창이 찬 뒤에 파일이 된다. 그때 궤적·가속도까지 채워진 값으로 맞춘다.
        setTimeout(loadHistory, 13000);
      })
      .catch(() => { /* 서버가 못 받아도 화면 상태는 이미 종료다 */ });
  };
  $('resolveConfirm').onclick = () => resolveWith('confirmed');
  $('resolveFalse').onclick = () => resolveWith('false_alarm');
  // 판정 없이 경보만 끈다. 이 건은 판정 대기로 로그에 남고, 24시간 안에 아무도 안 보면
  // 좌표가 파기되며 미판정이 된다(spec operation 02 §3).
  $('alertDismiss').onclick = () => resolveWith(null);

  // 로그 필터. 목록만 바뀌므로 서버를 다시 부르지 않는다.
  $('eventFilter').onclick = (e) => {
    const button = e.target.closest('.seg-btn');
    if (!button || button.dataset.filter === state.eventFilter) return;
    state.eventFilter = button.dataset.filter;
    state.eventsDirty = true;
    render();
  };

  // 판정 창. 카드에서 열고 여기서 닫는다.
  $('modalClose').onclick = closeModal;
  // 카드 바깥을 눌러도 닫는다. 카드 안쪽 클릭은 여기까지 안 올라온다.
  $('modal').onclick = (e) => { if (e.target === $('modal')) closeModal(); };
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (state.modal) return closeModal();
    if (isFullscreen()) setFullscreen(false);
  });

  $('injectFall').onclick = () => {
    const now = Date.now();
    const target = Array.from(state.frames.values())
      .find((f) => f.pos && !f.privacy && !isOffline(f, now));
    inject(target && target.tagId, '연결된 대상이 없다');
  };
  $('injectPrivacy').onclick = () => {
    // 좌표가 지워진 채로 오는 대상만 사생활 구역 안에 있다고 볼 수 있다.
    const target = Array.from(state.frames.values()).find((f) => f.privacy);
    // 아무도 없으면 한 명을 들여보내고 도착하면 주입한다. 배경 태그는 통행 구역만
    // 걷게 돼 있어 화장실에 스스로 들어가지 않는다.
    if (!target) return privacyInject.send();
    privacyInject.cancel();
    inject(target.tagId, '');
  };

  // 층 메뉴 바깥을 누르면 닫는다.
  document.addEventListener('pointerdown', (e) => {
    if (!state.floorsOpen) return;
    if (e.target.closest('.floorpick')) return;
    state.floorsOpen = false;
    render();
  });
}

const round1 = (n) => Math.round(n * 10) / 10;

// ── 시작 ───────────────────────────────────────────────────

buildFloorMenu();
bind();
render();

// 1초 틱은 시계뿐 아니라 끊김 판정도 굴린다 — 수신이 멈춘 태그는 아무 이벤트도 오지
// 않으므로, 다시 그려주는 쪽이 없으면 영영 '정상'으로 남는다.
setInterval(() => {
  setText($('clock'), fmtClock(Date.now()));
  render();
}, 1000);
setText($('clock'), fmtClock(Date.now()));

loadMap();
loadHistory();
connect();
