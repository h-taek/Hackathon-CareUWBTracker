'use strict';

const { HttpBodyError, readJsonBody } = require('./body');
const { IngestValidationError, validateIngest } = require('./validate');

async function handleIngest(req, res, options = {}) {
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

function bodyErrorCode(statusCode) {
  if (statusCode === 413) return 'payload_too_large';
  if (statusCode === 415) return 'unsupported_media_type';
  return 'invalid_json';
}

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

module.exports = { handleIngest };
