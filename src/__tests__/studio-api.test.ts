import { describe, expect, it } from 'vitest';
import { buildStudioHeaders, deriveStudioUrl, requestStudioJson } from '../utils/studio-api.js';
import type { DebugContext } from '../tools/index.js';

describe('deriveStudioUrl', () => {
  it('keeps remote deployments on the connected origin', () => {
    expect(deriveStudioUrl('https://agents-dev.kore.ai')).toBe('https://agents-dev.kore.ai');
  });

  it('does not rewrite explicit remote ports to the local Studio port', () => {
    expect(deriveStudioUrl('https://agents-dev.kore.ai:8443')).toBe(
      'https://agents-dev.kore.ai:8443',
    );
  });

  it('rewrites explicit local runtime ports to the local Studio port', () => {
    expect(deriveStudioUrl('http://localhost:3112')).toBe('http://localhost:5173');
    expect(deriveStudioUrl('http://127.0.0.1:3112')).toBe('http://127.0.0.1:5173');
  });

  it('returns unparsable URLs unchanged', () => {
    expect(deriveStudioUrl('not a url')).toBe('not a url');
  });
});

describe('buildStudioHeaders', () => {
  it('includes the derived Studio origin for server-side Studio API calls', () => {
    const ctx = {
      httpClient: {
        getBaseUrl: () => 'http://localhost:3112',
        getAuthToken: () => 'token-123',
      },
    } as unknown as DebugContext;

    expect(buildStudioHeaders(ctx)).toEqual({
      'Content-Type': 'application/json',
      Origin: 'http://localhost:5173',
      Authorization: 'Bearer token-123',
    });
  });

  it('prefers an explicit split-port Studio origin', () => {
    const ctx = {
      studioBaseUrl: 'http://127.0.0.1:15173',
      httpClient: {
        getBaseUrl: () => 'http://127.0.0.1:13112',
        getAuthToken: () => 'token-123',
      },
    } as unknown as DebugContext;

    expect(buildStudioHeaders(ctx)).toMatchObject({ Origin: 'http://127.0.0.1:15173' });
  });
});

describe('requestStudioJson', () => {
  it('routes builder requests to an explicit split-port Studio origin', async () => {
    const calls: string[] = [];
    const ctx = {
      studioBaseUrl: 'http://127.0.0.1:15173',
      httpClient: {
        getBaseUrl: () => 'http://127.0.0.1:13112',
        getAuthToken: () => 'token-123',
      },
    } as unknown as DebugContext;

    const result = await requestStudioJson(
      ctx,
      { method: 'GET', path: '/api/arch-mcp/capabilities' },
      {
        fetchWithTimeout: async (url) => {
          calls.push(url);
          return new Response('{}', {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(calls).toEqual(['http://127.0.0.1:15173/api/arch-mcp/capabilities']);
  });
});
