// 관제사 관문 — 보호된 화면(관제·태그 관리)이 쓰는 가드(spec operation 03 §7).
//
// **세션이 없으면 화면을 열지 않는다.** 뜨자마자 `/operator`로 돌려보낸다. 화면 안에서
// 고르게 하지 않는 이유는 하나다 — 관제 화면의 모든 동작이 "누가 했는지"를 남기는데,
// 그 값이 정해지기 전에 화면이 먼저 열려 있으면 순서가 뒤집힌다.
//
// **만료는 다르게 다룬다.** 이미 관제 중인 화면을 말없이 걷어내면 그 순간 SSE가 끊기고
// 그 사이의 경보를 못 받는다. 그래서 만료되면 팝업으로 막고 두 갈래를 준다 —
// `연장`은 같은 사람으로 세션을 다시 열어 **화면을 떠나지 않는다**(SSE가 살아 있다).
// `관제사 변경`은 관문으로 나간다. 팝업이 떠 있는 동안 뒤 화면은 눌리지 않는다.

/** 관문 주소. 태그 관리는 관제 화면에서만 넘어가므로 돌아갈 곳은 늘 여기다. */
const GATE_URL = '/operator';

const state = {
  /** `{ id, name }` 또는 null. */
  operator: null,
  expiresAt: null,
  /**
   * 만료 직전에 앉아 있던 사람. **`연장`이 쓸 유일한 단서다** — 만료된 세션은 서버에서
   * 이미 지워졌고 쿠키도 죽은 값이라, 누구였는지는 화면만 알고 있다.
   */
  last: null,
};

let ui = null;
let expiryTimer = null;

/** 지금 화면 앞에 앉은 관제사. 없으면 null. */
export function currentOperator() {
  return state.operator;
}

/**
 * 쓰기 동작 앞에 둔다. 세션이 끊겼으면 만료 팝업을 띄우고 `false`를 준다.
 *
 * 서버 게이트(401)만 믿으면 안 되는 자리가 있다 — 경보 해제는 화면이 먼저 경보를 지우고
 * 서버에 알리기 때문에, 거절당하면 화면에서만 사라진 경보가 서버에 남는다.
 */
export function requireOperator() {
  if (state.operator) return true;
  expire();
  return false;
}

/**
 * 응답이 401이면 만료 팝업을 띄운다. **타이머가 밀렸을 때의 백스톱이다** — 탭을 오래
 * 재우면 만료 시각에 걸어 둔 타이머가 제때 안 깨어난다.
 */
export function guard(res) {
  if (res && res.status === 401) expire();
  return res;
}

/** 관문으로 나간다. 뒤로 가기로 되돌아오지 못하게 replace를 쓴다. */
function toGate() {
  location.replace(GATE_URL);
}

/** 세션이 끝났다. 상단바를 바꾸고 팝업으로 막는다. */
function expire() {
  if (state.operator) state.last = state.operator;
  state.operator = null;
  state.expiresAt = null;
  clearTimeout(expiryTimer);
  render();
  if (!ui || !ui.expired.hidden) return;
  ui.expired.hidden = false;
  ui.renew.disabled = !state.last;
  say('');
  ui.renew.focus();
}

function say(text) {
  if (ui) ui.note.textContent = text || '';
}

function render() {
  if (!ui) return;
  ui.chip.hidden = false;
  ui.name.textContent = state.operator ? state.operator.name : '관제사 미선택';
  ui.chip.classList.toggle('is-none', !state.operator);
}

/**
 * 만료 시각에 스스로 깨어난다.
 *
 * 이게 없으면 관제사가 세 시간 동안 가만히 있다가 판정 버튼을 눌러야 튕긴다 — 그동안
 * 상단바에는 이미 만료된 사람 이름이 떠 있다.
 */
function scheduleExpiry() {
  clearTimeout(expiryTimer);
  if (!state.expiresAt) return;
  expiryTimer = setTimeout(expire, Math.max(0, state.expiresAt - Date.now()));
}

/** 서버에 지금 상태를 다시 묻고 화면을 맞춘다. */
async function sync() {
  const data = await fetch('/session').then((r) => r.json());
  state.operator = data.operator || null;
  state.expiresAt = data.expiresAt || null;
  if (state.operator) state.last = state.operator;
  render();
  scheduleExpiry();
  return state.operator;
}

/** 같은 사람으로 세션을 다시 연다. 화면을 떠나지 않으므로 SSE가 안 끊긴다. */
async function renew() {
  if (!state.last) return toGate();
  ui.renew.disabled = true;
  say('');
  try {
    const query = new URLSearchParams({ operatorId: state.last.id, renew: '1' });
    const res = await fetch(`/session?${query}`, { method: 'POST' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      // 그 사이에 명부에서 내려간 경우다. 여기서는 더 할 수 있는 게 없다.
      say(`${body.error || '연장하지 못했다'} · 관제사를 다시 고른다.`);
      return;
    }
    await sync();
    ui.expired.hidden = true;
  } catch {
    say('서버에 닿지 못했다. 다시 누른다.');
  } finally {
    ui.renew.disabled = false;
  }
}

/** 관제사 변경. 세션을 닫고 관문으로 나간다 — 이름표를 남기지 않는다. */
async function switchOperator() {
  await fetch('/session', { method: 'DELETE' }).catch(() => {});
  toGate();
}

function build() {
  const chip = document.getElementById('opChip');
  if (!chip) return null; // 이 화면에는 상단바 자리가 없다

  const expired = document.createElement('div');
  expired.className = 'op-expired';
  expired.hidden = true;
  // 뒤 화면을 덮고 클릭을 먹는다. 만료된 상태로 판정을 누를 수 있으면 팝업의 의미가 없다.
  expired.innerHTML = `
    <div class="op-expired-card" role="alertdialog" aria-labelledby="opExpiredText">
      <p class="op-expired-text" id="opExpiredText">세션이 만료되었습니다. 관제사를 선택해주세요.</p>
      <div class="op-expired-acts">
        <button class="op-expired-alt" id="opExpiredSwitch" type="button">관제사 변경</button>
        <button class="op-expired-go" id="opExpiredRenew" type="button">연장</button>
      </div>
      <p class="op-expired-note" id="opExpiredNote"></p>
    </div>`;
  document.body.append(expired);

  return {
    chip,
    expired,
    name: document.getElementById('opName'),
    switch: document.getElementById('opSwitch'),
    renew: document.getElementById('opExpiredRenew'),
    altSwitch: document.getElementById('opExpiredSwitch'),
    note: document.getElementById('opExpiredNote'),
  };
}

/** 화면이 뜰 때 한 번 부른다. 세션이 없으면 이 함수가 화면을 관문으로 넘긴다. */
export async function initOperatorGate() {
  ui = build();
  if (!ui) return;

  ui.switch.onclick = switchOperator;
  ui.altSwitch.onclick = switchOperator;
  ui.renew.onclick = renew;

  try {
    if (!await sync()) toGate();
  } catch {
    // 서버가 죽었으면 관문으로 보내 봐야 거기서도 못 받는다. 화면은 그대로 두고
    // 다음 조작에서 401 백스톱이 잡는다.
  }
}
