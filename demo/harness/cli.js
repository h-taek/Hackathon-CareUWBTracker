#!/usr/bin/env node
'use strict';

const { IngestGenerator } = require('./generator');
const { ReplayPlayer, loadNdjson } = require('./replay');
const { createHttpWriter } = require('./sender');

const USAGE = `Usage:
  node demo/ingest/cli.js generate [options]
  node demo/ingest/cli.js replay <file.ndjson> [options]

Generate options:
  --hz <number>                Sample rate (default: 50)
  --anchor-distance <meters>   Distance between anchors (default: 4)
  --count <number>             Stop after this many records (default: unlimited)
  --fall-after <seconds>       Inject one fall after the given time
  --url <http-url>             POST records instead of printing NDJSON

Replay options:
  --speed <number>             Playback speed multiplier (default: 1)
  --url <http-url>             POST records instead of printing NDJSON

Output:
  One spec-03 ingest JSON object per line (NDJSON).`;

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h') return { command: 'help' };

  if (command === 'generate') {
    const options = parseOptions(rest, new Set(['hz', 'anchor-distance', 'count', 'fall-after', 'url']));
    return {
      command,
      hz: positiveNumber(options.hz ?? 50, 'hz'),
      anchorDistance: positiveNumber(options['anchor-distance'] ?? 4, 'anchor-distance'),
      count: options.count === undefined ? Infinity : positiveInteger(options.count, 'count'),
      fallAfter: options['fall-after'] === undefined
        ? null
        : nonNegativeNumber(options['fall-after'], 'fall-after'),
      url: options.url,
    };
  }

  if (command === 'replay') {
    if (!rest[0] || rest[0].startsWith('--')) throw new Error('replay requires an NDJSON file');
    const options = parseOptions(rest.slice(1), new Set(['speed', 'url']));
    return {
      command,
      file: rest[0],
      speed: positiveNumber(options.speed ?? 1, 'speed'),
      url: options.url,
    };
  }

  throw new Error(`unknown command: ${command}`);
}

function parseOptions(args, allowed) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith('--')) throw new Error(`unexpected argument: ${flag}`);
    const name = flag.slice(2);
    if (!allowed.has(name)) throw new Error(`unknown option: ${flag}`);
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    options[name] = value;
  }
  return options;
}

function runGenerate(config, write = writeNdjson) {
  const generator = new IngestGenerator({
    anchorDistance: config.anchorDistance,
    sampleHz: config.hz,
  });
  const fallAtSample = config.fallAfter === null
    ? null
    : Math.round(config.fallAfter * config.hz);
  let emitted = 0;
  let timer = null;

  const emitOne = () => {
    if (fallAtSample !== null && emitted === fallAtSample) generator.injectFall();
    write(generator.next(1 / config.hz));
    emitted += 1;
    if (emitted >= config.count && timer !== null) clearInterval(timer);
  };

  emitOne();
  if (emitted < config.count) timer = setInterval(emitOne, 1000 / config.hz);
  return () => { if (timer !== null) clearInterval(timer); };
}

function runReplay(config, write = writeNdjson) {
  const records = loadNdjson(config.file);
  const player = new ReplayPlayer(records, { speed: config.speed });
  player.play(write);
  return () => player.stop();
}

function writeNdjson(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function positiveNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`--${name} must be a positive number`);
  return number;
}

function nonNegativeNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`--${name} must be zero or greater`);
  return number;
}

function positiveInteger(value, name) {
  const number = positiveNumber(value, name);
  if (!Number.isInteger(number)) throw new Error(`--${name} must be an integer`);
  return number;
}

function main(argv) {
  try {
    const config = parseArgs(argv);
    if (config.command === 'help') {
      process.stdout.write(`${USAGE}\n`);
    } else if (config.command === 'generate') {
      runGenerate(config, config.url ? createHttpWriter(config.url) : writeNdjson);
    } else {
      runReplay(config, config.url ? createHttpWriter(config.url) : writeNdjson);
    }
  } catch (error) {
    process.stderr.write(`Error: ${error.message}\n\n${USAGE}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { parseArgs, runGenerate, runReplay };
