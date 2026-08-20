import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const enabled = process.env.ARCH_PROJECT_BUILDER_E2E === 'true';
const suite = enabled ? describe : describe.skip;
const MCP_CONNECTION_TIMEOUT_MS = 60_000;
const LIVE_TOOL_CALL_TIMEOUT_MS = 60_000;
const DURABLE_OPERATION_TIMEOUT_MS = 120_000;

suite('project-builder built MCP to real Studio', () => {
  let client: Client;
  let transport: StdioClientTransport;
  let mode: string;
  let projectId: string;
  let studioUrl: string;
  let runtimeUrl: string;
  let accessToken: string;

  beforeAll(async () => {
    studioUrl = requiredEnv('ARCH_PROJECT_BUILDER_STUDIO_URL');
    runtimeUrl = requiredEnv('ARCH_PROJECT_BUILDER_RUNTIME_URL');
    accessToken = requiredEnv('ARCH_PROJECT_BUILDER_ACCESS_TOKEN');
    projectId = requiredEnv('ARCH_PROJECT_BUILDER_PROJECT_ID');
    mode = requiredEnv('ARCH_PROJECT_BUILDER_E2E_MODE');
    transport = new StdioClientTransport({
      command: process.execPath,
      args: ['dist/bin/mcp-debug.js', '--server-url', runtimeUrl, '--studio-url', studioUrl],
      cwd: process.cwd(),
      stderr: 'inherit',
    });
    client = new Client({ name: 'arch-project-builder-release-lane', version: '1.1.0' });
    await client.connect(transport);
    const connected = await client.callTool({
      name: 'platform_connect',
      arguments: { serverUrl: runtimeUrl, authToken: accessToken },
    });
    expect(parseText(connected)).toMatchObject({ success: true });
  }, MCP_CONNECTION_TIMEOUT_MS);

  afterAll(async () => {
    await client?.close();
  });

  it('preserves discovery, server identity, and legacy text-only behavior', async () => {
    expect(client.getServerVersion()).toMatchObject({ name: 'arch-agent-platform' });
    const listed = await client.listTools();
    expect(
      listed.tools
        .filter(({ name }) => name.startsWith('platform_project_'))
        .map(({ name }) => name),
    ).toEqual(['platform_project_builder', 'platform_project_builder_operations']);
    const described = await client.callTool({
      name: 'platform_project_builder',
      arguments: { action: 'describe' },
    });
    expect(parseText(described)).toEqual(described.structuredContent);
    expect(described.structuredContent).toMatchObject({ success: true, schemaVersion: '1.1' });

    const legacy = await client.callTool({
      name: 'platform_projects',
      arguments: { action: 'list' },
    });
    expect(() => parseText(legacy)).not.toThrow();
  });

  it(
    'negotiates the expected current or prior Studio contract',
    async () => {
      const result = await client.callTool({
        name: 'platform_project_builder',
        arguments: {
          action: 'inspect',
          domain: 'project',
          projectId,
          domains: ['workflow'],
          includeReadiness: false,
        },
      });
      const text = parseText(result);
      expect(text).toEqual(result.structuredContent);
      if (mode === 'current') {
        expect(result.isError).not.toBe(true);
        expect(text).toMatchObject({ action: 'inspect', success: true, schemaVersion: '1.1' });
      } else {
        expect(mode).toBe('prior');
        expect(result.isError).toBe(true);
        expect(text).toMatchObject({
          success: false,
          error: { code: 'STUDIO_CAPABILITY_UNKNOWN' },
        });
      }
    },
    LIVE_TOOL_CALL_TIMEOUT_MS,
  );

  it(
    'keeps a durable idempotent operation visible across MCP process restart',
    async () => {
      if (mode !== 'current') return;
      const idempotencyKey = `mcp-e2e-${Date.now()}`;
      const input = {
        goal: 'Create a support workflow and expose it as an agent tool',
        idempotencyKey,
      };
      const first = await client.callTool({
        name: 'platform_project_builder',
        arguments: { action: 'plan', domain: 'workflow', projectId, input },
      });
      const replay = await client.callTool({
        name: 'platform_project_builder',
        arguments: { action: 'plan', domain: 'workflow', projectId, input },
      });
      const firstBody = asRecord(parseText(first));
      const replayBody = asRecord(parseText(replay));
      const operation = nestedRecord(firstBody, 'data', 'operation');
      const replayOperation = nestedRecord(replayBody, 'data', 'operation');
      const operationId = requiredString(operation, 'operationId');
      expect(requiredString(replayOperation, 'operationId')).toBe(operationId);

      const restarted = await connectedClient({ studioUrl, runtimeUrl, accessToken });
      try {
        const read = await restarted.client.callTool({
          name: 'platform_project_builder_operations',
          arguments: { action: 'read', domain: 'workflow', projectId, operationId },
        });
        expect(parseText(read)).toEqual(read.structuredContent);
        expect(nestedRecord(asRecord(parseText(read)), 'data', 'operation')).toMatchObject({
          operationId,
          status: 'active',
        });
      } finally {
        await restarted.client.close();
      }

      const cancelled = await client.callTool({
        name: 'platform_project_builder_operations',
        arguments: {
          action: 'cancel',
          domain: 'workflow',
          projectId,
          operationId,
          input: {
            operationVersion: operation.operationVersion,
            reason: 'Release-lane teardown',
            idempotencyKey: `${idempotencyKey}-cancel`,
          },
        },
      });
      expect(nestedRecord(asRecord(parseText(cancelled)), 'data', 'operation')).toMatchObject({
        operationId,
        status: 'cancelled',
      });
    },
    DURABLE_OPERATION_TIMEOUT_MS,
  );
});

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required when ARCH_PROJECT_BUILDER_E2E=true.`);
  return value;
}

function parseText(result: unknown): unknown {
  if (!result || typeof result !== 'object' || !('content' in result)) {
    throw new Error('MCP result did not include content.');
  }
  const content = result.content as Array<{ type: string; text?: string }>;
  const text = content[0]?.type === 'text' ? content[0].text : undefined;
  if (!text) throw new Error('MCP result did not include JSON text content.');
  return JSON.parse(text);
}

async function connectedClient(input: {
  studioUrl: string;
  runtimeUrl: string;
  accessToken: string;
}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      'dist/bin/mcp-debug.js',
      '--server-url',
      input.runtimeUrl,
      '--studio-url',
      input.studioUrl,
    ],
    cwd: process.cwd(),
    stderr: 'inherit',
  });
  const client = new Client({ name: 'arch-project-builder-restart-proof', version: '1.1.0' });
  await client.connect(transport);
  const connected = await client.callTool({
    name: 'platform_connect',
    arguments: { serverUrl: input.runtimeUrl, authToken: input.accessToken },
  });
  expect(parseText(connected)).toMatchObject({ success: true });
  return { client, transport };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected an object result.');
  }
  return value as Record<string, unknown>;
}

function nestedRecord(value: Record<string, unknown>, ...path: string[]): Record<string, unknown> {
  let current: unknown = value;
  for (const segment of path) current = asRecord(current)[segment];
  return asRecord(current);
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const result = value[key];
  if (typeof result !== 'string' || !result) throw new Error(`Expected ${key} to be a string.`);
  return result;
}
