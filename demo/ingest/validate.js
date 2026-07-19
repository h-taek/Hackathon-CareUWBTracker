'use strict';

const ALLOWED_SOURCES = new Set(['ni', 'sim']);

class IngestValidationError extends Error {
  constructor(issues) {
    super(`invalid ingest: ${issues.join('; ')}`);
    this.name = 'IngestValidationError';
    this.issues = issues;
  }
}

function validateIngest(payload) {
  const issues = [];

  if (!isPlainObject(payload)) {
    throw new IngestValidationError(['payload must be a JSON object']);
  }

  requireNonEmptyString(payload.tagId, 'tagId', issues);
  requireNonNegativeNumber(payload.ts, 'ts', issues);
  validateRanges(payload.ranges, issues);
  validateAccel(payload.accel, issues);

  if (!ALLOWED_SOURCES.has(payload.source)) {
    issues.push('source must be one of: ni, sim');
  }

  if (issues.length > 0) throw new IngestValidationError(issues);
  return payload;
}

function validateRanges(ranges, issues) {
  if (!Array.isArray(ranges) || ranges.length < 1 || ranges.length > 2) {
    issues.push('ranges must contain one or two anchors');
    return;
  }

  const anchorIds = new Set();
  ranges.forEach((range, index) => {
    const path = `ranges[${index}]`;
    if (!isPlainObject(range)) {
      issues.push(`${path} must be an object`);
      return;
    }

    requireNonEmptyString(range.anchorId, `${path}.anchorId`, issues);
    requireNonNegativeNumber(range.distance, `${path}.distance`, issues);

    if (typeof range.anchorId === 'string' && range.anchorId.trim()) {
      if (anchorIds.has(range.anchorId)) issues.push(`${path}.anchorId must be unique`);
      anchorIds.add(range.anchorId);
    }
  });
}

function validateAccel(accel, issues) {
  if (!isPlainObject(accel)) {
    issues.push('accel must be an object');
    return;
  }

  for (const axis of ['x', 'y', 'z']) {
    if (!Number.isFinite(accel[axis])) issues.push(`accel.${axis} must be a finite number`);
  }
}

function requireNonEmptyString(value, path, issues) {
  if (typeof value !== 'string' || !value.trim()) issues.push(`${path} must be a non-empty string`);
}

function requireNonNegativeNumber(value, path, issues) {
  if (!Number.isFinite(value) || value < 0) issues.push(`${path} must be a non-negative finite number`);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

module.exports = { IngestValidationError, validateIngest };
