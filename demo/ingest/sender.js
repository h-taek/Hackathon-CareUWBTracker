'use strict';

async function sendIngest(url, payload, fetchImpl = fetch) {
  const endpoint = validateHttpUrl(url);
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (response.status !== 202) {
    const detail = await response.text();
    throw new Error(`ingest server returned ${response.status}${detail ? `: ${detail}` : ''}`);
  }
}

function createHttpWriter(url, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const onError = options.onError || ((error) => {
    process.stderr.write(`Ingest send failed: ${error.message}\n`);
    process.exitCode = 1;
  });
  let pending = Promise.resolve();

  const write = (payload) => {
    pending = pending.then(() => sendIngest(url, payload, fetchImpl)).catch(onError);
    return pending;
  };
  write.done = () => pending;
  return write;
}

function validateHttpUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`invalid ingest URL: ${value}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('ingest URL must use http or https');
  }
  return url;
}

module.exports = { createHttpWriter, sendIngest };
