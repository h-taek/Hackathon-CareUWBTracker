import * as assert from 'node:assert/strict';
import test from 'node:test';
import { createHttpWriter, sendIngest } from '../../tools/sender.ts';

test('ingest를 JSON POST로 전송하고 202를 허용한다', async () => {
  const calls: { url: string; options: RequestInit }[] = [];
  const payload = { tagId: 'tag-watch', ts: 1 };
  const fetchImpl = (async (url: URL, options: RequestInit) => {
    calls.push({ url: url.toString(), options });
    return { status: 202, text: async () => '' };
  }) as unknown as typeof fetch;

  await sendIngest('http://localhost:8080/ingest', payload, fetchImpl);

  assert.equal(calls[0].url, 'http://localhost:8080/ingest');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal((calls[0].options.headers as Record<string, string>)['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].options.body as string), payload);
});

test('202가 아닌 서버 응답을 오류로 처리한다', async () => {
  await assert.rejects(
    sendIngest('http://localhost:8080/ingest', {}, (async () => ({
      status: 400,
      text: async () => '{"error":"invalid_ingest"}',
    })) as unknown as typeof fetch),
    /ingest server returned 400.*invalid_ingest/,
  );
});

test('HTTP가 아닌 URL을 거부한다', async () => {
  await assert.rejects(
    sendIngest('file:///tmp/ingest', {}, (async () => {}) as unknown as typeof fetch),
    /must use http or https/,
  );
});

test('HTTP writer가 50Hz 입력도 순서를 유지해 전송한다', async () => {
  const sent: number[] = [];
  const errors: Error[] = [];
  const writer = createHttpWriter('http://localhost:8080/ingest', {
    fetchImpl: (async (_url: URL, options: RequestInit) => {
      sent.push(JSON.parse(options.body as string).ts);
      return { status: 202, text: async () => '' };
    }) as unknown as typeof fetch,
    onError: (error) => errors.push(error),
  });

  writer({ ts: 20 });
  writer({ ts: 40 });
  writer({ ts: 60 });
  await writer.done();

  assert.deepEqual(sent, [20, 40, 60]);
  assert.deepEqual(errors, []);
});
