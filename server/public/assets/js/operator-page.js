// 관문 페이지 — 관제사를 고르고 명부를 고친다(spec operation 03 §7).
//
// **여기를 지나야 관제 화면과 태그 관리 화면이 열린다.** 두 화면은 뜨자마자 세션을 확인하고,
// 없으면 이 주소로 돌려보낸다(operator.js).
//
// 명부 수정은 세션 없이도 된다 — 처음에는 아무도 명부에 없어서, 식별을 요구하면 첫 실행에서
// 누구도 들어갈 수 없다. 그 대신 서버가 그 행위를 `unidentified`로 확인자료에 남긴다.

/** 고르고 나면 여기로 간다. 태그 관리는 관제 화면에서만 넘어간다. */
const CONSOLE_URL = '/';

const $ = (id) => document.getElementById(id);

const state = {
  roster: [],
  /** 지금 고른 관제사 ID. 없으면 null. */
  picked: null,
};

/** 실패했을 때만 쓴다. 성공은 화면이 바뀌는 것으로 이미 보인다. */
function say(text) {
  $('note').textContent = text || '';
}

async function post(path, params) {
  const query = new URLSearchParams(params).toString();
  const res = await fetch(`${path}?${query}`, { method: 'POST' });
  return { ok: res.ok, body: await res.json().catch(() => ({})) };
}

function render() {
  const box = $('roster');

  if (state.roster.length === 0) {
    box.replaceChildren(Object.assign(document.createElement('div'), {
      className: 'op-empty',
      textContent: '등록된 관제사가 없다.',
    }));
    $('enter').disabled = true;
    return;
  }

  box.replaceChildren(...state.roster.map((op) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `op-row${op.id === state.picked ? ' is-picked' : ''}`;
    row.onclick = () => { state.picked = op.id; render(); say(''); };

    const mark = document.createElement('span');
    mark.className = 'op-row-mark';

    const name = document.createElement('span');
    name.className = 'op-row-name';
    name.textContent = op.name;

    // 확인자료에 남는 것은 이름이 아니라 이 값이다. 그래서 고를 때 같이 보여준다.
    const id = document.createElement('span');
    id.className = 'op-row-id';
    id.textContent = op.id;

    const del = document.createElement('span');
    del.className = 'op-row-del';
    del.textContent = '삭제';
    del.onclick = (e) => { e.stopPropagation(); removeOperator(op); };

    row.append(mark, name, id, del);
    return row;
  }));

  $('enter').disabled = state.picked === null;
}

async function load() {
  try {
    const data = await fetch('/session').then((r) => r.json());
    state.roster = data.roster || [];
    // 이미 세션이 있는 채로 들어왔으면(교대 교체) 그 사람에 표시를 둔다.
    const current = data.operator?.id ?? null;
    if (state.picked === null || !state.roster.some((op) => op.id === state.picked)) {
      state.picked = state.roster.some((op) => op.id === current) ? current : null;
    }
  } catch {
    return say('서버에 닿지 못했다.');
  }
  render();
}

async function enter() {
  if (state.picked === null) return say('관제사를 고른다.');
  const { ok, body } = await post('/session', { operatorId: state.picked });
  if (!ok) {
    await load();
    return say(body.error || '선택하지 못했다.');
  }
  // replace다 — 뒤로 가기로 관문을 건너뛰는 인상을 주지 않는다.
  location.replace(CONSOLE_URL);
}

async function add() {
  const name = $('name').value.trim();
  if (!name) return say('이름을 적는다.');
  const { ok, body } = await post('/operators/add', { name });
  if (!ok) return say(body.error || '추가하지 못했다.');
  $('name').value = '';
  // 방금 넣은 사람을 바로 고른 상태로 둔다 — 추가한 이유가 그것이다.
  state.picked = body.operator?.id ?? null;
  await load();
}

/**
 * 명부에서 지운다. **파일에서 지우는 것이 아니다** — 확인자료에 이미 그 ID로 찍힌 줄이
 * 있어서, 항목을 실제로 없애면 그 ID가 누구였는지 영영 확인할 수 없다.
 */
async function removeOperator(op) {
  if (!confirm(`${op.name}(${op.id})를 삭제하시겠습니까?`)) return;
  const { ok, body } = await post('/operators/remove', { operatorId: op.id });
  if (!ok) return say(body.error || '지우지 못했다.');
  if (state.picked === op.id) state.picked = null;
  await load();
}

$('enter').onclick = enter;
$('add').onclick = add;
$('name').addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });

load();
