import { describe, expect, it } from 'vitest';
import type { DebugContext } from '../tools/index.js';
import { platformAuthProfiles } from '../tools/platform-auth-profiles.js';
import { platformIntegrations } from '../tools/platform-integrations.js';
import { platformMcpServers } from '../tools/platform-mcp-servers.js';
import {
  platformWorkflows,
  type PlatformWorkflowsDependencies,
} from '../tools/platform-workflows.js';
import type { StudioApiDependencies } from '../utils/studio-api.js';

interface FetchCall {
  url: string;
  options: RequestInit;
  timeoutMs: number;
}

describe('Arch project-building MCP tools', () => {
  it('creates no-auth profile metadata without accepting secrets', async () => {
    const recorder = createRecorder(jsonResponse({ success: true, data: { id: 'auth-1' } }));
    const result = JSON.parse(
      await platformAuthProfiles(
        {
          action: 'create',
          projectId: 'project-1',
          name: 'public-endpoint',
          authType: 'none',
          scope: 'project',
          config: {},
        },
        context(),
        recorder.dependencies,
      ),
    ) as { success: boolean };

    expect(result.success).toBe(true);
    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0]?.url).toBe(
      'https://agents-dev.kore.ai/api/projects/project-1/auth-profiles',
    );
    expect(JSON.parse(String(recorder.calls[0]?.options.body))).toEqual({
      name: 'public-endpoint',
      authType: 'none',
      secrets: {},
      config: {},
      scope: 'project',
      projectId: 'project-1',
    });
  });

  it('returns a secure handoff instead of sending credential profiles through MCP', async () => {
    const recorder = createRecorder(jsonResponse({}));
    const result = JSON.parse(
      await platformAuthProfiles(
        {
          action: 'create',
          projectId: 'project-1',
          name: 'jira-oauth',
          authType: 'oauth2_app',
          config: {},
        },
        context(),
        recorder.dependencies,
      ),
    ) as { success: boolean; secureSetupRequired: boolean };

    expect(result).toMatchObject({ success: false, secureSetupRequired: true });
    expect(recorder.calls).toHaveLength(0);
  });

  it('rejects nested credential fields before making an auth-profile request', async () => {
    const recorder = createRecorder(jsonResponse({}));
    const result = JSON.parse(
      await platformAuthProfiles(
        {
          action: 'create',
          projectId: 'project-1',
          name: 'unsafe',
          authType: 'api_key',
          config: { provider: { apiKey: 'must-not-enter-model-context' } },
        },
        context(),
        recorder.dependencies,
      ),
    ) as { success: boolean; error: string; nextAction: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain('provider.apiKey');
    expect(result.nextAction).toContain('secure Studio auth flow');
    expect(recorder.calls).toHaveLength(0);
  });

  it('creates and tests an integration connection through project-scoped routes', async () => {
    const recorder = createRecorder(
      jsonResponse({ success: true, data: { id: 'connection-1' } }),
      jsonResponse({ success: true, data: { message: 'connected' } }),
    );

    await platformIntegrations(
      {
        action: 'create',
        projectId: 'project-1',
        connectorName: 'jira',
        displayName: 'Jira production',
        authProfileId: 'auth-1',
      },
      context(),
      recorder.dependencies,
    );
    await platformIntegrations(
      { action: 'test', projectId: 'project-1', connectionId: 'connection-1' },
      context(),
      recorder.dependencies,
    );

    expect(recorder.calls.map((call) => [call.options.method, call.url])).toEqual([
      ['POST', 'https://agents-dev.kore.ai/api/projects/project-1/connections'],
      ['POST', 'https://agents-dev.kore.ai/api/projects/project-1/connections/connection-1/test'],
    ]);
  });

  it('provisions an MCP server and imports selected discovered tools', async () => {
    const recorder = createRecorder(
      jsonResponse({ success: true, server: { id: 'server-1' } }),
      jsonResponse({ success: true, successful: 1 }),
    );

    await platformMcpServers(
      {
        action: 'create',
        projectId: 'project-1',
        name: 'jira-mcp',
        transport: 'http',
        url: 'https://mcp.example.test',
        authProfileId: 'auth-1',
      },
      context(),
      recorder.dependencies,
    );
    await platformMcpServers(
      {
        action: 'discover_import',
        projectId: 'project-1',
        serverId: 'server-1',
        toolNames: ['create_issue'],
      },
      context(),
      recorder.dependencies,
    );

    expect(JSON.parse(String(recorder.calls[0]?.options.body))).toMatchObject({
      name: 'jira-mcp',
      transport: 'http',
      authProfileId: 'auth-1',
    });
    expect(recorder.calls[1]?.url).toBe(
      'https://agents-dev.kore.ai/api/projects/project-1/mcp-servers/server-1/tools/discover',
    );
    expect(JSON.parse(String(recorder.calls[1]?.options.body))).toEqual({
      toolNames: ['create_issue'],
    });
  });

  it('creates a workflow-backed ProjectTool and returns agent-linking guidance', async () => {
    const recorder = createRecorder(
      jsonResponse({ success: true, tool: { id: 'tool-1', name: 'run_refund' } }),
    );
    const result = JSON.parse(
      await platformWorkflows(
        {
          action: 'create_tool',
          projectId: 'project-1',
          workflowId: 'workflow-1',
          toolName: 'run_refund',
          toolMode: 'sync',
          paramMapping: { amount: '$.refund_amount' },
        },
        context(),
        recorder.workflowDependencies,
      ),
    ) as { success: boolean; nextActions: string[] };

    expect(result.success).toBe(true);
    expect(JSON.parse(String(recorder.calls[0]?.options.body))).toMatchObject({
      name: 'run_refund',
      toolType: 'workflow',
      workflowId: 'workflow-1',
      mode: 'sync',
      paramMapping: { amount: '$.refund_amount' },
    });
    expect(result.nextActions.join(' ')).toContain('platform_agents');
    expect(result.nextActions.join(' ')).toContain('platform_versions');
  });

  it.each([
    [
      'integration connection',
      () =>
        platformIntegrations(
          { action: 'delete', projectId: 'project-1', connectionId: 'connection-1' },
          context(),
        ),
    ],
    [
      'MCP server',
      () =>
        platformMcpServers(
          { action: 'delete', projectId: 'project-1', serverId: 'server-1' },
          context(),
        ),
    ],
    [
      'auth profile',
      () =>
        platformAuthProfiles(
          { action: 'delete', projectId: 'project-1', profileId: 'auth-1' },
          context(),
        ),
    ],
  ] as const)('requires explicit confirmation before deleting an %s', async (_name, invoke) => {
    const result = JSON.parse(await invoke()) as { success: boolean; needsConfirmation: boolean };
    expect(result).toMatchObject({ success: false, needsConfirmation: true });
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

function createRecorder(...responses: Response[]) {
  const calls: FetchCall[] = [];
  const queue = [...responses];
  const fetchWithTimeout: StudioApiDependencies['fetchWithTimeout'] = async (
    url,
    options = {},
    timeoutMs = 5_000,
  ) => {
    calls.push({ url, options, timeoutMs });
    return queue.shift() ?? jsonResponse({});
  };
  return {
    calls,
    dependencies: { fetchWithTimeout } satisfies StudioApiDependencies,
    workflowDependencies: { fetchWithTimeout } satisfies PlatformWorkflowsDependencies,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    statusText: 'OK',
    headers: { 'Content-Type': 'application/json' },
  });
}
