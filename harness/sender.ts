type FetchImpl = typeof fetch;

export async function sendIngest(url: string, payload: unknown, fetchImpl: FetchImpl = fetch): Promise<void> {
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

export interface HttpWriterOptions {
  fetchImpl?: FetchImpl;
  onError?: (error: Error) => void;
}

export interface HttpWriter {
  (payload: unknown): Promise<void>;
  done: () => Promise<void>;
}

export function createHttpWriter(url: string, options: HttpWriterOptions = {}): HttpWriter {
  const fetchImpl = options.fetchImpl || fetch;
  const onError = options.onError || ((error: Error) => {
    process.stderr.write(`Ingest send failed: ${error.message}\n`);
    process.exitCode = 1;
  });
  let pending: Promise<void> = Promise.resolve();

  const write = ((payload: unknown): Promise<void> => {
    pending = pending.then(() => sendIngest(url, payload, fetchImpl)).catch(onError);
    return pending;
  }) as HttpWriter;
  write.done = () => pending;
  return write;
}

function validateHttpUrl(value: string): URL {
  let url: URL;
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
