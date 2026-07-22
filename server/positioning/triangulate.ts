export interface Position {
  x: number;
  y: number;
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
  const yMagnitude = Math.sqrt(Math.max(0, (rA ** 2) - (x ** 2)));
  const y = halfPlane === 'negative' ? -yMagnitude : yMagnitude;

  return { x, y };
}

function requireNonNegativeFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number`);
  }
}
