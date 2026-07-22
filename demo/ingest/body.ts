import * as http from 'node:http';

export const DEFAULT_BODY_LIMIT = 64 * 1024;

export class HttpBodyError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
  }
}

export class UnsupportedMediaTypeError extends HttpBodyError {
  constructor() {
    super('Content-Type must be application/json', 415);
  }
}

export class PayloadTooLargeError extends HttpBodyError {
  constructor(limit: number) {
    super(`request body exceeds ${limit} bytes`, 413);
  }
}

export class InvalidJsonError extends HttpBodyError {
  constructor(message: string) {
    super(message, 400);
  }
}

export async function readJsonBody(
  req: http.IncomingMessage,
  options: { limit?: number } = {},
): Promise<unknown> {
  const limit = options.limit ?? DEFAULT_BODY_LIMIT;
  if (!Number.isInteger(limit) || limit <= 0) throw new RangeError('body limit must be a positive integer');

  const contentType = String(req.headers?.['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') throw new UnsupportedMediaTypeError();

  const declaredLength = Number(req.headers?.['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    throw new PayloadTooLargeError(limit);
  }

  const chunks: Buffer[] = [];
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
    const message = error instanceof Error ? error.message : String(error);
    throw new InvalidJsonError(`malformed JSON: ${message}`);
  }
}
