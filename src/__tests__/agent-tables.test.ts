import { describe, expect, test } from 'vitest';
import { agentTables, type AgentTablesDependencies } from '../tools/agent-tables.js';
import type { DebugContext } from '../tools/index.js';

interface FetchCall {
  url: string;
  options: RequestInit;
  timeoutMs: number;
}

interface FetchRecorder {
  calls: FetchCall[];
  dependencies: AgentTablesDependencies;
}

const ctx = {
  httpClient: {
    getBaseUrl: () => 'http://localhost:3112',
    getAuthToken: () => 'token-123',
  },
} as unknown as DebugContext;

describe('agent_tables MCP tool', () => {
  test('checks availability with environment and deployment context', async () => {
    const fetchRecorder = createFetchRecorder(
      jsonResponse({
        success: true,
        data: { available: false, blockedGate: 'environment' },
      }),
    );

    const result = JSON.parse(
      await agentTables(
        {
          action: 'availability',
          projectId: 'project-1',
          environment: 'staging',
          deploymentId: 'deployment-1',
        },
        ctx,
        fetchRecorder.dependencies,
      ),
    ) as { success: boolean; data: unknown };

    expect(result.success).toBe(true);
    expect(fetchRecorder.calls).toEqual([
      {
        url: 'http://localhost:3112/api/projects/project-1/tables/availability?environment=staging&deploymentId=deployment-1',
        options: { headers: { Authorization: 'Bearer token-123' } },
        timeoutMs: 15_000,
      },
    ]);
  });

  test('creates a table through the Runtime table definition route', async () => {
    const fetchRecorder = createFetchRecorder(
      jsonResponse({ success: true, data: { name: 'orders' } }, { status: 201 }),
    );

    await agentTables(
      {
        action: 'create',
        projectId: 'project-1',
        tableDefinition: {
          name: 'orders',
          displayName: 'Orders',
          scope: 'project',
          columns: [{ name: 'order_id', type: 'string', indexed: true, unique: true }],
        },
      },
      ctx,
      fetchRecorder.dependencies,
    );

    expect(fetchRecorder.calls[0]).toMatchObject({
      url: 'http://localhost:3112/api/projects/project-1/tables',
      options: {
        method: 'POST',
        headers: {
          Authorization: 'Bearer token-123',
          'Content-Type': 'application/json',
        },
      },
      timeoutMs: 30_000,
    });
    expect(JSON.parse(String(fetchRecorder.calls[0]?.options.body))).toMatchObject({
      name: 'orders',
      columns: [{ name: 'order_id' }],
    });
  });

  test('requires confirmation before deleting a table', async () => {
    const fetchRecorder = createFetchRecorder(jsonResponse({}));

    const result = JSON.parse(
      await agentTables(
        { action: 'delete', projectId: 'project-1', table: 'orders' },
        ctx,
        fetchRecorder.dependencies,
      ),
    ) as { success: boolean; needsConfirmation: boolean };

    expect(result).toMatchObject({ success: false, needsConfirmation: true });
    expect(fetchRecorder.calls).toEqual([]);
  });

  test('routes count queries through the legacy GET rows endpoint', async () => {
    const fetchRecorder = createFetchRecorder(jsonResponse({ success: true, data: { count: 3 } }));

    await agentTables(
      {
        action: 'query',
        projectId: 'project-1',
        table: 'orders',
        query: { filters: [{ column: 'status', op: 'eq', value: 'open' }] },
        count: true,
      },
      ctx,
      fetchRecorder.dependencies,
    );

    expect(fetchRecorder.calls[0]?.url).toBe(
      'http://localhost:3112/api/projects/project-1/tables/orders/rows?count=true&q=%7B%22filters%22%3A%5B%7B%22column%22%3A%22status%22%2C%22op%22%3A%22eq%22%2C%22value%22%3A%22open%22%7D%5D%7D',
    );
  });

  test('sanitizes sensitive fields from successful responses', async () => {
    const fetchRecorder = createFetchRecorder(
      jsonResponse({
        success: true,
        data: {
          table: 'orders',
          token: 'secret-token',
          nested: { password: 'secret-password' },
        },
      }),
    );

    const result = JSON.parse(
      await agentTables(
        { action: 'describe', projectId: 'project-1', table: 'orders' },
        ctx,
        fetchRecorder.dependencies,
      ),
    ) as { data: { data: { token: string; nested: { password: string } } } };

    expect(result.data.data.token).toBe('[REDACTED]');
    expect(result.data.data.nested.password).toBe('[REDACTED]');
  });

  test('preserves runtime-authorized sensitive reveal responses', async () => {
    const fetchRecorder = createFetchRecorder(
      jsonResponse({
        success: true,
        data: {
          rowId: 'row-1',
          contact_phone: '+15551234567',
          password: 'runtime-authorized-secret',
        },
      }),
    );

    const result = JSON.parse(
      await agentTables(
        {
          action: 'reveal',
          projectId: 'project-1',
          table: 'travel_disruption_cases',
          rowId: 'row-1',
          columns: ['contact_phone', 'password'],
        },
        ctx,
        fetchRecorder.dependencies,
      ),
    ) as { data: { data: { contact_phone: string; password: string } } };

    expect(fetchRecorder.calls[0]).toMatchObject({
      url: 'http://localhost:3112/api/projects/project-1/tables/travel_disruption_cases/rows/row-1/reveal',
      options: {
        method: 'POST',
        headers: {
          Authorization: 'Bearer token-123',
          'Content-Type': 'application/json',
        },
      },
      timeoutMs: 15_000,
    });
    expect(result.data.data.contact_phone).toBe('+15551234567');
    expect(result.data.data.password).toBe('runtime-authorized-secret');
  });
});

function createFetchRecorder(...responses: Array<Response | Error>): FetchRecorder {
  const calls: FetchCall[] = [];
  const queue = [...responses];
  const fetchWithTimeout: AgentTablesDependencies['fetchWithTimeout'] = async (
    url,
    options = {},
    timeoutMs = 5000,
  ) => {
    calls.push({ url, options, timeoutMs });
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return next ?? jsonResponse({});
  };
  return { calls, dependencies: { fetchWithTimeout } };
}

function jsonResponse(
  body: unknown,
  init: { status?: number; statusText?: string } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    statusText: init.statusText ?? 'OK',
    headers: { 'Content-Type': 'application/json' },
  });
}
