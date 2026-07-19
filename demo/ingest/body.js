'use strict';

const DEFAULT_BODY_LIMIT = 64 * 1024;

class HttpBodyError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
  }
}

class UnsupportedMediaTypeError extends HttpBodyError {
  constructor() {
    super('Content-Type must be application/json', 415);
  }
}

class PayloadTooLargeError extends HttpBodyError {
  constructor(limit) {
    super(`request body exceeds ${limit} bytes`, 413);
  }
}

class InvalidJsonError extends HttpBodyError {
  constructor(message) {
    super(message, 400);
  }
}

async function readJsonBody(req, options = {}) {
  const limit = options.limit ?? DEFAULT_BODY_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) throw new RangeError('body limit must be a positive integer');

  const contentType = String(req.headers?.['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') throw new UnsupportedMediaTypeError();

  const declaredLength = Number(req.headers?.['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    throw new PayloadTooLargeError(limit);
  }

  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new PayloadTooLargeError(limit);
    chunks.push(buffer);
  }

  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) throw new InvalidJsonError('request body must not be empty');

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new InvalidJsonError(`malformed JSON: ${error.message}`);
  }
}

module.exports = {
  DEFAULT_BODY_LIMIT,
  HttpBodyError,
  InvalidJsonError,
  PayloadTooLargeError,
  UnsupportedMediaTypeError,
  readJsonBody,
};
