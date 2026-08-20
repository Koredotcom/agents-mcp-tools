/**
 * Tests for HttpClient — runtimeHealthCheck
 */

import { createServer, type RequestListener, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  HttpClient,
  HttpResponseDecodeError,
  type BoundedHttpResult,
} from '../client/http-client.js';
import { DEFAULT_HTTP_URL } from '../constants.js';
import { FetchError } from '../utils/fetch.js';
import { ResponseSizeLimitError } from '../utils/bounded-response.js';

// Save original fetch
const originalFetch = globalThis.fetch;

describe('HttpClient', () => {
  let client: HttpClient;

  beforeEach(() => {
    client = new HttpClient('http://localhost:3112');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('constructor', () => {
    test('defaults to the configured runtime URL or empty string when unset', () => {
      const c = new HttpClient();
      expect(c.getBaseUrl()).toBe(DEFAULT_HTTP_URL ?? '');
    });

    test('accepts custom URL', () => {
      const c = new HttpClient('http://custom:9999');
      expect(c.getBaseUrl()).toBe('http://custom:9999');
    });
  });

  describe('runtimeHealthCheck', () => {
    test('returns reachable with details on 200 JSON response', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ status: 'live' }),
      });

      const result = await client.runtimeHealthCheck();
      expect(result.reachable).toBe(true);
      expect(result.status).toBe(200);
      expect(result.details).toEqual({ status: 'live' });
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'http://localhost:3112/health/live',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    test('returns reachable without details on 200 non-JSON response', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.reject(new Error('not JSON')),
      });

      const result = await client.runtimeHealthCheck();
      expect(result.reachable).toBe(true);
      expect(result.status).toBe(200);
      expect(result.details).toBeUndefined();
    });

    test('returns reachable for 401 (auth needed)', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
      });

      const result = await client.runtimeHealthCheck();
      expect(result.reachable).toBe(true);
      expect(result.status).toBe(401);
    });

    test('returns reachable for 403 (auth needed)', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
      });

      const result = await client.runtimeHealthCheck();
      expect(result.reachable).toBe(true);
      expect(result.status).toBe(403);
    });

    test('returns not reachable for 500', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      });

      const result = await client.runtimeHealthCheck();
      expect(result.reachable).toBe(false);
      expect(result.status).toBe(500);
    });

    test('returns not reachable with error details on ECONNREFUSED', async () => {
      const typeError = new TypeError('fetch failed');
      (typeError as any).cause = { code: 'ECONNREFUSED' };
      globalThis.fetch = vi.fn().mockRejectedValue(typeError);

      const result = await client.runtimeHealthCheck();
      expect(result.reachable).toBe(false);
      expect(result.status).toBeUndefined();
      expect(result.errorCode).toBe('CONNECTION_REFUSED');
      expect(result.error).toContain('Connection refused');
    });

    test('returns not reachable with TIMEOUT on abort', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new DOMException('Aborted', 'AbortError'));

      const result = await client.runtimeHealthCheck();
      expect(result.reachable).toBe(false);
      expect(result.errorCode).toBe('TIMEOUT');
    });

    test('returns not reachable with error string for unknown errors', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('something unexpected'));

      const result = await client.runtimeHealthCheck();
      expect(result.reachable).toBe(false);
      expect(result.error).toContain('something unexpected');
    });
  });

  describe('healthCheck (deprecated)', () => {
    test('returns true when reachable', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
      });

      expect(await client.healthCheck()).toBe(true);
    });

    test('returns false when not reachable', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

      expect(await client.healthCheck()).toBe(false);
    });
  });

  describe('setAuthToken / getHeaders', () => {
    test('includes Bearer token in requests after setAuthToken', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ agents: {} }),
      });

      client.setAuthToken('my-jwt');
      await client.listAgents();

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'http://localhost:3112/api/agents',
        expect.objectContaining({
          headers: { Authorization: 'Bearer my-jwt' },
          signal: expect.any(AbortSignal),
        }),
      );
    });
  });

  describe('post', () => {
    test('includes sanitized JSON error details for non-2xx responses', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: 'Deployment validation failed',
            details: { reason: 'Missing model configuration', token: 'do-not-leak' },
          }),
          { status: 422, statusText: 'Unprocessable Entity' },
        ),
      );

      await expect(client.post('/api/projects/project-1/deployments', {})).rejects.toThrow(
        'POST /api/projects/project-1/deployments failed: 422 Unprocessable Entity: ' +
          '{"error":"Deployment validation failed","details":{"reason":"Missing model configuration","token":"[REDACTED]"}}',
      );
    });

    test('returns parsed JSON on success and supports an omitted body', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      await expect(client.post('/api/test')).resolves.toEqual({ success: true });
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'http://localhost:3112/api/test',
        expect.objectContaining({ method: 'POST', body: undefined }),
      );
    });

    test('sanitizes non-JSON and unreadable error responses', async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce(new Response('authorization=sentinel', { status: 400 }))
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          statusText: 'Broken',
          text: () => Promise.reject(new Error('unreadable')),
        });

      await expect(client.post('/api/test')).rejects.toThrow('authorization=[REDACTED]');
      await expect(client.post('/api/test')).rejects.toThrow('POST /api/test failed: 500 Broken');
    });
  });

  describe('legacy REST methods', () => {
    test('listAgents returns data and preserves its existing failure', async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ agents: {} }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        )
        .mockResolvedValueOnce(new Response(null, { status: 503, statusText: 'Unavailable' }));

      await expect(client.listAgents()).resolves.toEqual({ agents: {} });
      await expect(client.listAgents()).rejects.toThrow('Failed to list agents: Unavailable');
    });

    test('getAgent encodes names and handles success, not found, and failure', async () => {
      const agent = { name: 'agent/name' };
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ success: true, agent }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        )
        .mockResolvedValueOnce(new Response(null, { status: 404 }))
        .mockResolvedValueOnce(new Response(null, { status: 500, statusText: 'Broken' }));

      await expect(client.getAgent('ignored', 'agent/name')).resolves.toEqual(agent);
      expect(globalThis.fetch).toHaveBeenNthCalledWith(
        1,
        'http://localhost:3112/api/agents/agent%2Fname',
        expect.any(Object),
      );
      await expect(client.getAgent('ignored', 'missing')).resolves.toBeNull();
      await expect(client.getAgent('ignored', 'broken')).rejects.toThrow(
        'Failed to get agent: Broken',
      );
    });

    test('generic get preserves success and non-2xx behavior', async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        )
        .mockResolvedValueOnce(new Response(null, { status: 403, statusText: 'Forbidden' }));

      await expect(client.get('/api/test')).resolves.toEqual({ ok: true });
      await expect(client.get('/api/test')).rejects.toThrow('GET /api/test failed: 403 Forbidden');
    });

    test('put handles bodies, omitted bodies, success, and failure', async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ saved: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        )
        .mockResolvedValueOnce(new Response(null, { status: 409, statusText: 'Conflict' }));

      await expect(client.put('/api/test', { value: 1 })).resolves.toEqual({ saved: true });
      await expect(client.put('/api/test')).rejects.toThrow('PUT /api/test failed: 409 Conflict');
      expect(globalThis.fetch).toHaveBeenNthCalledWith(
        2,
        'http://localhost:3112/api/test',
        expect.objectContaining({ body: undefined }),
      );
    });

    test('delete handles JSON, 204, zero length, and failure', async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ deleted: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        )
        .mockResolvedValueOnce(new Response(null, { status: 204 }))
        .mockResolvedValueOnce(
          new Response(null, { status: 200, headers: { 'Content-Length': '0' } }),
        )
        .mockResolvedValueOnce(new Response(null, { status: 500, statusText: 'Broken' }));

      await expect(client.del('/api/test')).resolves.toEqual({ deleted: true });
      await expect(client.del('/api/test')).resolves.toEqual({});
      await expect(client.del('/api/test')).resolves.toEqual({});
      await expect(client.del('/api/test')).rejects.toThrow('DELETE /api/test failed: 500 Broken');
    });

    test('updates base URL and returns a cleared auth token', () => {
      client.setAuthToken('token');
      expect(client.getAuthToken()).toBe('token');
      client.setAuthToken(null);
      expect(client.getAuthToken()).toBeNull();
      client.setBaseUrl('http://127.0.0.1:9999');
      expect(client.getBaseUrl()).toBe('http://127.0.0.1:9999');
    });
  });

  describe('getBoundedJson', () => {
    test('preserves non-2xx status/body and the captured bearer token', async () => {
      let authorization: string | undefined;
      await withHttpServer(
        (_request, response) => {
          authorization = _request.headers.authorization;
          json(response, { success: false, error: { code: 'NOT_FOUND' } }, 404);
        },
        async (baseUrl) => {
          client = new HttpClient(baseUrl);
          client.setAuthToken('history-token');

          await expect(boundedGet(client)).resolves.toEqual({
            status: 404,
            statusText: 'Not Found',
            body: { success: false, error: { code: 'NOT_FOUND' } },
          });
        },
      );
      expect(authorization).toBe('Bearer history-token');
    });

    test('accepts an exact 2 MiB JSON body', async () => {
      const body = jsonStringWithBytes(2 * 1024 * 1024);
      await withHttpServer(
        (_request, response) => {
          response.setHeader('Content-Type', 'application/json');
          response.end(body);
        },
        async (baseUrl) => {
          client = new HttpClient(baseUrl);
          const result = await boundedGet(client);
          expect(result.status).toBe(200);
          expect(typeof result.body).toBe('string');
          expect((result.body as string).length).toBe(body.length - 2);
        },
      );
    });

    test('rejects declared and chunked bodies above 2 MiB', async () => {
      const maxBytes = 2 * 1024 * 1024;
      await withHttpServer(
        (request, response) => {
          response.setHeader('Content-Type', 'application/json');
          if (request.url === '/declared') {
            response.setHeader('Content-Length', String(maxBytes + 1));
            response.end('{}');
            return;
          }
          response.write('"');
          response.write('x'.repeat(maxBytes));
          response.end('"');
        },
        async (baseUrl) => {
          client = new HttpClient(baseUrl);
          await expect(boundedGet(client, '/declared')).rejects.toBeInstanceOf(
            ResponseSizeLimitError,
          );
          await expect(boundedGet(client, '/chunked')).rejects.toBeInstanceOf(
            ResponseSizeLimitError,
          );
        },
      );
    });

    test('uses one deadline for delayed headers and delayed body chunks', async () => {
      await withHttpServer(
        (request, response) => {
          if (request.url === '/headers') {
            setTimeout(() => json(response, { ok: true }), 80);
            return;
          }
          response.setHeader('Content-Type', 'application/json');
          response.write('{"ok":');
          setTimeout(() => response.end('true}'), 80);
        },
        async (baseUrl) => {
          client = new HttpClient(baseUrl);
          for (const path of ['/headers', '/body']) {
            await expect(boundedGet(client, path, 20)).rejects.toMatchObject({
              code: 'TIMEOUT',
            } satisfies Partial<FetchError>);
          }
        },
      );
    });

    test('preserves HTTP status on malformed JSON without retaining the body', async () => {
      await withHttpServer(
        (_request, response) => {
          response.statusCode = 503;
          response.statusMessage = 'Service Unavailable';
          response.end('{authorization=secret');
        },
        async (baseUrl) => {
          client = new HttpClient(baseUrl);
          const error = await boundedGet(client).catch((caught: unknown) => caught);
          expect(error).toBeInstanceOf(HttpResponseDecodeError);
          expect(error).toMatchObject({
            code: 'MALFORMED_RESPONSE',
            status: 503,
            statusText: 'Service Unavailable',
          });
          expect(String(error)).not.toContain('secret');
        },
      );
    });

    test('isolates concurrent request deadlines', async () => {
      await withHttpServer(
        (request, response) => {
          if (request.url === '/slow') {
            setTimeout(() => json(response, { request: 'slow' }), 40);
            return;
          }
          json(response, { request: 'fast' });
        },
        async (baseUrl) => {
          client = new HttpClient(baseUrl);
          const [slow, fast] = await Promise.all([
            boundedGet(client, '/slow', 100),
            boundedGet(client, '/fast', 100),
          ]);
          expect(slow.body).toEqual({ request: 'slow' });
          expect(fast.body).toEqual({ request: 'fast' });
        },
      );
    });
  });
});

function boundedGet(
  client: HttpClient,
  path = '/history',
  timeoutMs = 1_000,
): Promise<BoundedHttpResult> {
  return client.getBoundedJson(path, {
    timeoutMs,
    maxResponseBytes: 2 * 1024 * 1024,
  });
}

async function withHttpServer(
  handler: RequestListener,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function json(response: ServerResponse, body: unknown, status = 200): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(body));
}

function jsonStringWithBytes(bytes: number): string {
  return `"${'x'.repeat(bytes - 2)}"`;
}
