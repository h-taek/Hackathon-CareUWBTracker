'use strict';

const { triangulateTwoAnchors } = require('./triangulate');

function positionFromIngest(payload, options) {
  validateOptions(options);

  const mainRange = payload.ranges.find((range) => range.anchorId === options.mainAnchorId);
  const subRange = payload.ranges.find((range) => range.anchorId === options.subAnchorId);
  if (!mainRange || !subRange) return null;

  const { x, y } = triangulateTwoAnchors({
    rA: mainRange.distance,
    rB: subRange.distance,
    d: options.anchorDistance,
    halfPlane: options.halfPlane || 'positive',
  });

  return {
    tagId: payload.tagId,
    ts: payload.ts,
    pos: { x, y, z: 0 },
    err: { xy: options.xyError ?? 0.2, z: options.zError ?? 1.2 },
    accel: payload.accel,
    source: payload.source === 'sim' ? 'sim' : 'uwb+imu',
  };
}

function validateOptions(options) {
  if (!options || typeof options !== 'object') throw new TypeError('positioning options are required');
  requireNonEmptyString(options.mainAnchorId, 'mainAnchorId');
  requireNonEmptyString(options.subAnchorId, 'subAnchorId');
  if (options.mainAnchorId === options.subAnchorId) {
    throw new RangeError('mainAnchorId and subAnchorId must be different');
  }
}

function requireNonEmptyString(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

module.exports = { positionFromIngest };
