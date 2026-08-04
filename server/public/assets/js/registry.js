// 태그 등록·반납 화면. 서버 명부(/tags/all)를 그리고 등록·반납을 요청한다.
//
// **판단은 전부 서버가 한다.** 이 화면은 명부를 보여주고 두 버튼을 누를 뿐이라,
// 수집을 켜고 끄는 실제 스위치는 서버의 명부 하나다(server/tags/registry.ts).
// 화면에서만 감추는 방식으로는 위치정보법 제24조②의 "기술적 수단"이 되지 않는다.

import { initOperatorGate, requireOperator, guard } from './operator.js';

const $ = (id) => document.getElementById(id);

const pad2 = (n) => String(n).padStart(2, '0');
/** 등록·반납 시각. 날짜까지 보여준다 — 어제 반납한 건과 방금 반납한 건이 섞인다. */
const fmtStamp = (ms) => {
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

let busy = false;

function say(text, bad = false) {
  const note = $('note');
  note.textContent = text;
  note.classList.toggle('is-bad', bad);
}

function render(tags) {
  const box = $('rows');
  const active = tags.filter((t) => t.releasedAt == null);
  $('count').textContent = tags.length === 0
    ? '등록된 태그 없음'
    : `수집 중 ${active.length} · 반납 ${tags.length - active.length}`;

  if (tags.length === 0) {
    box.innerHTML = '<div class="empty">등록된 태그가 없다. 위에서 배정한다.</div>';
    return;
  }

  box.replaceChildren(...tags.map((t) => {
    const on = t.releasedAt == null;
    const row = document.createElement('div');
    row.className = `row ${on ? 'is-on' : 'is-off'}`;

    const name = document.createElement('div');
    name.className = 'row-name';
    name.append(
      Object.assign(document.createElement('span'), { textContent: t.label }),
      Object.assign(document.createElement('span'), { className: 'row-id', textContent: t.tagId }),
    );

    const right = document.createElement('div');
    right.style.display = 'flex';
    right.style.alignItems = 'center';
    right.style.gap = '10px';
    right.append(Object.assign(document.createElement('span'), {
      className: 'pill', textContent: on ? '수집 중' : '반납됨',
    }));
    if (on) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'act act-danger';
      button.textContent = '반납';
      button.onclick = () => release(t);
      right.append(button);
    }

    const meta = document.createElement('div');
    meta.className = 'row-meta';
    meta.textContent = on
      ? `${fmtStamp(t.registeredAt)} 등록 · ${t.registeredBy}`
      : `${fmtStamp(t.registeredAt)} 등록 → ${fmtStamp(t.releasedAt)} 반납 · 수집 중단`;

    row.append(name, right, meta);
    return row;
  }));
}

/**
 * 문을 두드리는 미등록 태그. 신호가 잡힐 때만 패널이 나타난다.
 *
 * UWB에는 가입 승인 절차가 없어서 태그는 허락 없이 신호를 보내기 시작한다 —
 * 승인하는 자리가 명부이고, 승인하려면 먼저 누가 두드리는지 보여야 한다.
 */
function renderPending(list) {
  $('pendingPanel').hidden = list.length === 0;
  if (list.length === 0) return;

  $('pendingRows').replaceChildren(...list.map((s) => {
    const row = document.createElement('div');
    row.className = 'row is-new';

    const name = document.createElement('div');
    name.className = 'row-name';
    name.append(Object.assign(document.createElement('span'), { textContent: s.tagId }));

    const right = document.createElement('div');
    right.style.display = 'flex';
    right.style.alignItems = 'center';
    right.style.gap = '10px';
    right.append(Object.assign(document.createElement('span'), {
      className: 'pill', textContent: '미등록',
    }));
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'act act-primary';
    button.textContent = '배정';
    button.onclick = () => {
      // 아래 폼을 이 태그로 채우고 이름 칸에 커서를 둔다. 등록 자체는 같은 길을 쓴다.
      $('tagId').value = s.tagId;
      $('label').value = '';
      $('label').focus();
      say(`${s.tagId}에 붙일 표시명을 적는다.`);
    };
    right.append(button);

    const meta = document.createElement('div');
    meta.className = 'row-meta';
    meta.textContent = `${fmtStamp(s.firstSeenAt)}부터 신호 · 프레임 ${s.frames}개를 받지 않고 버렸다`;

    row.append(name, right, meta);
    return row;
  }));
}

async function load() {
  try {
    const { tags, pending } = await fetch('/tags/all').then((r) => r.json());
    render(tags || []);
    renderPending(pending || []);
  } catch {
    $('rows').innerHTML = '<div class="empty">명부를 불러오지 못했다. 서버가 떠 있는지 확인한다.</div>';
  }
}

/**
 * 등록·반납은 **관제사를 고른 뒤에만** 된다(spec operation 03 §4). 서버도 401로 막지만,
 * 화면이 먼저 걸러야 "왜 안 되는지"를 그 자리에서 보여줄 수 있다.
 */
async function post(path, params) {
  if (!requireOperator()) throw new Error('먼저 관제사를 고른다');
  const query = new URLSearchParams(params).toString();
  const res = guard(await fetch(`${path}?${query}`, { method: 'POST' }));
  const body = await res.json().catch(() => ({}));
  if (!body.ok) throw new Error(body.error || '요청 실패');
  return body;
}

async function register() {
  if (busy) return;
  const tagId = $('tagId').value.trim();
  const label = $('label').value.trim();
  if (!tagId || !label) return say('태그 번호와 표시명을 모두 적는다.', true);

  busy = true;
  $('register').disabled = true;
  try {
    await post('/tags/register', { tagId, label });
    $('tagId').value = '';
    $('label').value = '';
    say(`${label} 등록. 지금부터 이 태그의 위치를 수집한다.`);
    await load();
  } catch (err) {
    say(`등록 실패: ${err.message}`, true);
  } finally {
    busy = false;
    $('register').disabled = false;
  }
}

async function release(tag) {
  // 반납은 되돌릴 수 없다 — 다시 쓰려면 새로 등록해야 하고 그건 새 배정이다.
  // 확인자료에 남는 시각이 달라지므로 한 번 묻는다.
  if (!confirm(`${tag.label}(${tag.tagId}) 태그를 반납한다.\n\n`
    + '이 순간부터 이 태그의 위치는 수집되지 않는다. 관제 화면에서도 내려간다.')) return;
  try {
    await post('/tags/release', { tagId: tag.tagId });
    say(`${tag.label} 반납. 수집을 중단했다.`);
    await load();
  } catch (err) {
    say(`반납 실패: ${err.message}`, true);
  }
}

initOperatorGate();

$('register').onclick = register;
for (const id of ['tagId', 'label']) {
  $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') register(); });
}
load();

// 태그는 아무 때나 켜진다. 새로고침을 눌러야 보인다면 "켜면 나타난다"가 성립하지 않는다.
// 입력 중에는 건너뛴다 — 적고 있는 표시명이 다시 그려지며 날아가면 안 된다.
setInterval(() => {
  if (busy) return;
  if (document.activeElement === $('tagId') || document.activeElement === $('label')) return;
  load();
}, 3000);
