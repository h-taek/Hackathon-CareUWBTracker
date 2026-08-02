import {
  applyAlertEvent,
  createAlertStore,
  dismissAlert,
  getActiveAlert,
} from './alert-state.js';

// 실시간 관제 대시보드(F1·F2). /map·/tags로 초기화하고 /stream(SSE)을 구독한다.
(function () {
  'use strict';

  // ── 상태 ──
  let map = null;                    // /map 응답
  const tags = new Map();            // tagId -> 최신 position payload
  const lastSeen = new Map();        // tagId -> 마지막 수신 시각(ms). 오프라인 판정용
  const names = new Map();           // tagId -> 표시명. live position에는 name이 없어 /tags로 보강
  let selectedTag = null;            // 사용자가 목록에서 고른 태그
  const alertStore = createAlertStore();
  let bannerHidden = false;          // 배너 ✕로 접었는가. 새 경보 갱신이 오면 다시 편다
  const OFFLINE_MS = 4000;           // 이 시간 넘게 미수신이면 오프라인 표시

  const $ = (id) => document.getElementById(id);
  const round1 = (n) => Math.round(n * 10) / 10;

  // CSS 변수는 시작 시 1회만 읽는다. paint()가 마커 이동 중 60fps로 돌기 때문에
  // 프레임마다 getComputedStyle을 부르면 구역 수만큼 레이아웃 비용이 붙는다.
  const CSS_VAR = (() => {
    const s = getComputedStyle(document.documentElement);
    const read = (n) => s.getPropertyValue(n).trim();
    return {
      ok: read('--ok'), sel: read('--sel'), offline: read('--offline'),
      alert: read('--alarm'),
      mapLine: read('--map-line'), mapInk: read('--map-ink'),
    };
  })();
  const COLOR = () => CSS_VAR;

  // 페이로드 차이 흡수:
  //   position — 시뮬 배경 태그는 name 포함, ingest(uwb+imu)를 거친 것은 tagId만
  //   alert    — 전부 감지기(FallEvent)가 낸다. name이 없으므로 /tags로 보강한다
  const nameOf = (tagId) => names.get(tagId) || tagId;
  const tsOf = (a) => (typeof a.ts === 'number' ? a.ts : Date.now());
  const errOf = (p) => (p && p.err && typeof p.err.xy === 'number' ? p.err.xy : 0.2);

  function stateOf(tagId) {
    const alert = alertStore.alertsByTag.get(tagId);
    if (alert && alert.resolvedAt === null) return 'alert';
    const seen = lastSeen.get(tagId);
    if (!seen || Date.now() - seen > OFFLINE_MS) return 'offline';
    if (tagId === selectedTag) return 'sel';
    return 'ok';
  }

  // ── 2D 캔버스 ──
  const cv = $('map');
  const ctx = cv.getContext('2d');
  const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let scale = 1, W = 0, H = 0, PAD = 24;

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const r = cv.parentElement.getBoundingClientRect();
    W = r.width; H = r.height;
    if (W < 2 || H < 2 || !map) return;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    PAD = Math.max(10, Math.min(24, W * 0.03));
    const [bx0, bx1] = map.bounds.x, [by0, by1] = map.bounds.y;
    scale = Math.min((W - PAD * 2) / (bx1 - bx0), (H - PAD * 2) / (by1 - by0));
    draw();
  }
  const mx = (x) => PAD + x * scale;
  const my = (y) => H - PAD - y * scale;
  const isSmall = () => W < 380;

  function paint(now = performance.now()) {
    if (!map) return;
    const C = CSS_VAR;
    ctx.clearRect(0, 0, W, H);
    ctx.lineWidth = 1;

    // 웅진관 실사 도면이 방 구획과 라벨을 이미 담고 있다. map.json의 프록시 구역은
    // zoneAt() 판정에는 계속 쓰되, 화면에 다시 그려 도면과 겹치지 않게 한다.
    for (const [id, t] of tags) {
      if (!t.pos) continue;
      const v = view.get(id) || t.pos;      // 서버 좌표가 아니라 보간 중인 화면 좌표를 그린다
      const px = mx(v.x), py = my(v.y);
      const st = stateOf(id), c = C[st], rd = isSmall() ? 5 : 7;

      // 오차 반경은 채움과 실선 경계를 함께 써서 마커 본체와 분리한다.
      ctx.beginPath(); ctx.arc(px, py, errOf(t) * scale, 0, Math.PI * 2);
      const isAlert = st === 'alert';
      ctx.fillStyle = rgba(c, isAlert ? 0.16 : 0.10); ctx.fill();
      ctx.strokeStyle = rgba(c, isAlert ? 0.62 : 0.34); ctx.lineWidth = 1; ctx.stroke();

      if (isAlert && !REDUCED_MOTION) {
        const pulse = (Math.sin(now / 230) + 1) / 2;
        ctx.beginPath(); ctx.arc(px, py, rd + 6 + pulse * 8, 0, Math.PI * 2);
        ctx.strokeStyle = rgba(c, 0.54 - pulse * 0.34); ctx.lineWidth = 2; ctx.stroke();
      }

      ctx.beginPath(); ctx.arc(px, py, rd, 0, Math.PI * 2);
      ctx.fillStyle = c; ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();

      // 색을 보지 못해도 형태로 상태를 구분한다: 선택=이중 원, 오프라인=빗금, 경보=느낌표.
      if (st === 'sel') {
        ctx.beginPath(); ctx.arc(px, py, rd + 4, 0, Math.PI * 2);
        ctx.strokeStyle = c; ctx.lineWidth = 2; ctx.stroke();
      } else if (st === 'offline') {
        ctx.beginPath(); ctx.moveTo(px - 3, py + 3); ctx.lineTo(px + 3, py - 3);
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.8; ctx.stroke();
      } else if (isAlert) {
        ctx.fillStyle = '#fff'; ctx.font = '800 ' + (isSmall() ? 8 : 10) + 'px sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('!', px, py + .5);
      }
      if (!isSmall()) {
        const label = nameOf(id);
        ctx.font = '700 12px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
        const labelW = Math.ceil(ctx.measureText(label).width);
        ctx.fillStyle = 'rgba(255,255,255,.90)'; ctx.fillRect(px + 11, py - 10, labelW + 10, 20);
        ctx.fillStyle = isAlert ? c : C.mapInk; ctx.fillText(label, px + 16, py + 4);
      }
    }
  }
  function rgba(hex, a) {
    const n = parseInt(String(hex).replace('#', ''), 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  // ── 마커 이동 보간 ──
  // 좌표는 10Hz로 들어온다. 그때마다 마커를 그 자리로 옮기면 초당 10번 순간이동해서, 서버에서
  // 남은 오차가 '진동'으로 보인다. 들어온 좌표는 목표로만 두고 화면 좌표를 60fps로 끌어당긴다 —
  // 노이즈가 사라지는 게 아니라, 튀는 대신 흐르는 움직임으로 보이게 하는 것이다.
  const view = new Map();            // tagId -> 현재 화면 좌표 {x, y}
  const SMOOTH_TAU_MS = 200;         // 목표까지 따라붙는 시간상수. 키우면 부드럽지만 굼떠진다
  const SETTLED_M = 0.005;           // 이보다 가까우면 도착으로 보고 루프를 멈춘다
  let rafId = 0;
  let lastFrameAt = 0;

  // 목표 쪽으로 한 프레임만큼 당긴다. 아직 도착 못 한 태그가 하나라도 있으면 true.
  function stepView(now) {
    // 프레임 간격 기준이라 모니터 주사율이 달라도 같은 속도로 따라간다. 탭이 백그라운드에
    // 있다 돌아오면 dt가 크게 튀므로 100ms에서 자른다.
    const dt = Math.min(100, Math.max(0, now - lastFrameAt));
    const k = 1 - Math.exp(-dt / SMOOTH_TAU_MS);
    let animating = false;
    for (const [id, t] of tags) {
      if (!t.pos) continue;
      const v = view.get(id);
      if (!v) { view.set(id, { x: t.pos.x, y: t.pos.y }); continue; }  // 새 태그는 제자리에서 시작
      const dx = t.pos.x - v.x, dy = t.pos.y - v.y;
      if (Math.abs(dx) < SETTLED_M && Math.abs(dy) < SETTLED_M) { v.x = t.pos.x; v.y = t.pos.y; continue; }
      v.x += dx * k; v.y += dy * k;
      animating = true;
    }
    return animating;
  }

  function tick(now) {
    const animating = stepView(now);
    lastFrameAt = now;
    paint(now);
    const pulsing = alertStore.view === 'alerting' && !REDUCED_MOTION;
    rafId = (animating || pulsing) ? requestAnimationFrame(tick) : 0;
  }

  // 기존 호출부는 그대로 draw()를 쓴다. 즉시 한 번 그리고, 아직 움직일 게 남았으면 루프를 잇는다.
  function draw() {
    if (rafId) return;               // 루프가 이미 돌고 있으면 다음 프레임에 반영된다
    lastFrameAt = performance.now();
    rafId = requestAnimationFrame(tick);
  }

  // ── 좌측 태그 목록 ──
  function renderRooms() {
    const box = $('f1Rooms');
    if (tags.size === 0) { box.innerHTML = '<span class="empty">태그 대기 중…</span>'; return; }
    box.textContent = '';
    let online = 0;
    const stateLabel = { alert: '낙상 감지', sel: '선택됨', offline: '오프라인', ok: '정상' };
    const stateRank = { alert: 0, sel: 1, ok: 2, offline: 3 };
    const entries = Array.from(tags.entries()).sort(([a], [b]) => {
      const rank = stateRank[stateOf(a)] - stateRank[stateOf(b)];
      return rank || nameOf(a).localeCompare(nameOf(b), 'ko');
    });
    for (const [id, t] of entries) {
      const st = stateOf(id);
      if (st !== 'offline') online++;
      const b = document.createElement('button');
      const selected = id === selectedTag;
      b.type = 'button';
      b.className = 'room state-' + st + (selected ? ' selected' : '');
      b.setAttribute('aria-pressed', String(selected));
      b.setAttribute('aria-label', nameOf(id) + ', ' + stateLabel[st]);
      const dot = document.createElement('i');
      dot.className = 'rdot'; dot.style.background = COLOR()[st];
      dot.setAttribute('aria-hidden', 'true');
      b.appendChild(dot);
      const zone = t.pos && map ? zoneAt(t.pos.x, t.pos.y) : '—';
      const main = document.createElement('span'); main.className = 'room-main';
      const who = document.createElement('span'); who.className = 'room-name'; who.textContent = nameOf(id);
      const where = document.createElement('span'); where.className = 'room-zone'; where.textContent = zone;
      main.appendChild(who); main.appendChild(where);
      const status = document.createElement('span'); status.className = 'room-state'; status.textContent = stateLabel[st];
      b.appendChild(main); b.appendChild(status);
      b.onclick = () => { selectedTag = (selectedTag === id ? null : id); renderRooms(); draw(); };
      box.appendChild(b);
    }
    $('f1Count').textContent = '환자 ' + tags.size + '명';
    $('f1Badge').textContent = '연결 ' + online + '명';
    $('cntOk').textContent = String(online);
    $('cntOff').textContent = String(tags.size - online);
  }

  function zoneAt(x, y) {
    for (const z of (map.zones || [])) {
      const [rx, ry, rw, rh] = z.rect;
      if (x >= rx && x <= rx + rw && y >= ry && y <= ry + rh) return z.label;
    }
    return '미지정';
  }

  // ── 경보 처리 (spec 03 §2·§3) ──
  const overlay = $('overlay');
  const viewport = $('viewport');

  // 경보는 한 종류다. 감지기가 충격을 잡고 AI가 낙상으로 통과시킨 순간 이 문구가 뜬다.
  const ALERT_COPY = { icon: '🚨', label: '낙상 감지', message: '즉시 확인이 필요합니다' };
  const finite = (value, suffix = '') => Number.isFinite(value) ? round1(value) + suffix : '—';
  const whereOf = (alert) => alert.pos
    ? '(' + round1(alert.pos.x) + ', ' + round1(alert.pos.y) + ')m'
    : '위치 미상';
  const zoneOf = (alert) => alert.zone || '구역 미지정';

  // 경보 lifecycle → 3D 패널. 패널이 아직 안 열렸으면 위치만 기억해뒀다가 열 때 반영한다.
  // 화면 텍스트(scene3dWho 포함)는 renderAlertState가 단독으로 쥔다 — 여기서는 위치만 다룬다.
  function onAlertActivated(alert) { focus3d(alert); }
  function onAlertUpdated(alert) { focus3d(alert); }
  function onAlertResolved() {
    alertPos = null;
    if (scene3d) scene3d.clearFocus();
  }

  function focus3d(alert) {
    alertPos = (alert && alert.pos) || null;
    if (scene3d) scene3d.focus(alertPos);
  }

  function onAlert(event) {
    if (event && event.name) names.set(event.tagId, event.name);
    const result = applyAlertEvent(alertStore, event);
    if (result.change === 'ignored') {
      if (result.reason === 'invalid_event') console.warn('[alert] 알 수 없는 경보 이벤트', event);
      return;
    }

    bannerHidden = false;            // 새 소식이 왔으면 접어둔 배너를 다시 편다
    if (result.change === 'activated') onAlertActivated(result.alert);
    if (result.change === 'updated') onAlertUpdated(result.alert);
    renderAlertState(true);
  }

  function renderAlertState(showPopup = false) {
    const alert = getActiveAlert(alertStore);
    const pill = $('statePill');
    pill.classList.remove('alerting');
    pill.classList.add(alertStore.view);
    pill.textContent = alertStore.view + (alertStore.view === 'alerting' ? ' · 확인 필요' : '');

    if (!alert) {
      overlay.classList.remove('on');
      viewport.classList.remove('banner-off');
      close3d();
      draw();
      renderRooms();
      return;
    }

    const copy = ALERT_COPY;
    const who = nameOf(alert.tagId);
    const zone = zoneOf(alert);
    const where = whereOf(alert);
    const details = where + ' · 충격 ' + finite(alert.peakAccel, 'g')
      + ' · 자유낙하 ' + (alert.freefall === null ? '—' : alert.freefall ? '감지' : '미감지')
      + (alert.aiScore === null ? '' : ' · AI ' + finite(alert.aiScore));

    $('popIcon').textContent = copy.icon;
    $('popKind').textContent = copy.label + ' — ' + copy.message;
    $('popWho').textContent = 'f1 · ' + zone + ' · ' + who;
    $('popWhere').textContent = details;
    $('popTime').textContent = new Date(alert.updatedAt).toLocaleTimeString('ko-KR');
    $('bannerTitle').firstChild.textContent = 'f1 · ' + zone + ' · ' + who;
    $('bannerSub').textContent = copy.label + ' · ' + details;
    $('scene3dWho').textContent = who + ' · ' + copy.label;
    viewport.classList.toggle('banner-off', bannerHidden);
    upsertAlertLog(alert);

    if (showPopup) overlay.classList.add('on');
    draw();
    renderRooms();
  }

  function upsertAlertLog(alert) {
    const box = $('log');
    const first = box.querySelector('.empty');
    if (first) box.textContent = '';
    let row = box.querySelector('.logrow[data-tag="' + CSS.escape(alert.tagId) + '"]');
    if (!row) {
      row = document.createElement('div');
      row.dataset.tag = alert.tagId;
      const fl = document.createElement('span'); fl.className = 'fl'; fl.textContent = 'f1';
      const mid = document.createElement('span');
      const who = document.createElement('div'); who.className = 'who';
      const desc = document.createElement('div'); desc.className = 'desc';
      mid.appendChild(who); mid.appendChild(desc);
      const x = document.createElement('button'); x.className = 'x'; x.type = 'button'; x.textContent = '✕';
      x.setAttribute('aria-label', '로그 삭제');
      x.onclick = (e) => {
        e.stopPropagation();
        row.remove();
        if (!box.querySelector('.logrow')) box.innerHTML = '<span class="empty">아직 경보 없음</span>';
        updateLogCount();
      };
      row.appendChild(fl); row.appendChild(mid); row.appendChild(x);
      // 로그를 누르면 팝업을 다시 연다. ✕로 접은 뒤 되돌아올 길이 이것뿐이다.
      row.onclick = () => {
        selectedTag = alert.tagId;
        const target = alertStore.alertsByTag.get(alert.tagId);
        const live = !!target && target.resolvedAt === null;
        if (live) alertStore.activeTagId = alert.tagId;
        renderAlertState(live);
      };
      box.prepend(row);
    }
    box.querySelectorAll('.logrow.active').forEach((r) => r.classList.remove('active'));
    row.className = 'logrow fall' + (alert.resolvedAt === null ? ' active' : ' cleared');
    row.querySelector('.who').textContent = nameOf(alert.tagId);
    row.querySelector('.desc').textContent = zoneOf(alert) + ' · ' + ALERT_COPY.label
      + ' · ' + new Date(alert.updatedAt).toLocaleTimeString('ko-KR')
      + (alert.resolvedAt ? ' · 종료됨' : '');
    updateLogCount();
  }

  function updateLogCount() {
    const n = document.querySelectorAll('#log .logrow').length;
    $('logCount').textContent = n ? n + '건' : '';
    $('cntEvt').textContent = String(n);
  }


  // ── 3D 패널 (F3) ──
  // scene3d는 three·gaussian-splats-3d를 쓰는 무거운 모듈이라 동적 import로 분리한다.
  // 정적 import로 걸면 vendor 1.4MB를 다 받기 전까지 2D 관제가 시작되지 않는다.
  // 유휴 시간에 미리 당겨오되, 뷰어 생성·씬 로드는 패널이 실제로 열릴 때 한다
  // (숨겨진 요소는 크기가 0이라 렌더러가 0×0으로 뜬다).
  let scene3d = null;
  let scene3dLoading = null;
  let scene3dFailed = false;
  let alertPos = null;                 // 마지막 경보 위치(맵 좌표 m)

  const setScene3dStatus = (text) => { $('scene3dStatus').textContent = text; };

  function importScene3d() {
    if (!scene3dLoading) scene3dLoading = import('./scene3d.js');
    return scene3dLoading;
  }

  async function mountScene3d() {
    if (scene3dFailed || !map) return;
    try {
      scene3d = scene3d || (await importScene3d());
      await scene3d.open($('scene3dStage'), map, setScene3dStatus);
      scene3d.focus(alertPos);
    } catch (error) {
      scene3dFailed = true;            // 씬 파일이 없거나 뷰어가 못 뜬 경우. 상태 문구는 모듈이 남긴다
      if (!$('scene3dStatus').textContent) setScene3dStatus('3D 실사 뷰를 띄우지 못했다.');
      console.error('[scene3d]', error);
    }
  }

  function open3d() {
    overlay.classList.remove('on');
    viewport.classList.add('three-on');
    $('viewMode').textContent = '3D 실사 뷰 · 2D 미니맵';
    requestAnimationFrame(resize);
    mountScene3d();                    // 패널이 보이는 상태여야 렌더러 크기가 잡힌다
  }
  function close3d() {
    viewport.classList.remove('three-on');
    $('viewMode').textContent = '2D 개요';
    requestAnimationFrame(resize);
    if (scene3d) scene3d.close();      // 안 보이는 동안 GPU를 놀린다
  }

  $('popView3d').onclick = open3d;
  // 경보를 끝내는 유일한 버튼. ✕들은 전부 "감추기"라서 이것과 헷갈리면 안 된다.
  function endCurrentAlert() {
    const alert = getActiveAlert(alertStore);
    if (!alert || !dismissAlert(alertStore, alert.tagId)) return;
    onAlertResolved(alert);
    overlay.classList.remove('on');
    bannerHidden = false;
    // 로그를 먼저 닫는다. 마지막 경보였다면 renderAlertState가 활성 경보 없음으로
    // 조기 반환해 여기까지 못 온다 — 그러면 로그가 '진행 중'인 채로 굳는다.
    upsertAlertLog(alert);
    renderAlertState(false);
  }
  $('popDismiss').onclick = endCurrentAlert;
  $('popClose').onclick = () => overlay.classList.remove('on');
  overlay.onclick = (e) => { if (e.target === overlay) overlay.classList.remove('on'); };
  $('bannerClose').onclick = () => {
    bannerHidden = true;
    viewport.classList.add('banner-off');
  };
  $('navToggle').setAttribute('aria-expanded', 'true');
  $('navToggle').onclick = () => {
    const collapsed = $('shell').classList.toggle('nav-collapsed');
    document.body.classList.toggle('nav-collapsed', collapsed);
    $('navToggle').setAttribute('aria-expanded', String(!collapsed));
    $('navToggle').setAttribute('aria-label', collapsed ? '왼쪽 패널 펼치기' : '왼쪽 패널 접기');
    $('navToggle').textContent = collapsed ? '›' : '‹';
    requestAnimationFrame(resize);
  };
  $('logToggle').onclick = () => {
    const collapsed = document.body.classList.toggle('right-panel-collapsed');
    $('logToggle').setAttribute('aria-expanded', String(!collapsed));
    $('logToggle').setAttribute('aria-label', collapsed ? '알림 패널 펼치기' : '알림 패널 접기');
    $('logToggle').textContent = collapsed ? '‹' : '›';
    requestAnimationFrame(resize);
  };
  document.querySelectorAll('.floor .fhead').forEach((h) => h.addEventListener('click', () => {
    const f = h.closest('.floor');
    if (!f.classList.contains('pending')) f.toggleAttribute('open');
  }));

  // ── 서버 연결 ──
  fetch('/map').then((r) => r.json()).then((m) => {
    map = m;
    const labels = (m.zones || []).map((z) => z.label);
    $('f1Range').textContent = labels.length ? labels[0] + '~' + labels[labels.length - 1] : (m.name || '맵');
    $('floorRange').textContent = '· ' + (m.name || '실시간 관제');
    resize();
  });

  // ── 데모 주입 ──
  // 버튼을 누르면 서버가 데이터셋 클립을 ingest 프레임으로 되돌려 실제 파이프라인에
  // 흘린다. 경보가 뜰지 말지는 감지기가 정하므로 여기서 결과를 예고하지 않는다.
  const clipsById = new Map();
  let clipTimer = null;

  const setClipStatus = (html, active) => {
    const el = $('clipStatus');
    el.innerHTML = html;
    el.classList.toggle('on', !!active);
  };

  function injectClip(tag) {
    const clip = clipsById.get($('clipPick').value);
    if (!clip) return;
    const src = clip.source;
    const origin = src.dataset + ' ' + src.activity + '/' + src.trial + ' · ' + src.placement;

    fetch('/inject-fall?tagId=' + encodeURIComponent(tag.id) + '&clip=' + encodeURIComponent(clip.id))
      .then((r) => r.json())
      .then((res) => {
        if (!res.ok) throw new Error(res.error || '주입 실패');
        clearTimeout(clipTimer);
        setClipStatus('<b>' + esc(tag.name) + '</b> ← ' + esc(clip.label)
          + ' 재생 중 · ' + (res.durationMs / 1000).toFixed(1) + '초 · ' + res.frames + '프레임'
          + ' <span class="src">(' + esc(origin) + ')</span>', true);
        // 재생이 끝나도 서버는 따로 알려주지 않는다(경보만 SSE로 온다). 길이를 알고 있으니
        // 여기서 재어 끝을 표시한다 — 경보가 안 뜬 경우에도 "끝났다"는 걸 알아야 한다.
        clipTimer = setTimeout(() => {
          setClipStatus('재생 끝 · ' + esc(clip.label) + '. 경보가 안 떴다면 감지기가 낙상이 아니라고 판정한 것이다.', false);
        }, res.durationMs + 300);
      })
      .catch((error) => setClipStatus('주입 실패: ' + esc(error.message), false));
  }

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  fetch('/clips').then((r) => r.json()).then((list) => {
    const pick = $('clipPick');
    for (const clip of list) {
      clipsById.set(clip.id, clip);
      const option = document.createElement('option');
      option.value = clip.id;
      option.textContent = clip.label + ' · ' + (clip.durationMs / 1000).toFixed(1) + '초';
      option.title = clip.summary;
      pick.appendChild(option);
    }
    const first = list[0];
    if (first) setClipStatus(esc(first.summary), false);
    pick.onchange = () => {
      const clip = clipsById.get(pick.value);
      if (clip) setClipStatus(esc(clip.summary), false);
    };
  }).catch(() => {});

  // 표시명 보강: live position에는 name이 없다.
  fetch('/tags').then((r) => r.json()).then((list) => {
    for (const t of list) names.set(t.id, t.name);
    const bar = $('demobar');
    for (const t of list) {
      const b = document.createElement('button');
      b.className = 'btn'; b.type = 'button'; b.textContent = t.name;
      b.onclick = () => injectClip(t);
      bar.appendChild(b);
    }
    renderRooms();
  }).catch(() => {});

  const es = new EventSource('/stream');
  es.onopen = () => { $('conn').classList.add('live'); $('connText').textContent = '스트림 연결됨'; };
  es.onerror = () => { $('conn').classList.remove('live'); $('connText').textContent = '재연결 중…'; };

  es.addEventListener('position', (e) => {
    const p = JSON.parse(e.data);
    if (p.name) names.set(p.tagId, p.name);
    tags.set(p.tagId, p);
    lastSeen.set(p.tagId, Date.now());
    draw();
  });

  es.addEventListener('alert', (e) => onAlert(JSON.parse(e.data)));

  // 3D 뷰어 모듈(three + 스플랫 뷰어, 약 1.4MB)을 유휴 시간에 미리 받아둔다.
  const preload = () => importScene3d().catch(() => {});
  if (typeof requestIdleCallback === 'function') requestIdleCallback(preload, { timeout: 5000 });
  else setTimeout(preload, 3000);

  // 오프라인 판정·목록 갱신 주기
  setInterval(() => { renderRooms(); draw(); }, 1000);
  window.addEventListener('resize', resize);
  resize();
})();
