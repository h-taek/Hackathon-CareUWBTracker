// 학습 반출 수신 목업 — **제품이 아니다.**
//
// spec system 03 §7.5가 정한 대로 받는 서버는 계약 밖이다. 이 파일은 보내는 쪽이 실제로
// 도는지 왕복으로 확인하려고 둔 30줄짜리 받침대다. 받은 것을 그대로 파일에 떨궈, 시설
// 밖으로 나간 것에 태그 ID도 시각도 좌표도 없다는 걸 눈으로 볼 수 있게 한다.
//
//   node tools/export-sink.ts                                 (기본 9100 포트)
//   .env에 EXPORT_URL=http://localhost:9100/samples           서버를 여기로 붙인다
//
// 받은 것은 `tools/sink-out/<YYYY-MM-DD>.jsonl`에 쌓인다.

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadEnvFile } from '../server/config/env-file.ts';

// 서버와 같은 설정 파일을 본다. EXPORT_TOKEN과 SINK_TOKEN이 짝을 이뤄야 하므로
// 두 파일로 갈라 두면 그 대조가 어려워진다.
const here = path.dirname(fileURLToPath(import.meta.url));
loadEnvFile(path.join(here, '..', 'server'));

const port = Number(process.env.SINK_PORT) || 9100;
const token = process.env.SINK_TOKEN || '';
const outDir = process.env.SINK_DIR
  || path.join(here, 'sink-out');

const server = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405).end();
    return;
  }
  // 토큰을 정해 두면 검사한다. 안 정하면 아무나 받는다 — 목업이라 그래도 된다.
  if (token && req.headers.authorization !== `Bearer ${token}`) {
    res.writeHead(401).end('bad token\n');
    return;
  }

  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    const lines = body.split('\n').filter((line) => line.length > 0);
    fs.mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
    fs.appendFileSync(file, lines.map((line) => `${line}\n`).join(''), 'utf8');

    const labels = lines.map((line) => safeLabel(line));
    console.log(`[sink] ${lines.length}건 수신`
      + ` · 낙상 ${labels.filter((l) => l === 1).length} · 오경보 ${labels.filter((l) => l === 0).length}`
      + ` → ${file}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(`${JSON.stringify({ received: lines.length })}\n`);
  });
});

server.listen(port, () => {
  console.log(`[sink] 학습 반출 수신 목업 http://localhost:${port} → ${outDir}`);
  console.log(`[sink] 서버를 붙이려면 .env에: EXPORT_URL=http://localhost:${port}/samples`);
});

function safeLabel(line: string): unknown {
  try {
    return (JSON.parse(line) as { label?: unknown }).label;
  } catch {
    return null;
  }
}
