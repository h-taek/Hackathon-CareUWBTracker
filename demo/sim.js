'use strict';

// 시뮬 측위 스트림 생성기.
// spec 03 스키마(측위 좌표 1절 / 낙상 경보 2절)를 그대로 방출한다.
// 측위 소스가 sim일 뿐, 서버/대시보드 입장에서는 실측 UWB와 구분되지 않는다(source 필드로만 구분).

const { EventEmitter } = require('events');
const { zoneAt } = require('./lib/zone');

const G = 9.81; // 1g, m/s^2

function rand(min, max) {
  return min + Math.random() * (max - min);
}

class Simulator extends EventEmitter {
  constructor(map) {
    super();
    this.map = map;
    this.bounds = map.bounds;
    this.timer = null;
    this.seq = 0;

    // 가짜 입주자 태그. 각자 맵 안을 완만히 배회한다.
    const [x0, x1] = this.bounds.x;
    const [y0, y1] = this.bounds.y;
    this.tags = [
      { id: 'tag-101', name: '김OO' },
      { id: 'tag-102', name: '이OO' },
      { id: 'tag-103', name: '박OO' },
    ].map((t) => ({
      ...t,
      x: rand(x0 + 1, x1 - 1),
      y: rand(y0 + 1, y1 - 1),
      // 목표 지점을 향해 걷다가 도착하면 새 목표를 뽑는 웨이포인트 방식.
      tx: rand(x0 + 1, x1 - 1),
      ty: rand(y0 + 1, y1 - 1),
      speed: rand(0.4, 0.9), // m/s, 노인 보행 속도대
      fallen: false, // 낙상 후 정지 상태
      fallTimer: 0,
    }));
  }

  // (x,y) 미터 좌표가 속한 구역 라벨.
  zoneAt(x, y) {
    return zoneAt(this.map, x, y);
  }

  step(dt) {
    const [x0, x1] = this.bounds.x;
    const [y0, y1] = this.bounds.y;
    const now = Date.now();

    for (const tag of this.tags) {
      let accel = { x: 0, y: 0, z: G }; // 정지·보행 시 대략 중력 1g + 소량 노이즈

      if (tag.fallen) {
        // 낙상 후에는 그 자리에서 정지(움직임 없음).
        tag.fallTimer -= dt;
        if (tag.fallTimer <= 0) tag.fallen = false; // 일정 시간 후 회복(데모 반복용)
      } else {
        // 목표를 향해 한 걸음.
        const dx = tag.tx - tag.x;
        const dy = tag.ty - tag.y;
        const dist = Math.hypot(dx, dy);
        if (dist < 0.3) {
          // 도착 -> 새 목표.
          tag.tx = rand(x0 + 1, x1 - 1);
          tag.ty = rand(y0 + 1, y1 - 1);
        } else {
          const stepLen = tag.speed * dt;
          tag.x += (dx / dist) * stepLen;
          tag.y += (dy / dist) * stepLen;
        }
        // 걸음 흔들림을 가속도에 실어줌(실측 IMU 노이즈 모사).
        accel.x += rand(-0.8, 0.8);
        accel.y += rand(-0.8, 0.8);
        accel.z += rand(-0.6, 0.6);
      }

      // 경계 클램프.
      tag.x = Math.max(x0 + 0.2, Math.min(x1 - 0.2, tag.x));
      tag.y = Math.max(y0 + 0.2, Math.min(y1 - 0.2, tag.y));

      const payload = {
        tagId: tag.id,
        name: tag.name,
        ts: now,
        pos: { x: round(tag.x), y: round(tag.y), z: 1.0 },
        err: { xy: 0.2, z: 1.2 }, // UWB 전형 오차(리서치 6-3): z가 xy보다 훨씬 큼
        accel: { x: round(accel.x), y: round(accel.y), z: round(accel.z) },
        source: 'sim',
      };
      this.emit('position', payload);
    }
  }

  // 낙상 주입 -> spec 03 2절 경보 스키마 발행.
  injectFall(tagId) {
    const tag = this.tags.find((t) => t.id === tagId) || this.tags[0];
    tag.fallen = true;
    tag.fallTimer = 8; // 8초간 정지(데모 후 자동 회복)

    const alert = {
      eventId: `evt-${++this.seq}-${Date.now()}`,
      tagId: tag.id,
      name: tag.name,
      type: 'fall_candidate',
      ts: Date.now(),
      trigger: 'imu_accel',
      freefall: false,
      peakAccel: round(rand(2.8, 4.2)), // 충격 피크(g)
      pos: { x: round(tag.x), y: round(tag.y), z: 1.0 },
      confidence: 'candidate',
      zone: this.zoneAt(tag.x, tag.y),
    };
    this.emit('alert', alert);
    return alert;
  }

  start(hz = 5) {
    if (this.timer) return;
    const dt = 1 / hz;
    this.timer = setInterval(() => this.step(dt), 1000 / hz);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

function round(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { Simulator };
