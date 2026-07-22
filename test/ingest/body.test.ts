import * as assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import * as test from 'node:test';
import {
  InvalidJsonError,
  PayloadTooLargeError,
  UnsupportedMediaTypeError,
  readJsonBody,
} from '../../demo/ingest/body.ts';

function request(body: string | null, headers: Record<string, string> = { 'content-type': 'application/json' }) {
  const req = Readable.from(body === null ? [] : [body]) as any;
  req.headers = headers;
  return req;
}

test.test('application/json 본문을 파싱한다', async () => {
  const result = await readJsonBody(request('{"tagId":"tag-watch"}', {
    'content-type': 'application/json; charset=utf-8',
  }));
  assert.deepEqual(result, { tagId: 'tag-watch' });
});

test.test('JSON이 아닌 Content-Type을 415 오류로 거부한다', async () => {
  await assert.rejects(
    readJsonBody(request('{}', { 'content-type': 'text/plain' })),
    (error: any) => error instanceof UnsupportedMediaTypeError && error.statusCode === 415,
  );
});

test.test('빈 본문과 잘못된 JSON을 400 오류로 거부한다', async () => {
  await assert.rejects(
    readJsonBody(request(null)),
    (error: any) => error instanceof InvalidJsonError && error.statusCode === 400,
  );
  await assert.rejects(
    readJsonBody(request('{bad-json}')),
    (error: any) => error instanceof InvalidJsonError && /malformed JSON/.test(error.message),
  );
});

test.test('Content-Length가 제한보다 크면 본문을 읽기 전에 거부한다', async () => {
  await assert.rejects(
    readJsonBody(request('{}', {
      'content-type': 'application/json',
      'content-length': '100',
    }), { limit: 10 }),
    (error: any) => error instanceof PayloadTooLargeError && error.statusCode === 413,
  );
});

test.test('Content-Length 없이 실제 본문이 제한을 넘으면 거부한다', async () => {
  await assert.rejects(
    readJsonBody(request('{"data":"too long"}'), { limit: 10 }),
    PayloadTooLargeError,
  );
});
