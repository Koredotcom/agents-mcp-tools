import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { DebugContext } from '../tools/index.js';
import {
  platformVersions,
  platformVersionsSchema,
  type PlatformVersionsArgs,
} from '../tools/platform-versions.js';
import { tools } from '../tools/index.js';

interface Call {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
}

function harness(responses: unknown[] = []) {
  const calls: Call[] = [];
  const queue = [...responses];
  const next = async () => {
    const value = queue.shift();
    if (value instanceof Error) throw value;
    return value ?? { ok: true };
  };
  const ctx = {
    httpClient: {
      async get(path: string) {
        calls.push({ method: 'GET', path });
        return next();
      },
      async post(path: string, body?: unknown) {
        calls.push({ method: 'POST', path, body });
        return next();
      },
    },
  } as DebugContext;
  return { calls, ctx };
}

function parse(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}

const base = { projectId: 'project-1', agentName: 'support' } as const;

describe('platformVersions', () => {
  it('retains one registered tool with the current actions', () => {
    expect(tools.filter(({ name }) => name === 'platform_versions')).toHaveLength(1);
    expect(
      platformVersionsSchema.parse({ ...base, action: 'publish', version: '1.2.3' }),
    ).toMatchObject({ action: 'publish', version: '1.2.3' });
  });

  it.each([
    ['list', undefined, '/api/projects/project-1/agents/support/versions'],
    ['get', '1.0.0', '/api/projects/project-1/agents/support/versions/1.0.0'],
    [
      'qualifications',
      '1.0.0',
      '/api/projects/project-1/agents/support/versions/1.0.0/qualifications?limit=25',
    ],
    ['audit', '1.0.0', '/api/projects/project-1/agents/support/versions/1.0.0/audit?limit=25'],
  ] as const)('uses the current %s read route', async (action, version, expectedPath) => {
    const { calls, ctx } = harness([{ value: action }]);
    const args = {
      ...base,
      action,
      ...(version ? { version } : {}),
      ...(action === 'qualifications' || action === 'audit' ? { limit: 25 } : {}),
    } as PlatformVersionsArgs;
    expect(parse(await platformVersions(args, ctx))).toMatchObject({ success: true });
    expect(calls).toEqual([{ method: 'GET', path: expectedPath }]);
  });

  it('publishes with the authoritative companion-aware draft hash and one mutation', async () => {
    const dsl = 'AGENT: Café\nGOAL: "help"\n';
    const { calls, ctx } = harness([
      { agent: { dslContent: dsl, sourceHash: 'companion-aware-hash' } },
      { versionId: 'v-1' },
    ]);
    expect(
      parse(
        await platformVersions(
          {
            ...base,
            action: 'publish',
            version: '1.2.3',
            changelog: 'ship',
            publishMode: 'auto',
          },
          ctx,
        ),
      ),
    ).toMatchObject({ success: true, data: { versionId: 'v-1' } });
    expect(calls).toEqual([
      { method: 'GET', path: '/api/projects/project-1/agents/support' },
      {
        method: 'POST',
        path: '/api/projects/project-1/agents/support/versions/publish',
        body: {
          version: '1.2.3',
          changelog: 'ship',
          publishMode: 'auto',
          expectedDraftSourceHash: 'companion-aware-hash',
        },
      },
    ]);
  });

  it('falls back to the raw DSL hash for legacy agent responses', async () => {
    const dsl = 'AGENT: Café\nGOAL: "help"\n';
    const { calls, ctx } = harness([{ agent: { dslContent: dsl } }, { versionId: 'v-1' }]);

    await platformVersions({ ...base, action: 'publish' }, ctx);

    expect(calls[1]?.body).toEqual({
      expectedDraftSourceHash: createHash('sha256').update(dsl).digest('hex'),
    });
  });

  it('passes an explicit hash without an agent GET and supports auto-version publish', async () => {
    const explicit = harness([{ versionId: 'v-1' }]);
    await platformVersions(
      { ...base, action: 'publish', expectedDraftSourceHash: 'caller-hash' },
      explicit.ctx,
    );
    expect(explicit.calls).toEqual([
      {
        method: 'POST',
        path: '/api/projects/project-1/agents/support/versions/publish',
        body: { expectedDraftSourceHash: 'caller-hash' },
      },
    ]);

    const emptyDsl = harness([{}, {}]);
    await platformVersions({ ...base, action: 'publish' }, emptyDsl.ctx);
    expect(emptyDsl.calls[1]?.body).toEqual({
      expectedDraftSourceHash: createHash('sha256').update('').digest('hex'),
    });
  });

  it('keeps safe diff compatibility with encoded string versions', async () => {
    const { calls, ctx } = harness([{}]);
    await platformVersions({ ...base, action: 'diff', version: 1, otherVersion: '2.0.0' }, ctx);
    expect(calls[0]?.path).toBe('/api/projects/project-1/agents/support/versions/1/diff/2.0.0');
  });

  it.each(['create', 'promote'] as const)(
    'returns a local migration error for obsolete %s with zero HTTP',
    async (action) => {
      const { calls, ctx } = harness();
      expect(parse(await platformVersions({ ...base, action }, ctx))).toMatchObject({
        success: false,
        code: 'LEGACY_ACTION_UNSUPPORTED',
      });
      expect(calls).toHaveLength(0);
    },
  );

  it('returns local required-field errors without HTTP', async () => {
    const { calls, ctx } = harness();
    expect(parse(await platformVersions({ ...base, action: 'get' }, ctx))).toMatchObject({
      success: false,
    });
    expect(
      parse(await platformVersions({ ...base, action: 'diff', version: '1.0.0' }, ctx)),
    ).toMatchObject({ success: false, error: expect.stringContaining('otherVersion') });
    expect(calls).toHaveLength(0);
  });

  it('returns structured transport and path validation failures', async () => {
    const failed = harness([new Error('offline')]);
    expect(parse(await platformVersions({ ...base, action: 'list' }, failed.ctx))).toMatchObject({
      success: false,
      error: expect.stringContaining('offline'),
      hint: expect.stringContaining('platform_connect'),
    });
    await expect(
      platformVersions({ ...base, action: 'list', agentName: '../other' }, failed.ctx),
    ).rejects.toThrow('Invalid agentName');
  });
});
