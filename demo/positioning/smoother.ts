'use strict';

export const DEFAULT_POSITION_WINDOW = 5;

interface Coordinates {
  x: number;
  y: number;
  z: number;
}

export interface PositionRecord {
  tagId: string;
  pos: Coordinates;
  [key: string]: unknown;
}

interface TagWindow {
  points: Coordinates[];
  sum: Coordinates;
}

export interface PositionSmoother {
  observe<T extends PositionRecord>(position: T): T;
  reset(tagId?: string): void;
}

export function createPositionSmoother(windowSize = DEFAULT_POSITION_WINDOW): PositionSmoother {
  if (!Number.isInteger(windowSize) || windowSize <= 0) {
    throw new RangeError('windowSize must be a positive integer');
  }

  const windows = new Map<string, TagWindow>();

  return {
    observe<T extends PositionRecord>(position: T): T {
      validatePosition(position);

      let window = windows.get(position.tagId);
      if (!window) {
        window = {
          points: [],
          sum: { x: 0, y: 0, z: 0 },
        };
        windows.set(position.tagId, window);
      }

      const point = { ...position.pos };
      window.points.push(point);
      window.sum.x += point.x;
      window.sum.y += point.y;
      window.sum.z += point.z;

      if (window.points.length > windowSize) {
        const removed = window.points.shift();
        if (removed) {
          window.sum.x -= removed.x;
          window.sum.y -= removed.y;
          window.sum.z -= removed.z;
        }
      }

      const count = window.points.length;
      return {
        ...position,
        pos: {
          x: window.sum.x / count,
          y: window.sum.y / count,
          z: window.sum.z / count,
        },
      };
    },

    reset(tagId?: string): void {
      if (tagId === undefined) windows.clear();
      else windows.delete(tagId);
    },
  };
}

function validatePosition(position: PositionRecord): void {
  if (!position || typeof position !== 'object') {
    throw new TypeError('position must be an object');
  }
  if (typeof position.tagId !== 'string' || !position.tagId.trim()) {
    throw new TypeError('position.tagId must be a non-empty string');
  }
  if (!position.pos || typeof position.pos !== 'object') {
    throw new TypeError('position.pos must be an object');
  }
  for (const axis of ['x', 'y', 'z'] as const) {
    if (!Number.isFinite(position.pos[axis])) {
      throw new TypeError(`position.pos.${axis} must be a finite number`);
    }
  }
}
