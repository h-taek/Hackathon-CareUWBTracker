'use strict';

// 2단계 캐스케이드 감지기 = 1단계 고전 상태머신(고민감도) → 2단계 AI 정밀판정(헛경보 청소).
// research 02 하이브리드 / 04 §3. 1단계가 fall_candidate를 내면, 그 순간의 충격 윈도우를
// AI(LightGBM)로 즉석 채점(즉시 근사 판정)해 낙상이 아니면 candidate를 기각하고 고전 상태를
// IDLE로 되돌려 후속 fall_confirmed까지 차단한다.
//
// "즉시 근사": candidate 시점엔 정점 이후 샘플이 아직 안 쌓였다. 링버퍼(최근 WINDOW개)로
// 부분 창을 만들어 extractWindow가 가장자리 복제로 채운다 → 지연 0, 대신 정확도는 약간 손해.
// (정석은 정점 뒤 ~1.5s 지연 판정. 배포 시 지연 허용되면 그쪽이 더 정확 — 미래 과제.)

const { createFallDetector } = require('./fall');
const { WINDOW, featureVector } = require('./features');
const { createModel } = require('./lgbm');

const DEFAULT_GRAVITY = 9.80665;

// options: 고전 옵션 전체 + { model, aiThreshold, aiEnabled, gravity }
//   model: createModel() 인스턴스 또는 JSON/경로(미지정 시 동봉 model-lgbm.json 로드)
//   aiThreshold: 이 확률 미만이면 candidate 기각(기본 model.threshold)
//   aiEnabled: false면 순수 고전과 동일(A/B용)
function createCascadeDetector(options = {}) {
  const classical = createFallDetector(options);
  const gravity = options.gravity || DEFAULT_GRAVITY;
  const aiEnabled = options.aiEnabled !== false;

  let model = null;
  if (aiEnabled) {
    model = (options.model && typeof options.model.proba === 'function')
      ? options.model : createModel(options.model);
  }
  const threshold = options.aiThreshold != null
    ? options.aiThreshold : (model ? model.threshold : 0.5);

  const buffers = new Map(); // tagId -> {ax:[],ay:[],az:[]} (g 단위, 최근 WINDOW개)

  function push(tagId, axg, ayg, azg) {
    let b = buffers.get(tagId);
    if (!b) { b = { ax: [], ay: [], az: [] }; buffers.set(tagId, b); }
    b.ax.push(axg); b.ay.push(ayg); b.az.push(azg);
    if (b.ax.length > WINDOW) { b.ax.shift(); b.ay.shift(); b.az.shift(); }
    return b;
  }

  function scoreBuffer(b) {
    const vec = featureVector(b.ax, b.ay, b.az);
    return model.proba(vec);
  }

  function observe(payload, position) {
    const a = payload.accel || {};
    // features는 g 단위 입력. payload.accel은 m/s² → gravity로 나눠 g로.
    const b = push(payload.tagId, (a.x || 0) / gravity, (a.y || 0) / gravity, (a.z || 0) / gravity);

    const events = classical.observe(payload, position);
    if (!aiEnabled || events.length === 0) return events;

    const out = [];
    for (const e of events) {
      if (e.type === 'fall_candidate') {
        const score = scoreBuffer(b);
        e.aiScore = Math.round(score * 1000) / 1000;
        if (score < threshold) {
          // AI 기각: candidate 미전파 + 고전 상태 리셋(후속 confirmed 차단).
          classical.reset(payload.tagId);
          continue;
        }
      }
      out.push(e);
    }
    return out;
  }

  return { observe, reset: (tagId) => classical.reset(tagId) };
}

module.exports = { createCascadeDetector };
