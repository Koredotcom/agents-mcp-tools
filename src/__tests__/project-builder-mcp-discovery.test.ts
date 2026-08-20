import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { MCPDebugServer } from '../server.js';
import type { ProjectBuilderDomainProvider } from '../project-building/contracts.js';
import type { StudioApiDependencies } from '../utils/studio-api.js';
import { ARCH_MCP_CAPABILITIES_MEDIA_TYPE } from '../project-building/studio-transport.js';

const active: Array<{ client: Client; server: MCPDebugServer }> = [];

afterEach(async () => {
  await Promise.all(
    active.splice(0).map(({ client, server }) => Promise.all([client.close(), server.stop()])),
  );
});

describe('project-builder MCP protocol discovery', () => {
  it('redacts credential-bearing schema errors at the protocol boundary', async () => {
    const { client } = await connectedServer();
    const result = await client.callTool({
      name: 'platform_agents',
      arguments: { action: 'authorization=sentinel', projectId: 'project-1' },
    });
    const content = result.content as Array<{ type: string; text?: string }>;
    const text = content[0]?.type === 'text' ? (content[0].text ?? '') : '';

    expect(result.isError).toBe(true);
    expect(text).not.toContain('sentinel');
    expect(text).toContain('[REDACTED]');
  });

  it('advertises exactly two generic tools with equal text and structured envelopes', async () => {
    const { client } = await connectedServer();
    expect(client.getInstructions()).toContain('Workflow is the first provider');
    const listed = await client.listTools();
    const builderTools = listed.tools.filter(({ name }) => name.startsWith('platform_project_'));

    expect(builderTools.map(({ name }) => name)).toEqual([
      'platform_project_builder',
      'platform_project_builder_operations',
    ]);
    for (const tool of builderTools) {
      expect(tool.inputSchema).toMatchObject({ type: 'object', oneOf: expect.any(Array) });
      expect((tool.inputSchema as unknown as { oneOf: unknown[] }).oneOf.length).toBeGreaterThan(1);
      expect(tool.outputSchema).toMatchObject({ type: 'object' });
      expect(tool.annotations).toMatchObject({ openWorldHint: true });
    }
    expect(JSON.stringify(builderTools[0]?.inputSchema)).toContain('describe');
    expect(JSON.stringify(builderTools[1]?.inputSchema)).toContain('operationId');

    const called = await client.callTool({
      name: 'platform_project_builder',
      arguments: { action: 'describe' },
    });
    expect(called.isError).not.toBe(true);
    const content = called.content as Array<{ type: string; text?: string }>;
    const text = content[0]?.type === 'text' ? (content[0].text ?? '') : '';
    expect(JSON.parse(text)).toEqual(called.structuredContent);
  });

  it('lists and reads static resources, templates, and prompts through the real SDK', async () => {
    const { client } = await connectedServer();
    const resources = await client.listResources();
    expect(resources.resources.slice(0, 2).map(({ uri }) => uri)).toEqual([
      'arch://project-builder/registry',
      'arch://project-builder/providers/workflow',
    ]);

    const registry = await client.readResource({ uri: 'arch://project-builder/registry' });
    expect(
      JSON.parse('text' in registry.contents[0] ? registry.contents[0].text : ''),
    ).toMatchObject({
      contractVersion: '1.1',
      providers: [{ domain: 'workflow' }],
    });
    const provider = await client.readResource({
      uri: 'arch://project-builder/providers/workflow',
    });
    expect(
      JSON.parse('text' in provider.contents[0] ? provider.contents[0].text : ''),
    ).toMatchObject({
      providers: [{ domain: 'workflow' }],
      readinessOwner: { service: 'studio-workflow-builder' },
    });

    const templates = await client.listResourceTemplates();
    expect(templates.resourceTemplates.slice(0, 1)).toEqual([
      expect.objectContaining({ name: 'project-builder-project-report' }),
    ]);

    const prompts = await client.listPrompts();
    expect(prompts.prompts.slice(0, 2).map(({ name }) => name)).toEqual([
      'build-agentic-project',
      'continue-project-operation',
    ]);
    const prompt = await client.getPrompt({
      name: 'continue-project-operation',
      arguments: { projectId: 'project-1', operationId: 'operation-1' },
    });
    expect(prompt.messages[0]?.content).toMatchObject({
      type: 'text',
      text: expect.stringContaining('Never retry a consumed action'),
    });
    const build = await client.getPrompt({
      name: 'build-agentic-project',
      arguments: {
        goal: 'Build support automation',
        projectId: 'project-1',
        domain: 'workflow',
      },
    });
    expect(build.messages[0]?.content).toMatchObject({
      type: 'text',
      text: expect.stringContaining('Goal: Build support automation'),
    });
  });

  it('uses injected providers for discovery without changing the public convention', async () => {
    const { client } = await connectedServer({ projectBuilderProviders: [syntheticProvider()] });
    const resources = await client.listResources();
    expect(resources.resources.slice(0, 2).map(({ uri }) => uri)).toEqual([
      'arch://project-builder/registry',
      'arch://project-builder/providers/synthetic',
    ]);
    const called = await client.callTool({
      name: 'platform_project_builder',
      arguments: { action: 'describe' },
    });
    expect(called.structuredContent).toMatchObject({
      data: { providers: [{ domain: 'synthetic' }] },
    });
  });

  it('reads the live resource template through capability negotiation and project visibility', async () => {
    const recorder = createRecorder(
      jsonResponse(
        {
          schemaVersion: '1.1',
          service: 'arch-project-builder',
          contractVersions: ['1.1'],
          domains: [{ domain: 'workflow', contractVersions: ['1.1'] }],
        },
        ARCH_MCP_CAPABILITIES_MEDIA_TYPE,
      ),
      jsonResponse({ schemaVersion: '1.1', nodes: [], readiness: 'ready' }),
    );
    const { client } = await connectedServer({
      projectBuilderTransportDependencies: recorder.dependencies,
    });

    const result = await client.readResource({
      uri: 'arch://project-builder/projects/project-1/dependency-report?domains=workflow&includeReadiness=true',
    });

    const body = JSON.parse('text' in result.contents[0] ? result.contents[0].text : '');
    expect(body).toMatchObject({ action: 'inspect', success: true });
    expect(recorder.calls.map(({ url }) => url)).toEqual([
      expect.stringContaining('/api/arch-mcp/capabilities'),
      expect.stringContaining(
        '/api/projects/project-1/arch-project-builder/dependency-report?domains=workflow&includeReadiness=true',
      ),
    ]);
  });

  it('normalizes builder validation errors into the advertised envelope', async () => {
    const { client } = await connectedServer();
    const called = await client.callTool({
      name: 'platform_project_builder',
      arguments: { action: 'describe', domain: 'WORKFLOW', unexpected: true },
    });

    expect(called.isError).toBe(true);
    expect(called.structuredContent).toMatchObject({
      schemaVersion: '1.1',
      success: false,
      error: { code: 'PROJECT_BUILDER_INVALID_REQUEST' },
    });
    const content = called.content as Array<{ type: string; text?: string }>;
    const text = content[0]?.type === 'text' ? (content[0].text ?? '') : '';
    expect(JSON.parse(text)).toEqual(called.structuredContent);

    const unknown = await client.callTool({ name: 'does_not_exist', arguments: {} });
    expect(unknown.isError).toBe(true);
    const legacyInvalid = await client.callTool({
      name: 'platform_projects',
      arguments: { action: 'not-an-action' },
    });
    expect(legacyInvalid.isError).toBe(true);
  });

  it('keeps prompt and resource failures explicit', async () => {
    const { client } = await connectedServer();
    await expect(
      client.getPrompt({ name: 'build-agentic-project', arguments: {} }),
    ).rejects.toThrow(/goal is required/);
    await expect(client.getPrompt({ name: 'unknown-prompt' })).rejects.toThrow(/Unknown/);
    await expect(client.readResource({ uri: 'arch://different/resource' })).rejects.toThrow(
      /Unknown/,
    );
    await expect(
      client.readResource({ uri: 'arch://project-builder/unrecognized' }),
    ).rejects.toThrow(/Unknown/);
  });

  it('wires existing websocket callbacks without changing their behavior', async () => {
    const server = new MCPDebugServer({ serverUrl: 'https://agents-dev.kore.ai' });
    const internal = server as unknown as {
      wsClient: {
        onTraceEvent?: (sessionId: string, event: unknown) => void;
        onStateUpdate?: (sessionId: string, state: unknown) => void;
        onAgentLoaded?: (sessionId: string, agent: unknown) => void;
        onConnected?: () => void;
        onDisconnected?: () => void;
        onError?: (message: string) => void;
        onInfo?: (message: string, configured: boolean) => void;
      };
    };
    internal.wsClient.onTraceEvent?.('session-1', {
      id: 'event-1',
      sessionId: 'session-1',
      timestamp: Date.now(),
      type: 'info',
      data: {},
    });
    internal.wsClient.onStateUpdate?.('session-1', {});
    internal.wsClient.onAgentLoaded?.('session-1', {});
    internal.wsClient.onConnected?.();
    internal.wsClient.onDisconnected?.();
    internal.wsClient.onError?.('expected test error');
    internal.wsClient.onInfo?.('expected test info', true);
    await server.stop();
  });
});

async function connectedServer(
  options: {
    projectBuilderProviders?: readonly ProjectBuilderDomainProvider[];
    projectBuilderTransportDependencies?: StudioApiDependencies;
  } = {},
) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = new MCPDebugServer(options);
  const client = new Client({ name: 'project-builder-test', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  active.push({ client, server });
  return { client, server };
}

function createRecorder(...responses: Response[]) {
  const calls: Array<{ url: string; options: RequestInit; timeoutMs: number }> = [];
  const queue = [...responses];
  const fetchWithTimeout: StudioApiDependencies['fetchWithTimeout'] = async (
    url,
    options = {},
    timeoutMs = 5_000,
  ) => {
    calls.push({ url, options, timeoutMs });
    return queue.shift() ?? jsonResponse({});
  };
  return { calls, dependencies: { fetchWithTimeout } };
}

function jsonResponse(body: unknown, contentType = 'application/json'): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': contentType },
  });
}

function syntheticProvider(): ProjectBuilderDomainProvider {
  return {
    domain: 'synthetic',
    contractVersion: '1.1',
    ontology: {
      kinds: [{ id: 'synthetic:resource', label: 'Synthetic resource' }],
      edges: [],
      lifecycle: [],
    },
    actions: [],
    inputSchemas: {},
    outputSchemas: {},
    imports: [],
    exports: [{ id: 'synthetic:resource', kind: 'synthetic:resource' }],
    readinessOwner: {
      kind: 'authoritative_service',
      service: 'synthetic-service',
      supportsDependencyOnly: true,
      assertions: [],
    },
    routeAdapter: {
      supportedActions: [],
      buildRequest: () => {
        throw new Error('Synthetic provider has no live actions.');
      },
    },
  };
}
