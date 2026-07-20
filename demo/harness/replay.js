'use strict';

const fs = require('fs');

function loadNdjson(filePath) {
  return parseNdjson(fs.readFileSync(filePath, 'utf8'));
}

function parseNdjson(text) {
  const records = [];
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || line.startsWith('#')) continue;

    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      throw new SyntaxError(`invalid NDJSON at line ${index + 1}: ${error.message}`);
    }
    validateReplayRecord(record, index + 1);
    records.push(record);
  }

  validateTimestamps(records);
  return records;
}

class ReplayPlayer {
  constructor(records, options = {}) {
    if (!Array.isArray(records)) throw new TypeError('records must be an array');
    validateTimestamps(records);

    this.records = records;
    this.speed = options.speed ?? 1;
    this.schedule = options.schedule || setTimeout;
    this.cancelSchedule = options.cancelSchedule || clearTimeout;
    this.timer = null;
    this.stopped = true;

    if (!Number.isFinite(this.speed) || this.speed <= 0) {
      throw new RangeError('speed must be a positive number');
    }
  }

  play(onRecord, onEnd = () => {}) {
    if (typeof onRecord !== 'function') throw new TypeError('onRecord must be a function');
    if (!this.stopped) return;

    this.stopped = false;
    this.#scheduleRecord(0, onRecord, onEnd);
  }

  stop() {
    this.stopped = true;
    if (this.timer !== null) this.cancelSchedule(this.timer);
    this.timer = null;
  }

  #scheduleRecord(index, onRecord, onEnd) {
    if (this.stopped) return;
    if (index >= this.records.length) {
      this.stop();
      onEnd();
      return;
    }

    const delay = index === 0
      ? 0
      : (this.records[index].ts - this.records[index - 1].ts) / this.speed;

    this.timer = this.schedule(() => {
      if (this.stopped) return;
      onRecord(this.records[index]);
      this.#scheduleRecord(index + 1, onRecord, onEnd);
    }, delay);
  }
}

function validateReplayRecord(record, lineNumber) {
  const label = lineNumber ? `line ${lineNumber}` : 'record';
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new TypeError(`${label} must be a JSON object`);
  }
  if (!Number.isFinite(record.ts) || record.ts < 0) {
    throw new TypeError(`${label} must have a non-negative numeric ts`);
  }
}

function validateTimestamps(records) {
  for (let index = 0; index < records.length; index += 1) {
    validateReplayRecord(records[index]);
    if (index > 0 && records[index].ts < records[index - 1].ts) {
      throw new RangeError(`record ${index + 1} timestamp is earlier than the previous record`);
    }
  }
}

module.exports = { ReplayPlayer, loadNdjson, parseNdjson };
