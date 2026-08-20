import { describe, expect, test } from 'vitest';
import { describeActiveTarget, normalizeServerOrigin } from '../utils/platform-context.js';

describe('platform context metadata', () => {
  test.each([
    { url: 'http://localhost:3112/path', environment: 'local' },
    { url: 'http://[::1]:3112', environment: 'local' },
    { url: 'https://agents-dev.kore.ai', environment: 'development' },
    { url: 'https://agents-staging.kore.ai', environment: 'staging' },
    { url: 'https://agents-qa.kore.ai', environment: 'qa' },
    { url: 'https://agents.kore.ai', environment: 'production' },
    { url: 'https://agents.example.test', environment: 'custom' },
  ])('classifies $url as $environment', ({ url, environment }) => {
    expect(describeActiveTarget(url, null)).toMatchObject({ environment });
  });

  test('reports normalized target identity without exposing the bearer token', () => {
    const token = makeJwt({
      sub: 'user-1',
      tenantId: 'tenant-1',
      email: 'developer@example.com',
    });

    const target = describeActiveTarget(
      'HTTPS://AGENTS-DEV.KORE.AI/path',
      token,
      'wss://agents-dev.kore.ai/ws',
    );

    expect(target).toEqual({
      environment: 'development',
      serverUrl: 'https://agents-dev.kore.ai',
      wsUrl: 'wss://agents-dev.kore.ai/ws',
      tenantId: 'tenant-1',
      subject: 'user-1',
      email: 'developer@example.com',
    });
    expect(JSON.stringify(target)).not.toContain(token);
  });

  test('falls back safely for a custom non-URL target', () => {
    expect(normalizeServerOrigin('CUSTOM-HOST///')).toBe('custom-host');
    expect(describeActiveTarget('CUSTOM-HOST///', 'opaque-token')).toEqual({
      environment: 'custom',
      serverUrl: 'custom-host',
      tenantId: null,
      subject: null,
      email: null,
    });
  });
});

function makeJwt(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'signature',
  ].join('.');
}
