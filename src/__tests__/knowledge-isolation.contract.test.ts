import { describe, expect, it } from 'vitest';
import type { DebugContext } from '../tools/index.js';
import { platformProjectBuilder } from '../tools/platform-project-builder.js';
import {
  ARCH_MCP_CAPABILITIES_MEDIA_TYPE,
  type ProjectBuilderStudioTransportDependencies,
} from '../project-building/studio-transport.js';

describe('knowledge authoritative-live isolation contract', () => {
  it('preserves missing-auth failure without exposing project data', async () => {
    const recorder = transport(
      capabilityResponse(),
      response(401, { secretProject: 'must-not-leak' }),
    );
    const result = await inspect(context(), recorder.dependencies);

    expect(recorder.calls[1]?.options.headers).not.toHaveProperty('Authorization');
    expect(result.structuredContent).toMatchObject({
      success: false,
      error: { code: 'PROJECT_BUILDER_REQUEST_FAILED', retryable: false },
    });
    expect(JSON.stringify(result)).not.toContain('secretProject');
  });

  it.each([
    ['cross-tenant', 'tenant-t2-user-u2'],
    ['cross-project', 'tenant-t1-user-u1-project-p2'],
    ['cross-user', 'tenant-t1-user-u2'],
  ])('preserves concealed 404 for %s access', async (_scenario, token) => {
    const recorder = transport(capabilityResponse(), response(404, { projectId: 'p1' }));
    const result = await inspect(context(token), recorder.dependencies);

    expect(recorder.calls[1]?.options.headers).toMatchObject({ Authorization: `Bearer ${token}` });
    expect(result.structuredContent).toMatchObject({
      success: false,
      error: {
        code: 'PROJECT_BUILDER_RESOURCE_NOT_FOUND',
        message: 'The requested project-builder resource is not visible or does not exist.',
      },
    });
    expect(JSON.stringify(result)).not.toContain('p1');
  });
});

function inspect(ctx: DebugContext, dependencies: ProjectBuilderStudioTransportDependencies) {
  return platformProjectBuilder(
    { action: 'inspect', domain: 'project', projectId: 'p1', domains: ['workflow'] },
    ctx,
    dependencies,
  );
}

function context(token?: string): DebugContext {
  return {
    httpClient: {
      getBaseUrl: () => 'https://studio.example.test',
      getAuthToken: () => token,
    },
  } as DebugContext;
}

function transport(...responses: Response[]) {
  const calls: Array<{ url: string; options: RequestInit }> = [];
  const queue = [...responses];
  const fetchWithTimeout: ProjectBuilderStudioTransportDependencies['fetchWithTimeout'] = async (
    url,
    options = {},
  ) => {
    calls.push({ url, options });
    return queue.shift() ?? response(500, {});
  };
  return { calls, dependencies: { fetchWithTimeout } };
}

function capabilityResponse(): Response {
  return new Response(
    JSON.stringify({
      schemaVersion: '1.1',
      service: 'arch-project-builder',
      contractVersions: ['1.1'],
      domains: [{ domain: 'workflow', contractVersions: ['1.1'] }],
    }),
    { status: 200, headers: { 'Content-Type': ARCH_MCP_CAPABILITIES_MEDIA_TYPE } },
  );
}

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 401 ? 'Unauthorized' : 'Not Found',
    headers: { 'Content-Type': 'application/json' },
  });
}
