import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';

import { MCPDebugServer } from '../server.js';
import { ARCH_MCP_SERVER_VERSION } from '../tools/persona.js';
import { tools, zodToJsonSchema } from '../tools/index.js';

const LEGACY_TOOL_NAMES = [
  'platform_connect',
  'debug_list_agents',
  'debug_load_agent',
  'debug_send_message',
  'debug_traces',
  'debug_get_current_state',
  'debug_get_span_tree',
  'debug_get_errors',
  'debug_explain_decision',
  'debug_get_flow_graph',
  'debug_list_active_sessions',
  'debug_session',
  'debug_docs',
  'debug_analyze_session',
  'debug_harness_logs',
  'platform_project_builder',
  'platform_project_builder_operations',
  'platform_projects',
  'platform_workflows',
  'platform_arch_sop',
  'platform_arch_auto_loop',
  'platform_auth_profiles',
  'platform_integrations',
  'platform_mcp_servers',
  'platform_agents',
  'platform_versions',
  'platform_deployments',
  'platform_sdk_channels',
  'platform_tools',
  'agent_tables',
  'platform_import_export',
  'platform_validate_package',
  'platform_package_model',
  'debug_lint_abl',
  'debug_why_transcript_failed',
  'debug_diagnose_transcript',
  'platform_eval_personas',
  'platform_eval_scenarios',
  'platform_eval_evaluators',
  'platform_eval_sets',
  'platform_eval_runs',
  'platform_config',
  'platform_workspaces',
  'debug_diagnose',
] as const;

const LEGACY_DISCOVERY_SHA256 = '14b4d57f31a375c7b60eb91571fcf08496dfec8000d8e5da8422f1feb365bc9e';
const active: Array<{ client: Client; server: MCPDebugServer }> = [];
const httpServers: HttpServer[] = [];

afterEach(async () => {
  await Promise.all(
    active.splice(0).map(({ client, server }) => Promise.all([client.close(), server.stop()])),
  );
  await Promise.all(
    httpServers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe('historical session MCP compatibility baseline', () => {
  it('locks the ordered legacy discovery contract', async () => {
    const { client } = await connectedServer();
    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    expect(client.getServerVersion()?.version).toBe(ARCH_MCP_SERVER_VERSION);
    expect(packageJson.version).toBe(ARCH_MCP_SERVER_VERSION);
    const listed = await client.listTools();
    const legacyTools = listed.tools.filter(({ name }) => name !== 'debug_session_history');

    expect(legacyTools.map(({ name }) => name)).toEqual(LEGACY_TOOL_NAMES);
    expect(sha256(legacyTools)).toBe(LEGACY_DISCOVERY_SHA256);
  });

  it('locks representative empty and disconnected live-debug results', async () => {
    const { client } = await connectedServer();

    expect(await callJson(client, 'debug_traces', {})).toEqual({
      success: true,
      count: 0,
      sessionId: null,
      events: [],
    });
    expect(await callJson(client, 'debug_list_active_sessions', {})).toEqual({
      success: false,
      error: 'Not connected to server. Call platform_connect first.',
    });
    expect(
      await callJson(client, 'debug_session', {
        action: 'subscribe',
        sessionId: 'legacy-session',
      }),
    ).toEqual({
      success: false,
      error: 'Not connected to server. Call platform_connect first.',
    });
    expect(await callJson(client, 'debug_analyze_session', {})).toEqual({
      error:
        'No session specified and no active session. Load an agent first with debug_load_agent.',
    });
  });

  it('discovers one additive read-only tool with the exact bounded union schema', async () => {
    const { client } = await connectedServer();
    const listed = await client.listTools();
    const historyTools = listed.tools.filter(({ name }) => name === 'debug_session_history');

    expect(historyTools).toHaveLength(1);
    const history = historyTools[0];
    expect(history.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });
    expect(history.inputSchema).toMatchObject({ type: 'object', oneOf: [{}, {}] });

    const variants = history.inputSchema.oneOf as Array<{
      additionalProperties: boolean;
      properties: Record<string, Record<string, unknown>>;
    }>;
    const list = variants[0];
    const get = variants[1];
    expect(list.additionalProperties).toBe(false);
    expect(get.additionalProperties).toBe(false);
    expect(list.properties.limit).toMatchObject({ minimum: 1, maximum: 200, default: 50 });
    expect(list.properties.projectId).toMatchObject({ minLength: 1, maxLength: 256 });
    expect(list.properties.status).toMatchObject({ minItems: 1, maxItems: 20 });
    expect(list.properties.sortBy.default).toBe('lastActivityAt');
    expect(list.properties.range.pattern).toBe('^[1-9]\\d{0,4}d$');
    expect(get.properties.sessionId).toMatchObject({ minLength: 1, maxLength: 256 });
    expect(get.properties.types).toMatchObject({ minItems: 1, maxItems: 20 });
    for (const excluded of ['projectAgentId', 'currentProjectAgentsOnly', 'hasError', 'search']) {
      expect(list.properties).not.toHaveProperty(excluded);
      expect(get.properties).not.toHaveProperty(excluded);
    }
  });

  it('returns identical structured list/get results over the real SDK protocol path', async () => {
    const requests: string[] = [];
    const baseUrl = await listeningRuntime((requestUrl, response) => {
      requests.push(requestUrl);
      if (requestUrl.includes('/traces?')) {
        json(response, {
          success: true,
          total: 1,
          offset: 0,
          limit: 50,
          traces: [{ id: 'trace-1', futureField: true }],
          _meta: {
            source: 'clickhouse_platform_events',
            event_count: 1,
            loaded_count: 1,
            available_count: 1,
            is_truncated: false,
            source_chain: ['clickhouse_platform_events'],
          },
        });
        return;
      }
      json(response, {
        success: true,
        total: 1,
        offset: 0,
        limit: 50,
        sessions: [{ id: 'session-1', additive: 'preserved' }],
      });
    });
    const { client } = await connectedServer(baseUrl);

    const list = await client.callTool({
      name: 'debug_session_history',
      arguments: { action: 'list', projectId: 'project' },
    });
    const get = await client.callTool({
      name: 'debug_session_history',
      arguments: { action: 'get', projectId: 'project', sessionId: 'session-1' },
    });

    expect(list.isError).toBeUndefined();
    expect(get.isError).toBeUndefined();
    expect(textJson(list)).toEqual(list.structuredContent);
    expect(textJson(get)).toEqual(get.structuredContent);
    expect(requests).toEqual([
      '/api/projects/project/sessions?limit=50&offset=0&sortBy=lastActivityAt&sortDir=desc',
      '/api/projects/project/sessions/session-1/traces?limit=50&offset=0',
    ]);
  });

  it('marks Runtime failures as MCP errors and rejects unsupported fields before HTTP', async () => {
    let requestCount = 0;
    const baseUrl = await listeningRuntime((_requestUrl, response) => {
      requestCount += 1;
      json(response, { success: false, error: { code: 'FORBIDDEN', message: 'Denied' } }, 403);
    });
    const { client } = await connectedServer(baseUrl);
    const failure = await client.callTool({
      name: 'debug_session_history',
      arguments: { action: 'list', projectId: 'project' },
    });
    expect(failure.isError).toBe(true);
    expect(failure.structuredContent).toMatchObject({
      success: false,
      error: { status: 403, code: 'FORBIDDEN', message: 'Denied' },
    });

    const invalid = await client.callTool({
      name: 'debug_session_history',
      arguments: { action: 'list', projectId: 'project', projectAgentId: 'current-only' },
    });
    expect(invalid.isError).toBe(true);
    expect(invalid.structuredContent).toBeUndefined();
    expect(requestCount).toBe(1);
    expect(
      (await client.listTools()).tools.some(({ name }) => name === 'debug_session_history'),
    ).toBe(true);
  });

  it.each(['codex', 'claude', 'generic-mcp-client'])(
    'is client-metadata neutral for %s',
    async (name) => {
      const baseUrl = await listeningRuntime((_requestUrl, response) =>
        json(response, { success: true, total: 0, offset: 0, limit: 50, sessions: [] }),
      );
      const { client } = await connectedServer(baseUrl, name);
      const tool = (await client.listTools()).tools.find(
        (candidate) => candidate.name === 'debug_session_history',
      );
      const result = await client.callTool({
        name: 'debug_session_history',
        arguments: { action: 'list', projectId: 'project' },
      });
      expect(tool?.inputSchema).toMatchObject({ type: 'object', oneOf: [{}, {}] });
      expect(textJson(result)).toEqual({
        success: true,
        total: 0,
        offset: 0,
        limit: 50,
        sessions: [],
      });
    },
  );

  it('retains legacy converter coverage while history uses its exact schema', () => {
    expect(zodToJsonSchema(z.union([z.string(), z.number()]))).toEqual({
      anyOf: [{ type: 'string' }, { type: 'number' }],
    });
    expect(
      zodToJsonSchema(
        z.object({
          nested: z.discriminatedUnion('kind', [
            z.object({ kind: z.literal('a'), value: z.string() }),
            z.object({ kind: z.literal('b'), value: z.number() }),
          ]),
        }),
      ),
    ).toMatchObject({ properties: { nested: { oneOf: [{}, {}] } } });
    expect(zodToJsonSchema(z.string())).toEqual({ type: 'object' });
  });

  it('keeps generic non-Error handler failures bounded and leaves the server usable', async () => {
    const temporary = {
      name: 'test_non_error_failure',
      description: 'coverage-only temporary tool',
      schema: z.object({}),
      handler: async () => Promise.reject({ code: 'EXPECTED_TEST_CODE' }),
    };
    tools.push(temporary);
    try {
      const { client } = await connectedServer();
      const failure = await client.callTool({ name: temporary.name, arguments: {} });
      expect(failure.isError).toBe(true);
      expect(textJson(failure)).toMatchObject({
        error: 'Unknown error',
        errorCode: 'EXPECTED_TEST_CODE',
      });
      expect((await client.listTools()).tools.some(({ name }) => name === temporary.name)).toBe(
        true,
      );
    } finally {
      tools.splice(tools.indexOf(temporary), 1);
    }
  });
});

async function connectedServer(
  httpUrl?: string,
  clientName = 'history-compatibility-test',
): Promise<{ client: Client; server: MCPDebugServer }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = new MCPDebugServer(httpUrl ? { httpUrl } : undefined);
  const client = new Client({ name: clientName, version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  active.push({ client, server });
  return { client, server };
}

function textJson(result: unknown): unknown {
  const content = (result as { content: unknown }).content as Array<{
    type: string;
    text?: string;
  }>;
  return JSON.parse(content[0]?.text ?? 'null') as unknown;
}

async function listeningRuntime(
  handler: (requestUrl: string, response: ServerResponse) => void,
): Promise<string> {
  const server = createServer((request, response) => handler(request.url ?? '', response));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  httpServers.push(server);
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function json(response: ServerResponse, body: unknown, status = 200): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(body));
}

async function callJson(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text?: string }>;
  const text = content[0]?.type === 'text' ? content[0].text : undefined;
  expect(text).toBeDefined();
  return JSON.parse(text ?? 'null') as unknown;
}

function sha256(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
