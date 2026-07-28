export interface Position {
  x: number;
  y: number;
  /**
   * 두 거리원이 만나지 않아 y를 0으로 깎았는지.
   *
   * spec 03 §5의 `y = ±sqrt(max(0, rA² - x²))`는 측정 오차로 살짝 음수가 되는 경우를
   * 흡수하려는 것이라 그대로 둔다. 문제는 그 클램프가 **아무 흔적을 안 남긴다**는 점이었다 —
   * 1cm 오차로 깎인 것과 앵커 배치가 통째로 틀려 해가 아예 없는 것이 구분되지 않았다.
   * 후자는 화면에 그럴듯한 좌표가 계속 찍혀서 아무도 못 알아챈다.
   */
  clamped: boolean;
  /**
   * 클램프 폭(m). 0이면 정상해.
   *
   * 두 원이 만나려면 `|rA - rB| ≤ d ≤ rA + rB`여야 한다. 이 값은 그 부등식이 깨진 폭이라,
   * "거리 합이 앵커 간격보다 이만큼 모자란다"로 바로 읽힌다.
   * 수 cm면 UWB 측정 오차 수준이고, 수십 cm 이상이면 --anchor-distance가 실제 배치와 다르다는 신호다.
   */
  clampError: number;
}

type HalfPlane = 'positive' | 'negative';

interface TriangulateTwoAnchorsOptions {
  rA: number;
  rB: number;
  d: number;
  halfPlane?: HalfPlane;
}

const HALF_PLANES = new Set(['positive', 'negative']);

export function triangulateTwoAnchors({ rA, rB, d, halfPlane = 'positive' }: TriangulateTwoAnchorsOptions): Position {
  requireNonNegativeFinite(rA, 'rA');
  requireNonNegativeFinite(rB, 'rB');
  if (!Number.isFinite(d) || d <= 0) throw new RangeError('d must be a positive finite number');
  if (!HALF_PLANES.has(halfPlane)) {
    throw new RangeError('halfPlane must be positive or negative');
  }

  const x = ((rA ** 2) - (rB ** 2) + (d ** 2)) / (2 * d);
  const ySquared = (rA ** 2) - (x ** 2);
  // 클램프 여부는 실제로 깎였는지(ySquared < 0)로 판단하고, 폭은 삼각부등식이 깨진 양으로 잰다.
  // 둘은 수학적으로 같은 조건이지만, 부동소수점 경계에서 어긋날 수 있어 폭은 0에서 자른다.
  const clamped = ySquared < 0;
  const clampError = clamped
    ? Math.max(0, d - (rA + rB), Math.abs(rA - rB) - d)
    : 0;

  const yMagnitude = Math.sqrt(Math.max(0, ySquared));
  const y = halfPlane === 'negative' ? -yMagnitude : yMagnitude;

  return { x, y, clamped, clampError };
}

function requireNonNegativeFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number`);
  }
}
