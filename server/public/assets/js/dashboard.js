// 실시간 관제 대시보드(F1). /map·/tags로 초기화하고 /stream(SSE)을 구독한다.
(function () {
  'use strict';

  // ── 상태 ──
  let map = null;                    // /map 응답
  const tags = new Map();            // tagId -> 최신 position payload
  const lastSeen = new Map();        // tagId -> 마지막 수신 시각(ms). 오프라인 판정용
  const names = new Map();           // tagId -> 표시명. live position에는 name이 없어 /tags로 보강
  let selectedTag = null;            // 사용자가 목록에서 고른 태그
  let alertingTag = null;            // 현재 경보 중인 태그
  let alertCount = 0;
  const OFFLINE_MS = 4000;           // 이 시간 넘게 미수신이면 오프라인 표시

  const $ = (id) => document.getElementById(id);
  const round1 = (n) => Math.round(n * 10) / 10;

  // CSS 변수는 시작 시 1회만 읽는다. draw()가 초당 15회 돌기 때문에
  // 프레임마다 getComputedStyle을 부르면 구역 수만큼 레이아웃 비용이 붙는다.
  const CSS_VAR = (() => {
    const s = getComputedStyle(document.documentElement);
    const read = (n) => s.getPropertyValue(n).trim();
    return {
      ok: read('--ok'), sel: read('--sel'), offline: read('--offline'), fall: read('--alarm'),
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
    if (tagId === alertingTag) return 'fall';
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
      const c = C[stateOf(id)], rd = isSmall() ? 5 : 7;
      ctx.beginPath(); ctx.arc(px, py, errOf(t) * scale, 0, Math.PI * 2);
      ctx.fillStyle = rgba(c, id === alertingTag ? 0.20 : 0.16); ctx.fill();
      ctx.beginPath(); ctx.arc(px, py, rd, 0, Math.PI * 2);
      ctx.fillStyle = c; ctx.fill();
      if (id === alertingTag) { ctx.strokeStyle = c; ctx.lineWidth = 2; ctx.stroke(); }
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

  function labelOf(type) {
    if (type === 'fall_confirmed') return '낙상 확진';
    if (type === 'fall_canceled') return '낙상 해제';
    return '낙상 후보';
  }

  function onAlert(a) {
    if (a.name) names.set(a.tagId, a.name);          // sim은 name을 실어 보냄
    if (a.type === 'fall_canceled') { clearAlert(a); return; }

    alertingTag = a.tagId;
    alertPos = a.pos || null;
    alertCount++;
    setState('alerting');
    if (scene3d) scene3d.focus(alertPos);   // 이미 열려 있으면 새 위치로 옮긴다

    const who = nameOf(a.tagId);
    const where = a.pos ? '(' + round1(a.pos.x) + ', ' + round1(a.pos.y) + ')m' : '위치 미상';
    const zone = a.zone || (a.pos && map ? zoneAt(a.pos.x, a.pos.y) : '미지정');
    const kind = labelOf(a.type);
    const ai = (typeof a.aiScore === 'number') ? ' · AI ' + a.aiScore : '';

    $('popKind').textContent = kind + ' 감지';
    $('popWho').textContent = 'f1 · ' + zone + ' · ' + who;
    $('popWhere').textContent = where + ' · 피크 ' + a.peakAccel + 'g' + ai;
    $('bannerTitle').firstChild.textContent = 'f1 · ' + zone + ' · ' + who;
    $('bannerSub').textContent = kind + ' · 피크 ' + a.peakAccel + 'g · ' + where;
    $('scene3dWho').textContent = who + ' · ' + kind;

    logAlert(a, kind, zone, where);
    overlay.classList.add('on');
    draw();
  }

  function clearAlert(a) {
    if (alertingTag !== a.tagId) return;
    alertingTag = null;
    alertPos = null;
    if (scene3d) scene3d.clearFocus();
    setState('idle');
    close3d();
    overlay.classList.remove('on');
    markLogCleared(a.tagId);
    draw();
    renderRooms();
  }

  function setState(s) {
    const pill = $('statePill');
    if (s === 'alerting') { pill.textContent = 'alerting (3D)'; pill.classList.add('alerting'); }
    else { pill.textContent = 'idle (2D)'; pill.classList.remove('alerting'); }
  }

  function logAlert(a, kind, zone, where) {
    const box = $('log');
    const first = box.querySelector('.empty');
    if (first) box.textContent = '';
    const row = document.createElement('div');
    row.className = 'logrow fall active';
    row.dataset.tag = a.tagId;
    box.querySelectorAll('.logrow.active').forEach((r) => r.classList.remove('active'));

    const fl = document.createElement('span'); fl.className = 'fl'; fl.textContent = 'f1';
    const mid = document.createElement('span');
    const who = document.createElement('div'); who.className = 'who'; who.textContent = nameOf(a.tagId);
    const desc = document.createElement('div'); desc.className = 'desc';
    desc.textContent = zone + ' · ' + kind + ' · ' + new Date(tsOf(a)).toLocaleTimeString('ko-KR');
    mid.appendChild(who); mid.appendChild(desc);
    const x = document.createElement('button'); x.className = 'x'; x.type = 'button'; x.textContent = '✕';
    x.onclick = (e) => { e.stopPropagation(); row.remove(); if (!box.querySelector('.logrow')) box.innerHTML = '<span class="empty">아직 경보 없음</span>'; updateLogCount(); };

    row.appendChild(fl); row.appendChild(mid); row.appendChild(x);
    row.onclick = () => { selectedTag = a.tagId; open3d(); renderRooms(); draw(); };
    box.prepend(row);
    updateLogCount();
  }
  function markLogCleared(tagId) {
    document.querySelectorAll('.logrow[data-tag="' + CSS.escape(tagId) + '"]').forEach((r) => {
      r.classList.remove('active'); r.classList.add('cleared');
    });
  }
  function updateLogCount() {
    const n = document.querySelectorAll('#log .logrow').length;
    $('logCount').textContent = n ? n + '건' : '';
    $('cntEvt').textContent = String(n);
  }

  // ── 3D 패널 (F3) ──
  // scene3d는 three·gaussian-splats-3d를 쓰는 ESM이라 동적 import로 불러온다.
  // 첫 열기 때 1.4MB 뷰어 + 수십 MB 스플랫을 받으므로, 2D 대시보드 초기화를 막지 않도록
  // 페이지 로드 시가 아니라 유휴 시간에 미리 당겨온다.
  let scene3d = null;
  let scene3dLoading = null;
  let scene3dFailed = false;
  let alertPos = null;                 // 마지막 경보 위치(맵 좌표 m)

  const setScene3dStatus = (text) => { $('scene3dStatus').textContent = text; };

  function importScene3d() {
    if (!scene3dLoading) scene3dLoading = import('/assets/js/scene3d.js');
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
    if (scene3d) scene3d.close();
  }

  $('popView3d').onclick = open3d;
  $('popDismiss').onclick = () => overlay.classList.remove('on');
  $('popClose').onclick = () => overlay.classList.remove('on');
  overlay.onclick = (e) => { if (e.target === overlay) overlay.classList.remove('on'); };
  $('bannerClose').onclick = () => {
    close3d();
    alertingTag = null; alertPos = null;
    if (scene3d) scene3d.clearFocus();
    setState('idle'); draw(); renderRooms();
  };
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
    // 낙상 주입 버튼(데모 트리거)
    const bar = $('demobar');
    for (const t of list) {
      const b = document.createElement('button');
      b.className = 'btn'; b.type = 'button'; b.textContent = t.name;
      b.onclick = () => fetch('/inject-fall?tagId=' + encodeURIComponent(t.id));
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
  // 뷰어 생성·씬 로드는 패널이 실제로 열릴 때 한다 — 숨겨진 요소는 크기가 0이라 렌더러가 0×0으로 뜬다.
  const preload = () => importScene3d().catch(() => {});
  if (typeof requestIdleCallback === 'function') requestIdleCallback(preload, { timeout: 5000 });
  else setTimeout(preload, 3000);

  // 오프라인 판정·목록 갱신 주기
  setInterval(() => { renderRooms(); draw(); }, 1000);
  window.addEventListener('resize', resize);
  resize();
})();
