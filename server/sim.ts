// 시뮬 측위 스트림 생성기.
// spec 03 스키마(측위 좌표 1절 / 낙상 경보 2절)를 그대로 방출한다.
// 측위 소스가 sim일 뿐, 서버/대시보드 입장에서는 실측 UWB와 구분되지 않는다(source 필드로만 구분).

import { EventEmitter } from 'node:events';
import { zoneAt, type ZoneMap } from './lib/zone.ts';

const G = 9.81; // 1g, m/s^2

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

export interface SimTag {
  id: string;
  name: string;
}

interface SimTagState extends SimTag {
  x: number;
  y: number;
  tx: number;
  ty: number;
  speed: number;
  fallen: boolean;
  fallTimer: number;
}

export interface SimMap extends ZoneMap {
  bounds: { x: [number, number]; y: [number, number] };
}

export interface SimAlert {
  eventId: string;
  tagId: string;
  name: string;
  type: string;
  ts: number;
  trigger: string;
  freefall: boolean;
  peakAccel: number;
  pos: { x: number; y: number; z: number };
  confidence: string;
  zone: string;
}

// 데모 각본. 실제 감지기는 후보를 낸 뒤 무동작이 이어지면 확진, 도중 움직이면 해제한다
// (04 §3). 주입 버튼은 감지기를 거치지 않으므로 그 흐름을 여기서 대신 재생한다.
export type FallScenario = 'confirm' | 'cancel';

// 확진까지 5초는 감지기 기본값 immobilityMs와 같은 값이다(detection/fall.ts).
// 화면에서 보는 타이밍이 실제 동작과 어긋나면 데모가 거짓말을 하는 셈이라 맞춰 둔다.
const SCENARIO_DELAY_MS: Record<FallScenario, number> = {
  confirm: 5000,
  cancel: 3000,
};

const FOLLOW_UP: Record<FallScenario, { type: string; confidence: string }> = {
  confirm: { type: 'fall_confirmed', confidence: 'confirmed' },
  cancel: { type: 'fall_canceled', confidence: 'cleared' },
};

export function isFallScenario(value: unknown): value is FallScenario {
  return value === 'confirm' || value === 'cancel';
}

export class Simulator extends EventEmitter {
  map: SimMap;
  bounds: { x: [number, number]; y: [number, number] };
  timer: ReturnType<typeof setInterval> | null;
  seq: number;
  tags: SimTagState[];
  /** 태그별 후속 이벤트 예약. 같은 태그에 다시 주입하면 이전 각본은 버린다 */
  followUps: Map<string, ReturnType<typeof setTimeout>>;

  constructor(map: SimMap) {
    super();
    this.map = map;
    this.bounds = map.bounds;
    this.timer = null;
    this.seq = 0;
    this.followUps = new Map();

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
  zoneAt(x: number, y: number): string {
    return zoneAt(this.map, x, y);
  }

  step(dt: number): void {
    const [x0, x1] = this.bounds.x;
    const [y0, y1] = this.bounds.y;
    const now = Date.now();

    for (const tag of this.tags) {
      const accel = { x: 0, y: 0, z: G }; // 정지·보행 시 대략 중력 1g + 소량 노이즈

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
  // 후보를 즉시 내고, 각본에 따라 확진(5초) 또는 해제(3초)를 뒤이어 낸다.
  injectFall(tagId: string, scenario: FallScenario = 'confirm'): SimAlert {
    const tag = this.tags.find((t) => t.id === tagId) ?? this.tags[0];
    // 확진 각본은 오래 쓰러져 있고, 해제 각본은 곧 일어나 다시 걷는다.
    // 2D 마커의 움직임이 경보 문구와 어긋나면 화면이 거짓말을 한다.
    tag.fallen = true;
    tag.fallTimer = scenario === 'confirm' ? 12 : SCENARIO_DELAY_MS.cancel / 1000;

    const peakAccel = round(rand(2.8, 4.2)); // 충격 피크(g)
    const alert = this.makeAlert(tag, 'fall_candidate', 'candidate', peakAccel);
    this.emit('alert', alert);
    this.scheduleFollowUp(tag, scenario, peakAccel);
    return alert;
  }

  // 같은 태그에 각본이 겹치면 나중 것만 남긴다. 안 그러면 해제 뒤에 옛 확진이 날아와
  // 대시보드가 해제된 경보를 되살린다.
  private scheduleFollowUp(tag: SimTagState, scenario: FallScenario, peakAccel: number): void {
    this.cancelFollowUp(tag.id);
    const { type, confidence } = FOLLOW_UP[scenario];
    const timer = setTimeout(() => {
      this.followUps.delete(tag.id);
      if (scenario === 'cancel') tag.fallen = false; // 움직임 재개 = 해제 사유
      this.emit('alert', this.makeAlert(tag, type, confidence, peakAccel));
    }, SCENARIO_DELAY_MS[scenario]);
    timer.unref?.(); // 예약이 남아 프로세스가 안 끝나는 일이 없게
    this.followUps.set(tag.id, timer);
  }

  private cancelFollowUp(tagId: string): void {
    const pending = this.followUps.get(tagId);
    if (pending) clearTimeout(pending);
    this.followUps.delete(tagId);
  }

  // eventId는 매번 새로 뽑는다. 대시보드가 eventId로 중복을 거르므로(alert-state.js)
  // 후속 이벤트가 같은 ID를 쓰면 통째로 무시된다.
  private makeAlert(
    tag: SimTagState,
    type: string,
    confidence: string,
    peakAccel: number,
  ): SimAlert {
    return {
      eventId: `evt-${++this.seq}-${Date.now()}`,
      tagId: tag.id,
      name: tag.name,
      type,
      ts: Date.now(),
      trigger: 'imu_accel',
      freefall: false,
      peakAccel,
      pos: { x: round(tag.x), y: round(tag.y), z: 1.0 },
      confidence,
      zone: this.zoneAt(tag.x, tag.y),
    };
  }

  start(hz = 5): void {
    if (this.timer) return;
    const dt = 1 / hz;
    this.timer = setInterval(() => this.step(dt), 1000 / hz);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const timer of this.followUps.values()) clearTimeout(timer);
    this.followUps.clear();
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
