import * as http from 'node:http';
import { HttpBodyError, readJsonBody } from './body.ts';
import { IngestValidationError, validateIngest, type IngestPayload } from './validate.ts';

export async function handleIngest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  options: { bodyLimit?: number; onIngest?: (payload: IngestPayload) => unknown } = {},
): Promise<void> {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
  }

  try {
    const payload = validateIngest(await readJsonBody(req, { limit: options.bodyLimit }));
    if (options.onIngest) await options.onIngest(payload);
    return sendJson(res, 202, { ok: true });
  } catch (error) {
    if (error instanceof IngestValidationError) {
      return sendJson(res, 400, {
        ok: false,
        error: 'invalid_ingest',
        issues: error.issues,
      });
    }
    if (error instanceof HttpBodyError) {
      return sendJson(res, error.statusCode, {
        ok: false,
        error: bodyErrorCode(error.statusCode),
        message: error.message,
      });
    }

    console.error('ingest handler failed', error);
    return sendJson(res, 500, { ok: false, error: 'internal_error' });
  }
}

function bodyErrorCode(statusCode: number): string {
  if (statusCode === 413) return 'payload_too_large';
  if (statusCode === 415) return 'unsupported_media_type';
  return 'invalid_json';
}

function sendJson(res: http.ServerResponse, statusCode: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}
