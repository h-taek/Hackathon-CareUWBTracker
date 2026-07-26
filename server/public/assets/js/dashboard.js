import {
  acknowledgeAlert,
  applyAlertEvent,
  createAlertStore,
  dismissAlert,
  finishResolved,
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
  let resolveTimer = null;
  const OFFLINE_MS = 4000;           // 이 시간 넘게 미수신이면 오프라인 표시

  const $ = (id) => document.getElementById(id);
  const round1 = (n) => Math.round(n * 10) / 10;

  // CSS 변수는 시작 시 1회만 읽는다. draw()가 초당 15회 돌기 때문에
  // 프레임마다 getComputedStyle을 부르면 구역 수만큼 레이아웃 비용이 붙는다.
  const CSS_VAR = (() => {
    const s = getComputedStyle(document.documentElement);
    const read = (n) => s.getPropertyValue(n).trim();
    return {
      ok: read('--ok'), sel: read('--sel'), offline: read('--offline'),
      candidate: read('--warning'), confirmed: read('--alarm'),
      mapLine: read('--map-line'), mapInk: read('--map-ink'),
    };
  })();
  const COLOR = () => CSS_VAR;

  // sim/live 페이로드 차이 흡수:
  //   position — sim은 name 포함, live(uwb+imu)는 tagId만
  //   alert    — sim은 ts·name·confidence 포함, live(FallEvent)는 type·tagId·peakAccel·freefall·pos·zone만
  const nameOf = (tagId) => names.get(tagId) || tagId;
  const tsOf = (a) => (typeof a.ts === 'number' ? a.ts : Date.now());
  const errOf = (p) => (p && p.err && typeof p.err.xy === 'number' ? p.err.xy : 0.2);

  function stateOf(tagId) {
    const alert = alertStore.alertsByTag.get(tagId);
    if (alert && alert.resolvedAt === null) return alert.phase;
    const seen = lastSeen.get(tagId);
    if (!seen || Date.now() - seen > OFFLINE_MS) return 'offline';
    if (tagId === selectedTag) return 'sel';
    return 'ok';
  }

  // ── 2D 캔버스 ──
  const cv = $('map');
  const ctx = cv.getContext('2d');
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

  function draw() {
    if (!map) return;
    const C = CSS_VAR;
    ctx.clearRect(0, 0, W, H);
    ctx.lineWidth = 1;
    const fs = isSmall() ? 9 : 12;

    for (const z of map.zones || []) {
      const [rx, ry, rw, rh] = z.rect;
      ctx.strokeStyle = C.mapLine;
      ctx.fillStyle = 'rgba(88,120,170,0.05)';
      ctx.fillRect(mx(rx), my(ry + rh), rw * scale, rh * scale);
      ctx.strokeRect(mx(rx), my(ry + rh), rw * scale, rh * scale);
      ctx.fillStyle = C.mapInk; ctx.font = fs + 'px sans-serif';
      ctx.fillText(z.label, mx(rx) + 5, my(ry + rh) + fs + 3);
    }
    for (const h of map.hazards || []) {
      const [rx, ry, rw, rh] = h.rect;
      ctx.strokeStyle = 'rgba(210,153,34,0.75)';
      ctx.fillStyle = 'rgba(210,153,34,0.10)';
      ctx.fillRect(mx(rx), my(ry + rh), rw * scale, rh * scale);
      ctx.strokeRect(mx(rx), my(ry + rh), rw * scale, rh * scale);
    }
    for (const [id, t] of tags) {
      if (!t.pos) continue;
      const px = mx(t.pos.x), py = my(t.pos.y);
      const st = stateOf(id), c = C[st], rd = isSmall() ? 5 : 7;
      ctx.beginPath(); ctx.arc(px, py, errOf(t) * scale, 0, Math.PI * 2);
      const isAlert = st === 'candidate' || st === 'confirmed';
      ctx.fillStyle = rgba(c, isAlert ? 0.20 : 0.16); ctx.fill();
      ctx.beginPath(); ctx.arc(px, py, rd, 0, Math.PI * 2);
      ctx.fillStyle = c; ctx.fill();
      if (isAlert) { ctx.strokeStyle = c; ctx.lineWidth = 2; ctx.stroke(); }
      if (!isSmall()) {
        ctx.fillStyle = C.mapInk; ctx.font = 'bold 12px sans-serif';
        ctx.fillText(nameOf(id), px + 11, py + 4);
      }
    }
  }
  function rgba(hex, a) {
    const n = parseInt(String(hex).replace('#', ''), 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  // ── 좌측 태그 목록 ──
  function renderRooms() {
    const box = $('f1Rooms');
    if (tags.size === 0) { box.innerHTML = '<span class="empty">태그 대기 중…</span>'; return; }
    box.textContent = '';
    let online = 0;
    for (const [id, t] of tags) {
      const st = stateOf(id);
      if (st !== 'offline') online++;
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'room';
      const dot = document.createElement('i');
      dot.className = 'rdot'; dot.style.background = COLOR()[st];
      b.appendChild(dot);
      const zone = t.pos && map ? zoneAt(t.pos.x, t.pos.y) : '—';
      b.appendChild(document.createTextNode(nameOf(id) + ' · ' + zone));
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

  const phaseCopy = {
    candidate: { icon: '⚠️', label: '낙상 후보', message: '확인이 필요합니다' },
    confirmed: { icon: '🚨', label: '낙상 확진', message: '즉시 확인이 필요합니다' },
    canceled: { icon: '✓', label: '후보 해제', message: '움직임이 감지되어 자동 해제됐습니다' },
  };
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

    clearResolveTimer();
    if (result.change === 'activated') onAlertActivated(result.alert);
    if (result.change === 'updated') onAlertUpdated(result.alert);
    if (result.change === 'resolved') onAlertResolved(result.alert);
    renderAlertState(result.change !== 'resolved');
    if (alertStore.view === 'resolved') scheduleIdle(result.alert.tagId);
  }

  function renderAlertState(showPopup = false) {
    const alert = getActiveAlert(alertStore);
    const pill = $('statePill');
    pill.classList.remove('alerting', 'candidate', 'confirmed', 'resolved');
    pill.classList.add(alertStore.view);
    pill.textContent = alertStore.view + (alertStore.view === 'alerting' ? ' · 확인 필요' : '');

    if (!alert) {
      overlay.classList.remove('on');
      close3d();
      draw();
      renderRooms();
      return;
    }

    const resolved = alertStore.view === 'resolved';
    const copy = resolved
      ? {
          icon: '✓',
          label: '경보 해제',
          message: alert.resolution === 'auto_canceled'
            ? '움직임이 감지되어 자동 해제됐습니다'
            : '이 화면에서 경보를 닫았습니다',
        }
      : phaseCopy[alert.phase];
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
    $('popAck').textContent = alert.acknowledgedAt ? '확인됨' : '확인함';
    $('popAck').disabled = alert.acknowledgedAt !== null || alertStore.view === 'resolved';
    $('popDismiss').textContent = alertStore.view === 'resolved' ? '해제됨' : '화면에서 닫기';
    $('popDismiss').disabled = alertStore.view === 'resolved';
    $('popup').dataset.phase = resolved ? 'canceled' : alert.phase;
    overlay.dataset.phase = resolved ? 'canceled' : alert.phase;
    $('bannerTitle').firstChild.textContent = 'f1 · ' + zone + ' · ' + who;
    $('bannerSub').textContent = copy.label + ' · ' + details;
    $('scene3dWho').textContent = who + ' · ' + copy.label;
    upsertAlertLog(alert);

    if (showPopup || alertStore.view === 'resolved') overlay.classList.add('on');
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
      row.onclick = () => {
        selectedTag = alert.tagId;
        alertStore.activeTagId = alert.tagId;
        renderAlertState(false);
      };
      box.prepend(row);
    }
    box.querySelectorAll('.logrow.active').forEach((r) => r.classList.remove('active'));
    row.className = 'logrow fall ' + alert.phase
      + (alert.resolvedAt === null ? ' active' : ' cleared');
    row.querySelector('.who').textContent = nameOf(alert.tagId);
    row.querySelector('.desc').textContent = zoneOf(alert) + ' · ' + phaseCopy[alert.phase].label
      + ' · ' + new Date(alert.updatedAt).toLocaleTimeString('ko-KR')
      + (alert.acknowledgedAt ? ' · 확인됨' : '');
    updateLogCount();
  }

  function updateLogCount() {
    const n = document.querySelectorAll('#log .logrow').length;
    $('logCount').textContent = n ? n + '건' : '';
    $('cntEvt').textContent = String(n);
  }

  function clearResolveTimer() {
    if (resolveTimer !== null) clearTimeout(resolveTimer);
    resolveTimer = null;
  }
  function scheduleIdle(tagId) {
    clearResolveTimer();
    resolveTimer = setTimeout(() => {
      if (finishResolved(alertStore, tagId)) renderAlertState(false);
      resolveTimer = null;
    }, 3000);
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
  $('popAck').onclick = () => {
    const alert = getActiveAlert(alertStore);
    if (alert && acknowledgeAlert(alertStore, alert.tagId)) renderAlertState(false);
  };
  function dismissCurrentAlert() {
    const alert = getActiveAlert(alertStore);
    if (!alert || !dismissAlert(alertStore, alert.tagId)) return;
    onAlertResolved(alert);
    renderAlertState(false);
    if (alertStore.view === 'resolved') scheduleIdle(alert.tagId);
  }
  $('popDismiss').onclick = dismissCurrentAlert;
  $('popClose').onclick = () => overlay.classList.remove('on');
  overlay.onclick = (e) => { if (e.target === overlay) overlay.classList.remove('on'); };
  $('bannerClose').onclick = dismissCurrentAlert;
  $('navToggle').onclick = () => { $('shell').classList.toggle('nav-collapsed'); requestAnimationFrame(resize); };
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

  // 표시명 보강: live position에는 name이 없다.
  fetch('/tags').then((r) => r.json()).then((list) => {
    for (const t of list) names.set(t.id, t.name);
    // 낙상 주입 버튼(데모 트리거). 각본은 옆 드롭다운이 정한다 — 클릭 한 번에
    // 후보부터 확진(또는 해제)까지 서버가 순서대로 흘려준다.
    const bar = $('demobar');
    for (const t of list) {
      const b = document.createElement('button');
      b.className = 'btn'; b.type = 'button'; b.textContent = t.name;
      b.onclick = () => fetch('/inject-fall?tagId=' + encodeURIComponent(t.id)
        + '&scenario=' + encodeURIComponent($('fallScenario').value));
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
