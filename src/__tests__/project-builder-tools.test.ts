import { describe, expect, it } from 'vitest';

import type { DebugContext } from '../tools/index.js';
import {
  platformProjectBuilder,
  platformProjectOperations,
} from '../tools/platform-project-builder.js';
import type { StudioApiDependencies } from '../utils/studio-api.js';
import { ARCH_MCP_CAPABILITIES_MEDIA_TYPE } from '../project-building/studio-transport.js';

describe('generic project-builder tools', () => {
  it('describes the production registry without a live request', async () => {
    const recorder = createRecorder();
    const result = await platformProjectBuilder(
      { action: 'describe' },
      context(),
      recorder.dependencies,
    );

    expect(result.structuredContent).toMatchObject({
      schemaVersion: '1.1',
      action: 'describe',
      success: true,
      data: { providers: [{ domain: 'workflow' }] },
    });
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
    expect(recorder.calls).toHaveLength(0);
  });

  it('inspects a provider and plans through its allow-listed route', async () => {
    const provider = await platformProjectBuilder(
      { action: 'describe', domain: 'workflow' },
      context(),
    );
    expect(provider.structuredContent).toMatchObject({
      success: true,
      data: {
        providers: [{ domain: 'workflow' }],
        readinessOwner: { service: 'studio-workflow-builder' },
      },
    });

    const recorder = createRecorder(
      capabilityResponse(),
      jsonResponse({ operationId: 'operation-1', operationVersion: 0 }),
    );
    const planned = await platformProjectBuilder(
      {
        action: 'plan',
        domain: 'workflow',
        projectId: 'project-1',
        input: { goal: 'Build a support project' },
      },
      context(),
      recorder.dependencies,
    );
    expect(planned.structuredContent.success).toBe(true);
    expect(recorder.calls[1]).toMatchObject({
      url: 'https://agents-dev.kore.ai/api/projects/project-1/arch-workflow-builds',
      options: { method: 'POST' },
      timeoutMs: 30_000,
    });
  });

  it('negotiates every live request before one authoritative project request', async () => {
    const recorder = createRecorder(
      capabilityResponse(),
      jsonResponse({ schemaVersion: '1.1', domains: ['workflow'], nodes: [] }),
      capabilityResponse(),
      jsonResponse({ operationId: 'operation-1', operationVersion: 1 }),
    );

    const inspect = await platformProjectBuilder(
      {
        action: 'inspect',
        domain: 'project',
        projectId: 'project/one',
        domains: ['workflow'],
        includeReadiness: false,
      },
      context(),
      recorder.dependencies,
    );
    const read = await platformProjectOperations(
      {
        action: 'read',
        domain: 'workflow',
        projectId: 'project/one',
        operationId: 'operation/one',
      },
      context(),
      recorder.dependencies,
    );

    expect(inspect.structuredContent.success).toBe(true);
    expect(read.structuredContent.success).toBe(true);
    expect(recorder.calls.map(({ url }) => url)).toEqual([
      'https://agents-dev.kore.ai/api/arch-mcp/capabilities',
      'https://agents-dev.kore.ai/api/projects/project%2Fone/arch-project-builder/dependency-report?domains=workflow&includeReadiness=false',
      'https://agents-dev.kore.ai/api/arch-mcp/capabilities',
      'https://agents-dev.kore.ai/api/projects/project%2Fone/arch-workflow-builds/operation%2Fone',
    ]);
    expect(recorder.calls[0]?.options.headers).toMatchObject({
      Accept: ARCH_MCP_CAPABILITIES_MEDIA_TYPE,
    });

    const defaults = createRecorder(capabilityResponse(), jsonResponse({ nodes: [] }));
    await platformProjectBuilder(
      { action: 'inspect', domain: 'project', projectId: 'project-1' },
      context(),
      defaults.dependencies,
    );
    expect(defaults.calls[1]?.url).toContain('domains=workflow&includeReadiness=true');
  });

  it.each([
    ['ambiguous 404', () => jsonResponse({}, 404), 'STUDIO_CAPABILITY_UNKNOWN'],
    [
      'explicit lower version',
      () => capabilityResponse({ schemaVersion: '1.0', contractVersions: ['1.0'] }),
      'STUDIO_UPGRADE_REQUIRED',
    ],
    [
      'invalid media type',
      () => jsonResponse(capabilityBody(), 200, 'application/json'),
      'STUDIO_CAPABILITY_UNKNOWN',
    ],
    [
      'invalid body',
      () => capabilityResponse({ service: 'unexpected' }),
      'STUDIO_CAPABILITY_UNKNOWN',
    ],
    ['empty body', () => capabilityResponse(null), 'STUDIO_CAPABILITY_UNKNOWN'],
    [
      'malformed fields',
      () =>
        capabilityResponse({
          schemaVersion: 11,
          contractVersions: '1.1',
          domains: [{ domain: 1 }, { domain: 'workflow', contractVersions: '1.1' }],
        }),
      'STUDIO_CAPABILITY_UNKNOWN',
    ],
    ['server failure', () => jsonResponse({}, 500), 'STUDIO_CAPABILITY_CHECK_FAILED'],
  ])('fails closed for %s without probing the project', async (_label, response, code) => {
    const recorder = createRecorder(response());
    const result = await platformProjectBuilder(
      { action: 'inspect', domain: 'project', projectId: 'project-1', domains: ['workflow'] },
      context(),
      recorder.dependencies,
    );

    expect(result.structuredContent).toMatchObject({ success: false, error: { code } });
    expect(recorder.calls).toHaveLength(1);
  });

  it('normalizes capability timeout and hidden project responses distinctly', async () => {
    const timeout = createRecorder(new Error('capability timeout'));
    const unknown = await platformProjectOperations(
      { action: 'list', domain: 'workflow', projectId: 'project-1' },
      context(),
      timeout.dependencies,
    );
    expect(unknown.structuredContent).toMatchObject({
      success: false,
      error: { code: 'STUDIO_CAPABILITY_UNKNOWN', retryable: true },
    });

    const hidden = createRecorder(capabilityResponse(), jsonResponse({}, 404));
    const missing = await platformProjectOperations(
      { action: 'list', domain: 'workflow', projectId: 'project-1' },
      context(),
      hidden.dependencies,
    );
    expect(missing.structuredContent).toMatchObject({
      success: false,
      error: { code: 'PROJECT_BUILDER_RESOURCE_NOT_FOUND' },
    });
    expect(hidden.calls).toHaveLength(2);

    const requestFailure = createRecorder(capabilityResponse(), new Error('project timeout'));
    const failed = await platformProjectOperations(
      { action: 'list', domain: 'workflow', projectId: 'project-1' },
      context(),
      requestFailure.dependencies,
    );
    expect(failed.structuredContent).toMatchObject({
      success: false,
      error: { code: 'PROJECT_BUILDER_TRANSPORT_FAILED' },
    });

    const stringFailure = createRecorder(capabilityResponse(), 'network unavailable');
    const stringFailed = await platformProjectOperations(
      { action: 'list', domain: 'workflow', projectId: 'project-1' },
      context(),
      stringFailure.dependencies,
    );
    expect(stringFailed.structuredContent).toMatchObject({
      error: { code: 'PROJECT_BUILDER_TRANSPORT_FAILED' },
    });

    for (const status of [429, 500]) {
      const upstream = createRecorder(capabilityResponse(), jsonResponse({}, status));
      const result = await platformProjectOperations(
        { action: 'list', domain: 'workflow', projectId: 'project-1' },
        context(),
        upstream.dependencies,
      );
      expect(result.structuredContent).toMatchObject({
        error: { code: 'PROJECT_BUILDER_REQUEST_FAILED', retryable: true },
      });
    }
  });

  it('forwards bounded operation list pagination and filters', async () => {
    const recorder = createRecorder(capabilityResponse(), jsonResponse({ operations: [] }));
    const result = await platformProjectOperations(
      {
        action: 'list',
        domain: 'workflow',
        projectId: 'project-1',
        input: { cursor: 'cursor-2', limit: 25, status: 'blocked', stage: 'dependency_setup' },
      },
      context(),
      recorder.dependencies,
    );

    expect(result.structuredContent).toMatchObject({ success: true });
    expect(recorder.calls[1]?.url).toContain(
      '/api/projects/project-1/arch-workflow-builds?cursor=cursor-2&status=blocked&stage=dependency_setup&limit=25',
    );
  });

  it('redacts credential-bearing transport error text', async () => {
    const recorder = createRecorder(
      capabilityResponse(),
      new Error('Authorization: Bearer secret-sentinel'),
    );
    const result = await platformProjectOperations(
      { action: 'list', domain: 'workflow', projectId: 'project-1' },
      context(),
      recorder.dependencies,
    );

    expect(JSON.stringify(result)).not.toContain('secret-sentinel');
    expect(JSON.stringify(result)).toContain('[REDACTED]');
  });

  it('routes operation actions through the provider table without mutation retries', async () => {
    const cases = [
      ['list', undefined, 'GET', '/api/projects/project-1/arch-workflow-builds'],
      [
        'dependency_report',
        'operation-1',
        'GET',
        '/operation-1/dependency-report?includeReadiness=false',
      ],
      [
        'readiness_report',
        'operation-1',
        'GET',
        '/operation-1/dependency-report?includeReadiness=true',
      ],
      ['resume', 'operation-1', 'POST', '/operation-1/resume'],
      ['cancel', 'operation-1', 'POST', '/operation-1/cancel'],
      ['create_confirmation_grant', 'operation-1', 'POST', '/operation-1/confirmation-grants'],
      ['execute_action', 'operation-1', 'POST', '/operation-1/actions'],
    ] as const;

    for (const [action, operationId, method, suffix] of cases) {
      const recorder = createRecorder(capabilityResponse(), jsonResponse({ ok: true }));
      const result = await platformProjectOperations(
        {
          action,
          domain: 'workflow',
          projectId: 'project-1',
          ...(operationId ? { operationId } : {}),
          ...(method === 'POST' ? { input: { operationVersion: 1 } } : {}),
        },
        context(),
        recorder.dependencies,
      );
      expect(result.structuredContent.success).toBe(true);
      expect(recorder.calls).toHaveLength(2);
      expect(recorder.calls[1]?.options.method).toBe(method);
      expect(recorder.calls[1]?.url).toContain(suffix);
    }
  });
});

function context(): DebugContext {
  return {
    httpClient: {
      getBaseUrl: () => 'https://agents-dev.kore.ai',
      getAuthToken: () => 'token-123',
    },
  } as DebugContext;
}

function createRecorder(...responses: unknown[]) {
  const calls: Array<{ url: string; options: RequestInit; timeoutMs: number }> = [];
  const queue = [...responses];
  const fetchWithTimeout: StudioApiDependencies['fetchWithTimeout'] = async (
    url,
    options = {},
    timeoutMs = 5_000,
  ) => {
    calls.push({ url, options, timeoutMs });
    const next = queue.shift();
    if (next instanceof Response) return next;
    if (next !== undefined) throw next;
    return jsonResponse({});
  };
  return { calls, dependencies: { fetchWithTimeout } };
}

function capabilityBody(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: '1.1',
    service: 'arch-project-builder',
    contractVersions: ['1.1'],
    compositeDomain: 'project',
    domains: [{ domain: 'workflow', contractVersions: ['1.1'] }],
    ...overrides,
  };
}

function capabilityResponse(overrides: Record<string, unknown> | null = {}): Response {
  return jsonResponse(
    overrides === null ? null : capabilityBody(overrides),
    200,
    ARCH_MCP_CAPABILITIES_MEDIA_TYPE,
  );
}

function jsonResponse(body: unknown, status = 200, contentType = 'application/json'): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? 'OK' : 'Not Found',
    headers: { 'Content-Type': contentType },
  });
}
