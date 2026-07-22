import * as fs from 'node:fs';

export interface ReplayRecord {
  ts: number;
  [key: string]: unknown;
}

export function loadNdjson(filePath: string): ReplayRecord[] {
  return parseNdjson(fs.readFileSync(filePath, 'utf8'));
}

export function parseNdjson(text: string): ReplayRecord[] {
  const records: ReplayRecord[] = [];
  const lines = text.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line || line.startsWith('#')) continue;

    let record: ReplayRecord;
    try {
      record = JSON.parse(line);
    } catch (error) {
      throw new SyntaxError(`invalid NDJSON at line ${index + 1}: ${(error as Error).message}`);
    }
    validateReplayRecord(record, index + 1);
    records.push(record);
  }

  validateTimestamps(records);
  return records;
}

export interface ReplayPlayerOptions {
  speed?: number;
  schedule?: (callback: () => void, delay: number) => unknown;
  cancelSchedule?: (timer: unknown) => void;
}

export class ReplayPlayer {
  records: ReplayRecord[];
  speed: number;
  schedule: (callback: () => void, delay: number) => unknown;
  cancelSchedule: (timer: unknown) => void;
  timer: unknown;
  stopped: boolean;

  constructor(records: ReplayRecord[], options: ReplayPlayerOptions = {}) {
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

  play(onRecord: (record: ReplayRecord) => void, onEnd: () => void = () => {}): void {
    if (typeof onRecord !== 'function') throw new TypeError('onRecord must be a function');
    if (!this.stopped) return;

    this.stopped = false;
    this.#scheduleRecord(0, onRecord, onEnd);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) this.cancelSchedule(this.timer);
    this.timer = null;
  }

  #scheduleRecord(index: number, onRecord: (record: ReplayRecord) => void, onEnd: () => void): void {
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

function validateReplayRecord(record: unknown, lineNumber?: number): asserts record is ReplayRecord {
  const label = lineNumber ? `line ${lineNumber}` : 'record';
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new TypeError(`${label} must be a JSON object`);
  }
  const ts = (record as { ts?: unknown }).ts;
  if (!Number.isFinite(ts) || (ts as number) < 0) {
    throw new TypeError(`${label} must have a non-negative numeric ts`);
  }
}

function validateTimestamps(records: ReplayRecord[]): void {
  for (let index = 0; index < records.length; index += 1) {
    validateReplayRecord(records[index]);
    if (index > 0 && records[index].ts < records[index - 1].ts) {
      throw new RangeError(`record ${index + 1} timestamp is earlier than the previous record`);
    }
  }
}
