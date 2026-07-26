// 시뮬 측위 스트림 생성기. 배경 태그가 맵 위를 걷게 만든다.
// spec 03 측위 좌표 스키마(1절)를 그대로 방출한다.
// 측위 소스가 sim일 뿐, 서버/대시보드 입장에서는 실측 UWB와 구분되지 않는다(source 필드로만 구분).
//
// 경보는 여기서 만들지 않는다. 낙상 경보를 내는 곳은 감지기(detection/) 하나뿐이고,
// 데모 주입 버튼도 그 감지기를 거친다(inject/injector.ts). 시뮬이 경보를 지어내던
// 시절에는 화면에 뜨는 경보가 감지기 성능과 아무 상관이 없었다.

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
}

export interface SimMap extends ZoneMap {
  bounds: { x: [number, number]; y: [number, number] };
}

export class Simulator extends EventEmitter {
  map: SimMap;
  bounds: { x: [number, number]; y: [number, number] };
  timer: ReturnType<typeof setInterval> | null;
  tags: SimTagState[];
  /**
   * 재생이 걸린 태그. 클립 주입이 시작되면 여기 들어간다.
   * 주입 중에는 그 태그의 좌표를 주입기가 실제 측위 경로로 만들어 내므로, 시뮬이 같은
   * 태그를 계속 걷게 두면 5Hz 시뮬 좌표와 50Hz 주입 좌표가 서로 마커를 뺏는다.
   */
  frozen: Set<string>;

  constructor(map: SimMap) {
    super();
    this.map = map;
    this.bounds = map.bounds;
    this.timer = null;
    this.frozen = new Set();

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
    }));
  }

  /** 주입 중인 태그를 시뮬 대상에서 뺀다(좌표는 그 자리에 남는다). */
  freeze(tagId: string): void {
    this.frozen.add(tagId);
  }

  unfreeze(tagId: string): void {
    this.frozen.delete(tagId);
  }

  /** 태그가 지금 서 있는 자리. 주입기가 UWB 거리를 만들 기준점으로 쓴다. */
  positionOf(tagId: string): { x: number; y: number } | null {
    const tag = this.tags.find((t) => t.id === tagId);
    return tag ? { x: tag.x, y: tag.y } : null;
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
      if (this.frozen.has(tag.id)) continue; // 주입기가 이 태그를 쥐고 있다

      const accel = { x: 0, y: 0, z: G }; // 정지·보행 시 대략 중력 1g + 소량 노이즈

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

  start(hz = 5): void {
    if (this.timer) return;
    const dt = 1 / hz;
    this.timer = setInterval(() => this.step(dt), 1000 / hz);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
