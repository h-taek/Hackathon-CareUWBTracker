#!/usr/bin/env node

import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { IngestGenerator } from './generator.ts';
import { ReplayPlayer, loadNdjson, type ReplayRecord } from './replay.ts';
import { createHttpWriter } from './sender.ts';
import { streamTrialsFromFile } from './csv.ts';
import {
  detectTrial, feedTyped, trialFeed, makeConfusion, sweepAll, type TrialLike, type SweepResult,
} from './evaluate.ts';
import { formatEvaluation, formatSweep } from './report.ts';
import { readTrial, buildClip, formatClipReport, writeClip } from './clip.ts';

const USAGE = `Usage:
  node tools/cli.ts generate [options]
  node tools/cli.ts replay <file.ndjson> [options]
  node tools/cli.ts evaluate <normalized.csv> [options]
  node tools/cli.ts clip <normalized.csv> [options]

Generate options:
  --hz <number>                Sample rate (default: 50)
  --anchor-distance <meters>   Distance between anchors (default: 4)
  --count <number>             Stop after this many records (default: unlimited)
  --fall-after <seconds>       Inject one fall after the given time
  --url <http-url>             POST records instead of printing NDJSON

Replay options:
  --speed <number>             Playback speed multiplier (default: 1)
  --url <http-url>             POST records instead of printing NDJSON

Evaluate options (고전 감지기 베이스라인 성적 + 임계 스윕):
  --sweep                      임계값 트레이드오프 곡선도 출력
  --sweep-placement <name>     스윕 대상 위치(기본 waist, all=전체)
  --json <path>                결과를 JSON으로도 저장

Clip options (데모 주입용 클립을 데이터셋에서 다시 만든다):
  --manifest <path>            레시피 파일(기본 tools/clips.json)
  --only <clip-id>             이 클립 하나만 다시 만든다
  --dry-run                    파일을 쓰지 않고 검증 결과만 출력

Output:
  generate/replay: spec-03 ingest JSON NDJSON. evaluate: 혼동행렬/스윕 표.
  clip: server/inject/clips/*.json + 클립별 감지 결과 리포트.`;

export interface HelpConfig {
  command: 'help';
}

export interface GenerateConfig {
  command: 'generate';
  hz: number;
  anchorDistance: number;
  count: number;
  fallAfter: number | null;
  url?: string;
}

export interface ReplayConfig {
  command: 'replay';
  file: string;
  speed: number;
  url?: string;
}

export interface EvaluateConfig {
  command: 'evaluate';
  file: string;
  sweep: boolean;
  sweepPlacement: string;
  json?: string;
}

export interface ClipConfig {
  command: 'clip';
  file: string;
  manifest: string;
  only?: string;
  dryRun: boolean;
}

export type Config = HelpConfig | GenerateConfig | ReplayConfig | EvaluateConfig | ClipConfig;

type OptionMap = Record<string, string | boolean | undefined>;

export function parseArgs(argv: string[]): Config {
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
      url: options.url as string | undefined,
    };
  }

  if (command === 'replay') {
    if (!rest[0] || rest[0].startsWith('--')) throw new Error('replay requires an NDJSON file');
    const options = parseOptions(rest.slice(1), new Set(['speed', 'url']));
    return {
      command,
      file: rest[0],
      speed: positiveNumber(options.speed ?? 1, 'speed'),
      url: options.url as string | undefined,
    };
  }

  if (command === 'evaluate') {
    if (!rest[0] || rest[0].startsWith('--')) throw new Error('evaluate requires a normalized CSV file');
    const options = parseOptions(rest.slice(1), new Set(['sweep', 'sweep-placement', 'json']), new Set(['sweep']));
    return {
      command,
      file: rest[0],
      sweep: options.sweep === true,
      sweepPlacement: (options['sweep-placement'] as string | undefined) ?? 'waist',
      json: options.json as string | undefined,
    };
  }

  if (command === 'clip') {
    if (!rest[0] || rest[0].startsWith('--')) throw new Error('clip requires a normalized CSV file');
    const options = parseOptions(rest.slice(1), new Set(['manifest', 'only', 'dry-run']), new Set(['dry-run']));
    return {
      command,
      file: rest[0],
      manifest: (options.manifest as string | undefined) ?? 'tools/clips.json',
      only: options.only as string | undefined,
      dryRun: options['dry-run'] === true,
    };
  }

  throw new Error(`unknown command: ${command}`);
}

function parseOptions(args: string[], allowed: Set<string>, booleans: Set<string> = new Set()): OptionMap {
  const options: OptionMap = {};
  let index = 0;
  while (index < args.length) {
    const flag = args[index];
    if (!flag?.startsWith('--')) throw new Error(`unexpected argument: ${flag}`);
    const name = flag.slice(2);
    if (!allowed.has(name)) throw new Error(`unknown option: ${flag}`);
    if (booleans.has(name)) {
      options[name] = true;
      index += 1;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    options[name] = value;
    index += 2;
  }
  return options;
}

export type WriteFn = (record: ReplayRecord) => unknown;

export function runGenerate(config: GenerateConfig, write: WriteFn = writeNdjson): () => void {
  const generator = new IngestGenerator({
    anchorDistance: config.anchorDistance,
    sampleHz: config.hz,
  });
  const fallAtSample = config.fallAfter === null
    ? null
    : Math.round(config.fallAfter * config.hz);
  let emitted = 0;
  let timer: NodeJS.Timeout | null = null;

  const emitOne = (): void => {
    if (fallAtSample !== null && emitted === fallAtSample) generator.injectFall();
    write(generator.next(1 / config.hz));
    emitted += 1;
    if (emitted >= config.count && timer !== null) clearInterval(timer);
  };

  emitOne();
  if (emitted < config.count) timer = setInterval(emitOne, 1000 / config.hz);
  return () => { if (timer !== null) clearInterval(timer); };
}

export function runReplay(config: ReplayConfig, write: WriteFn = writeNdjson): () => void {
  const records = loadNdjson(config.file);
  const player = new ReplayPlayer(records, { speed: config.speed });
  player.play(write);
  return () => player.stop();
}

function writeNdjson(record: ReplayRecord): void {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

// 정규화 CSV를 한 번 스트리밍하며 (1) 전 위치 baseline 혼동행렬을 쌓고,
// (2) --sweep 대상 위치 trial을 타입배열로 압축 캐시(스윕 다회 패스용). 그 뒤 리포트를 낸다.
export async function runEvaluate(
  config: EvaluateConfig,
  out: { write: (chunk: string) => unknown } = process.stdout,
): Promise<import('./evaluate.ts').EvaluationResult> {
  const overall = makeConfusion();
  const byGroup = new Map<string, { dataset: string; placement: string; detected: ReturnType<typeof makeConfusion> }>();
  const cache: TrialLike[] = []; // 스윕용 압축 trial
  const wantAll = config.sweepPlacement === 'all';

  const onTrial = (t: import('./csv.ts').Trial): void => {
    const { detected } = detectTrial(trialFeed(t));
    overall.add(t.isFall, detected);
    const key = `${t.dataset}|${t.placement}`;
    let g = byGroup.get(key);
    if (!g) {
      g = { dataset: t.dataset, placement: t.placement, detected: makeConfusion() };
      byGroup.set(key, g);
    }
    g.detected.add(t.isFall, detected);

    if (config.sweep && (wantAll || t.placement === config.sweepPlacement)) {
      const n = t.samples.length;
      const ts = new Float64Array(n);
      const ax = new Float32Array(n);
      const ay = new Float32Array(n);
      const az = new Float32Array(n);
      for (let i = 0; i < n; i += 1) {
        const s = t.samples[i]; ts[i] = s.tMs; ax[i] = s.ax; ay[i] = s.ay; az[i] = s.az;
      }
      cache.push({ dataset: t.dataset, placement: t.placement, isFall: t.isFall, feed: feedTyped(ts, ax, ay, az) });
    }
  };

  const stats = await streamTrialsFromFile(config.file, onTrial);
  const result = { overall, byGroup };
  out.write(`${formatEvaluation(result, { title: `평가 ${config.file} (trial ${stats.trials}, row ${stats.rows})` })}\n`);

  let sweep: SweepResult | null = null;
  if (config.sweep) {
    out.write(`\n스윕 대상: placement=${config.sweepPlacement} (${cache.length} trial)\n`);
    sweep = sweepAll(cache);
    out.write(`${formatSweep(sweep)}\n`);
  }

  if (config.json) {
    const toObj = (r: typeof result) => ({
      overall: r.overall.metrics(),
      byGroup: [...r.byGroup.values()].map((g) => ({
        dataset: g.dataset, placement: g.placement, detected: g.detected.metrics(),
      })),
    });
    fs.writeFileSync(config.json, JSON.stringify({ file: config.file, stats, evaluation: toObj(result), sweep }, null, 2));
    out.write(`\nJSON 저장: ${config.json}\n`);
  }
  return result;
}

// 마스터 CSV를 레시피 수만큼 훑는다. 3.7GB × N회라 느리지만 1회성 도구다 —
// 클립을 메모리에 다 들고 한 번에 훑는 최적화보다 코드가 단순한 편이 낫다.
export async function runClip(
  config: ClipConfig,
  out: { write: (chunk: string) => unknown } = process.stdout,
): Promise<void> {
  const manifest = JSON.parse(fs.readFileSync(config.manifest, 'utf8'));
  const recipes = manifest.recipes.filter(
    (r: { id: string }) => !config.only || r.id === config.only,
  );
  if (recipes.length === 0) throw new Error(`레시피를 찾지 못했습니다: ${config.only}`);

  for (const recipe of recipes) {
    const rows = await readTrial(config.file, recipe.select);
    const result = buildClip(rows, recipe.select, {
      id: recipe.id,
      label: recipe.label,
      summary: recipe.summary,
      activityLabel: recipe.activityLabel,
    });
    out.write(`${formatClipReport(result)}\n`);

    if (config.dryRun) {
      out.write('  (dry-run — 파일을 쓰지 않았습니다)\n\n');
      continue;
    }
    const outPath = `${manifest.outDir}/${recipe.file}`;
    fs.mkdirSync(manifest.outDir, { recursive: true });
    writeClip(result.clip, outPath);
    out.write(`  저장   ${outPath}\n\n`);
  }
}

function positiveNumber(value: string | boolean | number | undefined, name: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`--${name} must be a positive number`);
  return number;
}

function nonNegativeNumber(value: string | boolean | number | undefined, name: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`--${name} must be zero or greater`);
  return number;
}

function positiveInteger(value: string | boolean | number | undefined, name: string): number {
  const number = positiveNumber(value, name);
  if (!Number.isInteger(number)) throw new Error(`--${name} must be an integer`);
  return number;
}

async function main(argv: string[]): Promise<void> {
  try {
    const config = parseArgs(argv);
    if (config.command === 'help') {
      process.stdout.write(`${USAGE}\n`);
    } else if (config.command === 'generate') {
      runGenerate(config, config.url ? (createHttpWriter(config.url) as unknown as WriteFn) : writeNdjson);
    } else if (config.command === 'replay') {
      runReplay(config, config.url ? (createHttpWriter(config.url) as unknown as WriteFn) : writeNdjson);
    } else if (config.command === 'evaluate') {
      await runEvaluate(config);
    } else if (config.command === 'clip') {
      await runClip(config);
    }
  } catch (error) {
    process.stderr.write(`Error: ${(error as Error).message}\n\n${USAGE}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));

export { main };
