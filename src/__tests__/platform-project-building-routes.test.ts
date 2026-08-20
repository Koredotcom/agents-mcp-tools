import { describe, expect, it } from 'vitest';
import type { DebugContext } from '../tools/index.js';
import {
  platformAuthProfiles,
  type PlatformAuthProfilesArgs,
} from '../tools/platform-auth-profiles.js';
import {
  platformIntegrations,
  type PlatformIntegrationsArgs,
} from '../tools/platform-integrations.js';
import { platformMcpServers, type PlatformMcpServersArgs } from '../tools/platform-mcp-servers.js';
import { platformMcpServersSchema } from '../tools/platform-mcp-servers.js';
import {
  platformWorkflows,
  type PlatformWorkflowsArgs,
  type PlatformWorkflowsDependencies,
} from '../tools/platform-workflows.js';
import type { StudioApiDependencies } from '../utils/studio-api.js';
import { findSensitiveFieldPath, sanitizeResponse } from '../utils/sanitize.js';

interface ExpectedRequest {
  method?: string;
  path: string;
  body?: unknown;
}

describe('platform_auth_profiles route contract', () => {
  it.each([
    [{ action: 'list', projectId: 'project-1' }, { path: '/api/projects/project-1/auth-profiles' }],
    [
      { action: 'get', projectId: 'project-1', profileId: 'auth-1' },
      { path: '/api/projects/project-1/auth-profiles/auth-1' },
    ],
    [
      {
        action: 'update',
        projectId: 'project-1',
        profileId: 'auth-1',
        name: 'renamed',
        enabled: true,
      },
      {
        method: 'PUT',
        path: '/api/projects/project-1/auth-profiles/auth-1',
        body: { name: 'renamed', enabled: true },
      },
    ],
    [
      { action: 'validate', projectId: 'project-1', profileId: 'auth-1' },
      { method: 'POST', path: '/api/projects/project-1/auth-profiles/auth-1/validate' },
    ],
    [
      { action: 'revoke', projectId: 'project-1', profileId: 'auth-1', confirm: true },
      { method: 'POST', path: '/api/projects/project-1/auth-profiles/auth-1/revoke' },
    ],
    [
      { action: 'delete', projectId: 'project-1', profileId: 'auth-1', confirm: true },
      { method: 'DELETE', path: '/api/projects/project-1/auth-profiles/auth-1?confirm=true' },
    ],
    [
      { action: 'providers', projectId: 'project-1' },
      { path: '/api/projects/project-1/auth-profiles/providers' },
    ],
    [
      { action: 'integrations', projectId: 'project-1' },
      { path: '/api/projects/project-1/auth-profiles/integrations' },
    ],
    [
      {
        action: 'oauth_initiate',
        projectId: 'project-1',
        authProfileRef: 'jira-oauth',
        connector: 'jira',
        isUserConsent: true,
      },
      {
        method: 'POST',
        path: '/api/projects/project-1/auth-profiles/oauth/initiate',
        body: { authProfileRef: 'jira-oauth', connectorName: 'jira', isUserConsent: true },
      },
    ],
  ] satisfies Array<[PlatformAuthProfilesArgs, ExpectedRequest]>)(
    '$# routes correctly',
    async (args, expected) => {
      const recorder = recorderFor(jsonResponse({ success: true }));
      await platformAuthProfiles(args, context(), recorder.dependencies);
      expectRequest(recorder.calls[0], expected);
    },
  );

  it.each([
    { action: 'get', projectId: 'project-1' },
    { action: 'update', projectId: 'project-1' },
    { action: 'validate', projectId: 'project-1' },
    { action: 'revoke', projectId: 'project-1' },
    { action: 'oauth_initiate', projectId: 'project-1' },
    { action: 'create', projectId: 'project-1', authType: 'none' },
    { action: 'create', projectId: 'project-1', name: 'anonymous' },
  ] satisfies PlatformAuthProfilesArgs[])('rejects missing inputs for $action', async (args) => {
    const result = JSON.parse(await platformAuthProfiles(args, context())) as { success: boolean };
    expect(result.success).toBe(false);
  });

  it('rejects ambiguous OAuth profile references', async () => {
    const result = JSON.parse(
      await platformAuthProfiles(
        {
          action: 'oauth_initiate',
          projectId: 'project-1',
          profileId: 'auth-1',
          authProfileRef: 'jira-oauth',
        },
        context(),
      ),
    ) as { success: boolean; error: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain('exactly one');
  });

  it.each([
    {
      action: 'update',
      projectId: 'project-1',
      profileId: 'auth-1',
      config: { headers: { 'X-API-Key': 'unsafe' } },
    },
    {
      action: 'oauth_initiate',
      projectId: 'project-1',
      profileId: 'auth-1',
      connectionConfig: { note: 'Authorization: Bearer unsafe' },
    },
  ] satisfies PlatformAuthProfilesArgs[])(
    'rejects credential-bearing $action input',
    async (args) => {
      const result = JSON.parse(await platformAuthProfiles(args, context())) as {
        success: boolean;
      };
      expect(result.success).toBe(false);
    },
  );

  it('covers complete project metadata, profile-id OAuth, pagination, and failures', async () => {
    const create = recorderFor(jsonResponse({ success: true }));
    await platformAuthProfiles(
      {
        action: 'create',
        projectId: 'project-1',
        name: 'complete',
        authType: 'none',
        scope: 'project',
        visibility: 'shared',
        environment: 'staging',
        category: 'tickets',
        tags: ['jira'],
        description: 'Complete',
        config: {},
      },
      context(),
      create.dependencies,
    );
    expect(JSON.parse(String(create.calls[0]?.options.body))).toMatchObject({
      projectId: 'project-1',
      scope: 'project',
    });

    const oauth = recorderFor(jsonResponse({ success: true }));
    await platformAuthProfiles(
      {
        action: 'oauth_initiate',
        projectId: 'project-1',
        profileId: 'auth-1',
        environment: null,
        isUserConsent: false,
        connectionConfig: { instance: 'acme' },
      },
      context(),
      oauth.dependencies,
    );
    expect(JSON.parse(String(oauth.calls[0]?.options.body))).toEqual({
      authProfileId: 'auth-1',
      environment: null,
      isUserConsent: false,
      connectionConfig: { instance: 'acme' },
    });

    const list = recorderFor(jsonResponse({ success: true }));
    await platformAuthProfiles(
      {
        action: 'list',
        projectId: 'project-1',
        cursor: 'auth-10',
        limit: 25,
        search: 'jira',
        authType: 'oauth2_app',
      },
      context(),
      list.dependencies,
    );
    expect(list.calls[0]?.url).toContain(
      '/auth-profiles?cursor=auth-10&limit=25&search=jira&authType=oauth2_app',
    );

    const upstream = recorderFor(httpErrorResponse());
    expect(
      JSON.parse(
        await platformAuthProfiles(
          { action: 'list', projectId: 'project-1' },
          context(),
          upstream.dependencies,
        ),
      ).success,
    ).toBe(false);
    const unsafeStatus = recorderFor(
      new Response('failed', { status: 502, statusText: 'authorization=sentinel' }),
    );
    const unsafeStatusResult = await platformAuthProfiles(
      { action: 'list', projectId: 'project-1' },
      context(),
      unsafeStatus.dependencies,
    );
    expect(unsafeStatusResult).not.toContain('sentinel');
    expect(unsafeStatusResult).toContain('[REDACTED]');
    const transport = recorderFor(new Error('offline'));
    expect(
      JSON.parse(
        await platformAuthProfiles(
          { action: 'list', projectId: 'project-1' },
          context(),
          transport.dependencies,
        ),
      ).error,
    ).toContain('offline');
  });
});

describe('platform_integrations route contract', () => {
  it.each([
    [{ action: 'list', projectId: 'project-1' }, { path: '/api/projects/project-1/connections' }],
    [
      { action: 'get', projectId: 'project-1', connectionId: 'connection-1' },
      { path: '/api/projects/project-1/connections/connection-1' },
    ],
    [
      {
        action: 'update',
        projectId: 'project-1',
        connectionId: 'connection-1',
        displayName: 'Jira updated',
        status: 'active',
      },
      {
        method: 'PUT',
        path: '/api/projects/project-1/connections/connection-1',
        body: { displayName: 'Jira updated', status: 'active' },
      },
    ],
    [
      { action: 'delete', projectId: 'project-1', connectionId: 'connection-1', confirm: true },
      { method: 'DELETE', path: '/api/projects/project-1/connections/connection-1' },
    ],
  ] satisfies Array<[PlatformIntegrationsArgs, ExpectedRequest]>)(
    '$# routes correctly',
    async (args, expected) => {
      const recorder = recorderFor(jsonResponse({ success: true }));
      await platformIntegrations(args, context(), recorder.dependencies);
      expectRequest(recorder.calls[0], expected);
    },
  );

  it('rejects secret-bearing metadata and incomplete creates', async () => {
    const unsafe = JSON.parse(
      await platformIntegrations(
        {
          action: 'create',
          projectId: 'project-1',
          connectorName: 'jira',
          displayName: 'Jira',
          authProfileId: 'auth-1',
          metadata: { password: 'unsafe' },
        },
        context(),
      ),
    ) as { success: boolean };
    const incomplete = JSON.parse(
      await platformIntegrations(
        { action: 'create', projectId: 'project-1', connectorName: 'jira' },
        context(),
      ),
    ) as { success: boolean };
    expect(unsafe.success).toBe(false);
    expect(
      JSON.parse(
        await platformIntegrations(
          {
            action: 'update',
            projectId: 'project-1',
            connectionId: 'connection-1',
            metadata: { note: 'Authorization: Bearer unsafe' },
          },
          context(),
        ),
      ).success,
    ).toBe(false);
    expect(incomplete.success).toBe(false);
  });

  it('covers optional fields, missing ids, and failures', async () => {
    const create = recorderFor(jsonResponse({ success: true }));
    await platformIntegrations(
      {
        action: 'create',
        projectId: 'project-1',
        connectorName: 'jira',
        displayName: 'Jira',
        authProfileId: 'auth-1',
        scope: 'user',
        metadata: { region: 'us' },
      },
      context(),
      create.dependencies,
    );
    expect(JSON.parse(String(create.calls[0]?.options.body))).toMatchObject({
      scope: 'user',
      metadata: { region: 'us' },
    });
    const clearMetadata = recorderFor(jsonResponse({ success: true }));
    await platformIntegrations(
      {
        action: 'update',
        projectId: 'project-1',
        connectionId: 'connection-1',
        metadata: null,
      },
      context(),
      clearMetadata.dependencies,
    );
    expect(JSON.parse(String(clearMetadata.calls[0]?.options.body))).toEqual({ metadata: null });
    for (const action of ['get', 'update', 'test', 'delete'] as const) {
      expect(
        JSON.parse(await platformIntegrations({ action, projectId: 'project-1' }, context()))
          .success,
      ).toBe(false);
    }
    const upstream = recorderFor(httpErrorResponse());
    expect(
      JSON.parse(
        await platformIntegrations(
          { action: 'list', projectId: 'project-1' },
          context(),
          upstream.dependencies,
        ),
      ).success,
    ).toBe(false);
    const transport = recorderFor(new Error('offline'));
    expect(
      JSON.parse(
        await platformIntegrations(
          { action: 'list', projectId: 'project-1' },
          context(),
          transport.dependencies,
        ),
      ).error,
    ).toContain('offline');
  });
});

describe('platform_mcp_servers route contract', () => {
  it.each([
    [{ action: 'list', projectId: 'project-1' }, { path: '/api/projects/project-1/mcp-servers' }],
    [
      { action: 'get', projectId: 'project-1', serverId: 'server-1' },
      { path: '/api/projects/project-1/mcp-servers/server-1' },
    ],
    [
      {
        action: 'update',
        projectId: 'project-1',
        serverId: 'server-1',
        name: 'updated-mcp',
        autoReconnect: true,
      },
      {
        method: 'PUT',
        path: '/api/projects/project-1/mcp-servers/server-1',
        body: { name: 'updated-mcp', autoReconnect: true },
      },
    ],
    [
      { action: 'delete', projectId: 'project-1', serverId: 'server-1', confirm: true },
      { method: 'DELETE', path: '/api/projects/project-1/mcp-servers/server-1' },
    ],
    [
      { action: 'test_connection', projectId: 'project-1', serverId: 'server-1' },
      {
        method: 'POST',
        path: '/api/projects/project-1/mcp-servers/server-1/test-connection',
        body: {},
      },
    ],
    [
      {
        action: 'authorize',
        projectId: 'project-1',
        serverId: 'server-1',
        purpose: 'discovery',
      },
      {
        method: 'POST',
        path: '/api/projects/project-1/mcp-servers/server-1/authorize',
        body: { purpose: 'discovery' },
      },
    ],
    [
      { action: 'grant_status', projectId: 'project-1', serverId: 'server-1' },
      { path: '/api/projects/project-1/mcp-servers/server-1/grant-status' },
    ],
    [
      { action: 'disconnect', projectId: 'project-1', serverId: 'server-1', confirm: true },
      { method: 'POST', path: '/api/projects/project-1/mcp-servers/server-1/disconnect', body: {} },
    ],
    [
      { action: 'discover_preview', projectId: 'project-1', serverId: 'server-1' },
      {
        method: 'POST',
        path: '/api/projects/project-1/mcp-servers/server-1/tools/discover/preview',
        body: {},
      },
    ],
    [
      { action: 'list_tools', projectId: 'project-1', serverId: 'server-1' },
      { path: '/api/projects/project-1/mcp-servers/server-1/tools' },
    ],
    [
      {
        action: 'test_tool',
        projectId: 'project-1',
        serverId: 'server-1',
        toolName: 'create issue',
        input: { summary: 'Help' },
      },
      {
        method: 'POST',
        path: '/api/projects/project-1/mcp-servers/server-1/tools/create%20issue/test',
        body: { input: { summary: 'Help' } },
      },
    ],
  ] satisfies Array<[PlatformMcpServersArgs, ExpectedRequest]>)(
    '$# routes correctly',
    async (args, expected) => {
      const recorder = recorderFor(jsonResponse({ success: true }));
      await platformMcpServers(args, context(), recorder.dependencies);
      expectRequest(recorder.calls[0], expected);
    },
  );

  it('rejects secret test input and missing action identifiers', async () => {
    const unsafe = JSON.parse(
      await platformMcpServers(
        {
          action: 'test_tool',
          projectId: 'project-1',
          serverId: 'server-1',
          toolName: 'unsafe',
          input: { access_token: 'unsafe' },
        },
        context(),
      ),
    ) as { success: boolean };
    const missing = JSON.parse(
      await platformMcpServers(
        { action: 'test_tool', projectId: 'project-1', serverId: 'server-1' },
        context(),
      ),
    ) as { success: boolean };
    expect(unsafe.success).toBe(false);
    expect(
      JSON.parse(
        await platformMcpServers(
          {
            action: 'create',
            projectId: 'project-1',
            name: 'unsafe-url',
            transport: 'http',
            url: 'https://user:sentinel@mcp.example.test',
          },
          context(),
        ),
      ).success,
    ).toBe(false);
    expect(
      JSON.parse(
        await platformMcpServers(
          {
            action: 'test_tool',
            projectId: 'project-1',
            serverId: 'server-1',
            toolName: 'unsafe',
            input: { headers: { 'X-API-Key': 'unsafe' } },
          },
          context(),
        ),
      ).success,
    ).toBe(false);
    expect(missing.success).toBe(false);
    expect(
      platformMcpServersSchema.safeParse({
        action: 'create',
        projectId: 'project-1',
        name: 'inline-auth',
        transport: 'http',
        url: 'https://mcp.example.test',
        authType: 'bearer',
      }).success,
    ).toBe(false);
    expect(
      JSON.parse(
        await platformMcpServers(
          {
            action: 'create',
            projectId: 'project-1',
            name: 'missing-url',
            transport: 'http',
          },
          context(),
        ),
      ).success,
    ).toBe(false);
  });

  it('rejects empty metadata updates before transport', async () => {
    const integrations = recorderFor(jsonResponse({ success: true }));
    const servers = recorderFor(jsonResponse({ success: true }));
    const integrationResult = JSON.parse(
      await platformIntegrations(
        { action: 'update', projectId: 'project-1', connectionId: 'connection-1' },
        context(),
        integrations.dependencies,
      ),
    ) as { success: boolean };
    const serverResult = JSON.parse(
      await platformMcpServers(
        { action: 'update', projectId: 'project-1', serverId: 'server-1' },
        context(),
        servers.dependencies,
      ),
    ) as { success: boolean };

    expect(integrationResult.success).toBe(false);
    expect(serverResult.success).toBe(false);
    expect(integrations.calls).toHaveLength(0);
    expect(servers.calls).toHaveLength(0);
  });

  it('covers complete config, missing ids, confirmations, and failures', async () => {
    const create = recorderFor(jsonResponse({ success: true }));
    await platformMcpServers(
      {
        action: 'create',
        projectId: 'project-1',
        name: 'complete',
        description: 'Complete',
        transport: 'sse',
        url: 'https://mcp.example.test/sse',
        authProfileId: 'auth-1',
        tlsAuthProfileId: 'tls-1',
        consentMode: 'inline',
        priority: 2,
        tags: ['jira'],
        connectionTimeoutMs: 5_000,
        requestTimeoutMs: 10_000,
        autoReconnect: false,
        maxReconnectAttempts: 0,
      },
      context(),
      create.dependencies,
    );
    expect(JSON.parse(String(create.calls[0]?.options.body))).toMatchObject({
      tlsAuthProfileId: 'tls-1',
      autoReconnect: false,
      maxReconnectAttempts: 0,
    });
    for (const action of [
      'get',
      'update',
      'delete',
      'test_connection',
      'authorize',
      'grant_status',
      'disconnect',
      'discover_preview',
      'discover_import',
      'list_tools',
      'test_tool',
    ] as const) {
      expect(
        JSON.parse(await platformMcpServers({ action, projectId: 'project-1' }, context())).success,
      ).toBe(false);
    }
    expect(
      JSON.parse(
        await platformMcpServers(
          { action: 'disconnect', projectId: 'project-1', serverId: 'server-1' },
          context(),
        ),
      ).needsConfirmation,
    ).toBe(true);
    const upstream = recorderFor(httpErrorResponse());
    expect(
      JSON.parse(
        await platformMcpServers(
          { action: 'list', projectId: 'project-1' },
          context(),
          upstream.dependencies,
        ),
      ).success,
    ).toBe(false);
    const transport = recorderFor(new Error('offline'));
    expect(
      JSON.parse(
        await platformMcpServers(
          { action: 'list', projectId: 'project-1' },
          context(),
          transport.dependencies,
        ),
      ).error,
    ).toContain('offline');
  });
});

describe('platform_workflows route contract', () => {
  it('rejects credential-bearing workflow payloads before transport', async () => {
    const recorder = recorderFor(jsonResponse({ success: true }));
    const result = JSON.parse(
      await platformWorkflows(
        {
          action: 'execute',
          projectId: 'project-1',
          workflowId: 'workflow-1',
          input: { credential: 'sentinel' },
        },
        context(),
        recorder.workflowDependencies,
      ),
    ) as { success: boolean };

    expect(result.success).toBe(false);
    expect(recorder.calls).toHaveLength(0);
  });

  const nodes = [
    { id: 'start', nodeType: 'start', name: 'Start', position: { x: 0, y: 0 } },
    { id: 'end', nodeType: 'end', name: 'End', position: { x: 200, y: 0 } },
  ];

  it.each([
    [{ action: 'list', projectId: 'project-1' }, { path: '/api/projects/project-1/workflows' }],
    [
      { action: 'get', projectId: 'project-1', workflowId: 'workflow-1' },
      { path: '/api/projects/project-1/workflows/workflow-1' },
    ],
    [
      { action: 'create', projectId: 'project-1', name: 'approval', nodes },
      {
        method: 'POST',
        path: '/api/projects/project-1/workflows',
        body: { name: 'approval', type: 'cx_automation', nodes },
      },
    ],
    [
      {
        action: 'update',
        projectId: 'project-1',
        workflowId: 'workflow-1',
        description: 'Updated',
        nodes,
      },
      {
        method: 'PATCH',
        path: '/api/projects/project-1/workflows/workflow-1',
        body: { description: 'Updated', nodes },
      },
    ],
    [
      { action: 'publish', projectId: 'project-1', workflowId: 'workflow-1', changelog: 'Ready' },
      {
        method: 'POST',
        path: '/api/projects/project-1/workflows/workflow-1/versions/publish',
        body: { changelog: 'Ready' },
      },
    ],
    [
      {
        action: 'execute',
        projectId: 'project-1',
        workflowId: 'workflow-1',
        input: { amount: 42 },
      },
      {
        method: 'POST',
        path: '/api/projects/project-1/workflows/workflow-1/execute',
        body: { input: { amount: 42 } },
      },
    ],
    [
      { action: 'delete', projectId: 'project-1', workflowId: 'workflow-1', confirm: true },
      { method: 'DELETE', path: '/api/projects/project-1/workflows/workflow-1' },
    ],
  ] satisfies Array<[PlatformWorkflowsArgs, ExpectedRequest]>)(
    '$# routes correctly',
    async (args, expected) => {
      const recorder = recorderFor(jsonResponse({ success: true }));
      await platformWorkflows(args, context(), recorder.workflowDependencies);
      expectRequest(recorder.calls[0], expected);
    },
  );

  it.each([
    { action: 'get', projectId: 'project-1' },
    { action: 'create', projectId: 'project-1', nodes },
    { action: 'create', projectId: 'project-1', name: 'empty' },
    { action: 'update', projectId: 'project-1' },
    { action: 'publish', projectId: 'project-1' },
    { action: 'execute', projectId: 'project-1' },
    { action: 'create_tool', projectId: 'project-1', workflowId: 'workflow-1' },
    { action: 'delete', projectId: 'project-1', workflowId: 'workflow-1' },
  ] satisfies PlatformWorkflowsArgs[])(
    'rejects incomplete or unconfirmed $action',
    async (args) => {
      const result = JSON.parse(await platformWorkflows(args, context())) as { success: boolean };
      expect(result.success).toBe(false);
    },
  );

  it('sanitizes upstream errors and reports transport failures', async () => {
    const upstream = recorderFor(
      new Response(JSON.stringify({ token: 'unsafe', message: 'failed' }), {
        status: 502,
        statusText: 'Bad Gateway',
      }),
    );
    const upstreamResult = JSON.parse(
      await platformWorkflows(
        { action: 'list', projectId: 'project-1' },
        context(),
        upstream.workflowDependencies,
      ),
    ) as { body: { token: string } };
    expect(upstreamResult.body.token).toBe('[REDACTED]');

    const unsafeStatus = recorderFor(
      new Response('failed', { status: 502, statusText: 'authorization=sentinel' }),
    );
    const unsafeStatusResult = await platformWorkflows(
      { action: 'list', projectId: 'project-1' },
      context(),
      unsafeStatus.workflowDependencies,
    );
    expect(unsafeStatusResult).not.toContain('sentinel');
    expect(unsafeStatusResult).toContain('[REDACTED]');

    const transport = recorderFor(new Error('offline'));
    const transportResult = JSON.parse(
      await platformWorkflows(
        { action: 'list', projectId: 'project-1' },
        context(),
        transport.workflowDependencies,
      ),
    ) as { success: boolean; error: string };
    expect(transportResult.success).toBe(false);
    expect(transportResult.error).toContain('offline');
  });

  it('covers optional workflow payloads and empty delete responses', async () => {
    const create = recorderFor(jsonResponse({ success: true }));
    const edges = [{ id: 'edge-1', source: 'start', sourceHandle: 'on_success', target: 'end' }];
    await platformWorkflows(
      {
        action: 'create',
        projectId: 'project-1',
        name: 'complete',
        workflowType: 'internal',
        description: 'Complete',
        nodes,
        edges,
      },
      context(),
      create.workflowDependencies,
    );
    expect(JSON.parse(String(create.calls[0]?.options.body))).toMatchObject({
      type: 'internal',
      description: 'Complete',
      edges,
    });
    const list = recorderFor(jsonResponse({ success: true }));
    await platformWorkflows(
      { action: 'list', projectId: 'project-1', limit: 20, offset: 40 },
      context(),
      list.workflowDependencies,
    );
    expect(list.calls[0]?.url).toContain('/workflows?limit=20&offset=40');
    const tool = recorderFor(jsonResponse({ success: true }));
    await platformWorkflows(
      {
        action: 'create_tool',
        projectId: 'project-1',
        workflowId: 'workflow-1',
        toolName: 'run_complete',
        toolDescription: 'Run it',
        timeoutMs: 2_000,
      },
      context(),
      tool.workflowDependencies,
    );
    expect(JSON.parse(String(tool.calls[0]?.options.body))).toMatchObject({
      description: 'Run it',
      timeoutMs: 2_000,
    });
    const deletion = recorderFor(new Response('not-json', { status: 200, statusText: 'OK' }));
    expect(
      JSON.parse(
        await platformWorkflows(
          { action: 'delete', projectId: 'project-1', workflowId: 'workflow-1', confirm: true },
          context(),
          deletion.workflowDependencies,
        ),
      ).success,
    ).toBe(true);
  });

  it('covers every workflow upstream-error branch and optional defaults', async () => {
    const failingActions: PlatformWorkflowsArgs[] = [
      { action: 'get', projectId: 'project-1', workflowId: 'workflow-1' },
      { action: 'create', projectId: 'project-1', name: 'workflow', nodes },
      {
        action: 'update',
        projectId: 'project-1',
        workflowId: 'workflow-1',
        name: 'updated',
        workflowType: 'ex_automation',
        edges: [],
      },
      { action: 'publish', projectId: 'project-1', workflowId: 'workflow-1' },
      { action: 'execute', projectId: 'project-1', workflowId: 'workflow-1' },
      {
        action: 'create_tool',
        projectId: 'project-1',
        workflowId: 'workflow-1',
        toolName: 'run_workflow',
      },
      { action: 'delete', projectId: 'project-1', workflowId: 'workflow-1', confirm: true },
    ];
    for (const args of failingActions) {
      const recorder = recorderFor(httpErrorResponse());
      const result = JSON.parse(
        await platformWorkflows(args, context(), recorder.workflowDependencies),
      ) as { success: boolean };
      expect(result.success).toBe(false);
    }
  });
});

describe('project-building secret sanitization', () => {
  it('walks arrays and primitives and sanitizes nested response values', () => {
    expect(findSensitiveFieldPath([{ safe: true }, { nested: { refreshToken: 'unsafe' } }])).toBe(
      '[1].nested.refreshToken',
    );
    expect(findSensitiveFieldPath('plain')).toBeNull();
    expect(findSensitiveFieldPath({ headers: { 'X-API-Key': 'unsafe' } })).toBe(
      'headers.X-API-Key',
    );
    expect(findSensitiveFieldPath({ metadata: { note: 'Authorization: Bearer unsafe' } })).toBe(
      'metadata.note',
    );
    expect(sanitizeResponse(null)).toBeNull();
    expect(sanitizeResponse('plain')).toBe('plain');
    expect(sanitizeResponse('Authorization: Bearer unsafe')).toBe(
      'Authorization=[REDACTED] [REDACTED]',
    );
    expect(sanitizeResponse([{ access_token: 'unsafe' }, { safe: 'ok' }])).toEqual([
      { access_token: '[REDACTED]' },
      { safe: 'ok' },
    ]);
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

function recorderFor(...responses: Array<Response | Error>) {
  const calls: Array<{ url: string; options: RequestInit; timeoutMs: number }> = [];
  const queue = [...responses];
  const fetchWithTimeout: StudioApiDependencies['fetchWithTimeout'] = async (
    url,
    options = {},
    timeoutMs = 5_000,
  ) => {
    calls.push({ url, options, timeoutMs });
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return next ?? jsonResponse({ success: true });
  };
  return {
    calls,
    dependencies: { fetchWithTimeout } satisfies StudioApiDependencies,
    workflowDependencies: { fetchWithTimeout } satisfies PlatformWorkflowsDependencies,
  };
}

function expectRequest(
  call: { url: string; options: RequestInit; timeoutMs: number } | undefined,
  expected: ExpectedRequest,
): void {
  expect(call?.url).toBe(`https://agents-dev.kore.ai${expected.path}`);
  expect(call?.options.method ?? 'GET').toBe(expected.method ?? 'GET');
  if (expected.body === undefined) {
    expect(call?.options.body).toBeUndefined();
  } else {
    expect(JSON.parse(String(call?.options.body))).toEqual(expected.body);
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    statusText: 'OK',
    headers: { 'Content-Type': 'application/json' },
  });
}

function httpErrorResponse(): Response {
  return new Response(JSON.stringify({ error: 'unavailable' }), {
    status: 503,
    statusText: 'Service Unavailable',
    headers: { 'Content-Type': 'application/json' },
  });
}
