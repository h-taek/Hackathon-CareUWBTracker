'use strict';

const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const test = require('node:test');
const {
  InvalidJsonError,
  PayloadTooLargeError,
  UnsupportedMediaTypeError,
  readJsonBody,
} = require('./body');

function request(body, headers = { 'content-type': 'application/json' }) {
  const req = Readable.from(body === null ? [] : [body]);
  req.headers = headers;
  return req;
}

test('application/json 본문을 파싱한다', async () => {
  const result = await readJsonBody(request('{"tagId":"tag-watch"}', {
    'content-type': 'application/json; charset=utf-8',
  }));
  assert.deepEqual(result, { tagId: 'tag-watch' });
});

test('JSON이 아닌 Content-Type을 415 오류로 거부한다', async () => {
  await assert.rejects(
    readJsonBody(request('{}', { 'content-type': 'text/plain' })),
    (error) => error instanceof UnsupportedMediaTypeError && error.statusCode === 415,
  );
});

test('빈 본문과 잘못된 JSON을 400 오류로 거부한다', async () => {
  await assert.rejects(
    readJsonBody(request(null)),
    (error) => error instanceof InvalidJsonError && error.statusCode === 400,
  );
  await assert.rejects(
    readJsonBody(request('{bad-json}')),
    (error) => error instanceof InvalidJsonError && /malformed JSON/.test(error.message),
  );
});

test('Content-Length가 제한보다 크면 본문을 읽기 전에 거부한다', async () => {
  await assert.rejects(
    readJsonBody(request('{}', {
      'content-type': 'application/json',
      'content-length': '100',
    }), { limit: 10 }),
    (error) => error instanceof PayloadTooLargeError && error.statusCode === 413,
  );
});

test('Content-Length 없이 실제 본문이 제한을 넘으면 거부한다', async () => {
  await assert.rejects(
    readJsonBody(request('{"data":"too long"}'), { limit: 10 }),
    PayloadTooLargeError,
  );
});
