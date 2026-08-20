import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { describe, test, expect } from 'vitest';
import { FetchError, classifyFetchError, fetchWithTimeout } from '../utils/fetch.js';

type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

async function withLoopbackServer<T>(
  handler: RequestHandler,
  run: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = createServer((req, res) => {
    void Promise.resolve(handler(req, res)).catch((error: unknown) => {
      res.statusCode = 500;
      res.end(error instanceof Error ? error.message : String(error));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    const closePromise = new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    server.closeAllConnections();
    await closePromise;
  }
}

async function closedLoopbackUrl(path: string): Promise<string> {
  return withLoopbackServer(
    (_req, res) => {
      res.end();
    },
    async (baseUrl) => `${baseUrl}${path}`,
  );
}

function typeErrorWithSystemCause(code: string): TypeError {
  const typeError = new TypeError('fetch failed');
  Object.defineProperty(typeError, 'cause', { value: { code }, configurable: true });
  return typeError;
}

describe('classifyFetchError', () => {
  const url = 'http://localhost:3112/health/live';

  test('returns existing FetchError as-is', () => {
    const existing = new FetchError('already classified', 'TIMEOUT', url);
    const result = classifyFetchError(existing, url);
    expect(result).toBe(existing);
  });

  test('classifies AbortError as TIMEOUT', () => {
    const abort = new DOMException('The operation was aborted', 'AbortError');
    const result = classifyFetchError(abort, url);
    expect(result).toBeInstanceOf(FetchError);
    expect(result.code).toBe('TIMEOUT');
    expect(result.url).toBe(url);
    expect(result.cause).toBe(abort);
  });

  test('classifies TypeError with ECONNREFUSED cause as CONNECTION_REFUSED', () => {
    const typeError = typeErrorWithSystemCause('ECONNREFUSED');
    const result = classifyFetchError(typeError, url);
    expect(result.code).toBe('CONNECTION_REFUSED');
    expect(result.url).toBe(url);
  });

  test('classifies TypeError with ENOTFOUND cause as DNS_LOOKUP_FAILED', () => {
    const typeError = typeErrorWithSystemCause('ENOTFOUND');
    const result = classifyFetchError(typeError, url);
    expect(result.code).toBe('DNS_LOOKUP_FAILED');
  });

  test('classifies TypeError with ECONNREFUSED in message as CONNECTION_REFUSED', () => {
    const typeError = new TypeError('connect ECONNREFUSED 127.0.0.1:3112');
    const result = classifyFetchError(typeError, url);
    expect(result.code).toBe('CONNECTION_REFUSED');
  });

  test('classifies TypeError with ENOTFOUND in message as DNS_LOOKUP_FAILED', () => {
    const typeError = new TypeError('getaddrinfo ENOTFOUND example.invalid');
    const result = classifyFetchError(typeError, url);
    expect(result.code).toBe('DNS_LOOKUP_FAILED');
  });

  test('classifies generic TypeError as NETWORK_ERROR', () => {
    const typeError = new TypeError('Failed to fetch');
    const result = classifyFetchError(typeError, url);
    expect(result.code).toBe('NETWORK_ERROR');
  });

  test('classifies unknown error as UNKNOWN', () => {
    const result = classifyFetchError(new Error('something weird'), url);
    expect(result.code).toBe('UNKNOWN');
    expect(result.message).toContain('something weird');
  });

  test('classifies non-Error value as UNKNOWN', () => {
    const result = classifyFetchError('string error', url);
    expect(result.code).toBe('UNKNOWN');
    expect(result.message).toContain('string error');
  });
});

describe('fetchWithTimeout', () => {
  test('returns response on success', async () => {
    await withLoopbackServer(
      (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      },
      async (baseUrl) => {
        const result = await fetchWithTimeout(`${baseUrl}/health/live`);

        expect(result.ok).toBe(true);
        expect(result.status).toBe(200);
        await expect(result.json()).resolves.toEqual({ ok: true });
      },
    );
  });

  test('throws FetchError with TIMEOUT code on abort', async () => {
    await withLoopbackServer(
      (_req, _res) => undefined,
      async (baseUrl) => {
        const url = `${baseUrl}/health/live`;

        await expect(fetchWithTimeout(url, {}, 20)).rejects.toMatchObject({
          code: 'TIMEOUT',
          url,
        });
      },
    );
  });

  test('throws FetchError with CONNECTION_REFUSED on ECONNREFUSED', async () => {
    const url = await closedLoopbackUrl('/health/live');

    await expect(fetchWithTimeout(url)).rejects.toMatchObject({
      code: 'CONNECTION_REFUSED',
      url,
    });
  });

  test('passes request options through to the HTTP boundary', async () => {
    const requests: Array<{ method?: string; testHeader?: string | string[] }> = [];

    await withLoopbackServer(
      (req, res) => {
        requests.push({
          method: req.method,
          testHeader: req.headers['x-test-header'],
        });
        res.writeHead(204);
        res.end();
      },
      async (baseUrl) => {
        const result = await fetchWithTimeout(`${baseUrl}/health/live`, {
          headers: { 'x-test-header': 'present' },
          method: 'POST',
        });

        expect(result.status).toBe(204);
      },
    );

    expect(requests).toEqual([{ method: 'POST', testHeader: 'present' }]);
  });
});
