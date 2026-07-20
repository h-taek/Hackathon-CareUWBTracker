'use strict';

const DEFAULTS = Object.freeze({
  tagId: 'tag-watch',
  mainAnchorId: 'phoneMain',
  subAnchorId: 'phoneSub',
  anchorDistance: 4,
  start: { x: 1, y: 1 },
  velocity: { x: 0.4, y: 0.2 },
  bounds: { x: [0.2, 3.8], y: [0.2, 3.8] },
  rangeNoise: 0.02,
  sampleHz: 50,
});

const FALL_PHASES = Object.freeze({
  freefall: { durationSeconds: 0.4, accel: { x: 0.1, y: 0.1, z: 0.2 } },
  impact: { durationSeconds: 0.2, accel: { x: 4, y: 3, z: 32 } },
  still: { durationSeconds: 2.4, accel: { x: 0.03, y: 0.02, z: 9.81 } },
});

class IngestGenerator {
  constructor(options = {}) {
    this.options = {
      ...DEFAULTS,
      ...options,
      start: { ...DEFAULTS.start, ...options.start },
      velocity: { ...DEFAULTS.velocity, ...options.velocity },
      bounds: {
        x: options.bounds?.x || DEFAULTS.bounds.x,
        y: options.bounds?.y || DEFAULTS.bounds.y,
      },
    };

    validateOptions(this.options);

    this.position = { ...this.options.start };
    this.velocity = { ...this.options.velocity };
    this.random = options.random || Math.random;
    this.now = options.now || Date.now;
    this.fallSamples = [];
  }

  injectFall() {
    this.fallSamples = buildFallSamples(this.options.sampleHz);
  }

  next(dt = 0.2) {
    if (!Number.isFinite(dt) || dt <= 0) {
      throw new RangeError('dt must be a positive number');
    }

    this.position.x += this.velocity.x * dt;
    this.position.y += this.velocity.y * dt;
    reflectAtBounds(this.position, this.velocity, this.options.bounds);

    const { x, y } = this.position;
    const d = this.options.anchorDistance;
    const rA = withNoise(Math.hypot(x, y), this.options.rangeNoise, this.random);
    const rB = withNoise(Math.hypot(x - d, y), this.options.rangeNoise, this.random);

    return {
      tagId: this.options.tagId,
      ts: this.now(),
      ranges: [
        { anchorId: this.options.mainAnchorId, distance: round(rA) },
        { anchorId: this.options.subAnchorId, distance: round(rB) },
      ],
      accel: this.fallSamples.shift() || normalWalkingAccel(this.random),
      source: 'sim',
    };
  }
}

function validateOptions(options) {
  if (!Number.isFinite(options.anchorDistance) || options.anchorDistance <= 0) {
    throw new RangeError('anchorDistance must be a positive number');
  }
  if (!Number.isFinite(options.sampleHz) || options.sampleHz <= 0) {
    throw new RangeError('sampleHz must be a positive number');
  }

  for (const axis of ['x', 'y']) {
    const bounds = options.bounds[axis];
    if (!Array.isArray(bounds) || bounds.length !== 2 || bounds[0] >= bounds[1]) {
      throw new RangeError(`bounds.${axis} must be [min, max]`);
    }
    if (options.start[axis] < bounds[0] || options.start[axis] > bounds[1]) {
      throw new RangeError(`start.${axis} must be inside bounds.${axis}`);
    }
  }
}

function buildFallSamples(sampleHz) {
  const samples = [];
  for (const phase of Object.values(FALL_PHASES)) {
    const count = Math.max(1, Math.round(phase.durationSeconds * sampleHz));
    for (let index = 0; index < count; index += 1) {
      samples.push({ ...phase.accel });
    }
  }
  return samples;
}

function reflectAtBounds(position, velocity, bounds) {
  for (const axis of ['x', 'y']) {
    const [min, max] = bounds[axis];
    if (position[axis] < min) {
      position[axis] = min + (min - position[axis]);
      velocity[axis] = Math.abs(velocity[axis]);
    } else if (position[axis] > max) {
      position[axis] = max - (position[axis] - max);
      velocity[axis] = -Math.abs(velocity[axis]);
    }
  }
}

function withNoise(value, amplitude, random) {
  if (!amplitude) return value;
  return Math.max(0, value + (random() * 2 - 1) * amplitude);
}

function normalWalkingAccel(random) {
  return {
    x: round((random() * 2 - 1) * 0.8),
    y: round((random() * 2 - 1) * 0.8),
    z: round(9.81 + (random() * 2 - 1) * 0.6),
  };
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

module.exports = { IngestGenerator };
