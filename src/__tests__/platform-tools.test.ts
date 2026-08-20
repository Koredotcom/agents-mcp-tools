import { describe, expect, it } from 'vitest';
import {
  platformTools,
  platformToolsSchema,
  type PlatformToolsArgs,
  type PlatformToolsDependencies,
} from '../tools/platform-tools.js';
import type { DebugContext } from '../tools/index.js';

interface FetchCall {
  url: string;
  options: RequestInit;
  timeoutMs: number;
}

interface FetchRecorder {
  calls: FetchCall[];
  dependencies: PlatformToolsDependencies;
}

describe('platformTools', () => {
  it('exposes bounded pagination parameters for list requests', () => {
    expect(
      platformToolsSchema.parse({
        action: 'list',
        projectId: 'proj_123',
        page: 2,
        limit: 50,
      }),
    ).toEqual({
      action: 'list',
      projectId: 'proj_123',
      page: 2,
      limit: 50,
    });
  });

  it.each([
    { field: 'page', value: 0 },
    { field: 'page', value: 1.5 },
    { field: 'limit', value: 0 },
    { field: 'limit', value: 201 },
    { field: 'limit', value: 1.5 },
  ])('rejects invalid $field pagination value $value', ({ field, value }) => {
    expect(
      platformToolsSchema.safeParse({
        action: 'list',
        projectId: 'proj_123',
        [field]: value,
      }).success,
    ).toBe(false);
  });

  it.each([1_000, 300_000])('accepts test timeout %dms at the Studio bounds', (timeoutMs) => {
    expect(
      platformToolsSchema.safeParse({
        action: 'test',
        projectId: 'proj_123',
        toolId: 'tool_1',
        timeoutMs,
      }).success,
    ).toBe(true);
  });

  it.each([999, 300_001, 1_500.5])('rejects invalid test timeout %dms', (timeoutMs) => {
    expect(
      platformToolsSchema.safeParse({
        action: 'test',
        projectId: 'proj_123',
        toolId: 'tool_1',
        timeoutMs,
      }).success,
    ).toBe(false);
  });

  it('keeps remote Studio requests on the connected origin', async () => {
    const fetchRecorder = createFetchRecorder(jsonResponse({ tools: [] }));

    const ctx = createContext('https://agents-dev.kore.ai');

    const result = JSON.parse(
      await platformTools(
        { action: 'list', projectId: 'proj_123' },
        ctx,
        fetchRecorder.dependencies,
      ),
    ) as { success: boolean; data: { tools: unknown[] } };

    expect(result).toEqual({ success: true, data: { tools: [] } });
    expect(fetchRecorder.calls).toEqual([
      {
        url: 'https://agents-dev.kore.ai/api/projects/proj_123/tools',
        options: {
          headers: {
            Authorization: 'Bearer token-123',
            'Content-Type': 'application/json',
            Origin: 'https://agents-dev.kore.ai',
          },
        },
        timeoutMs: 10_000,
      },
    ]);
  });

  it('forwards list pagination to the Studio API', async () => {
    const fetchRecorder = createFetchRecorder(jsonResponse({ tools: [] }));

    await platformTools(
      { action: 'list', projectId: 'proj_123', page: 2, limit: 50 },
      createContext('https://agents-dev.kore.ai'),
      fetchRecorder.dependencies,
    );

    expect(fetchRecorder.calls[0]?.url).toBe(
      'https://agents-dev.kore.ai/api/projects/proj_123/tools?page=2&limit=50',
    );
  });

  it('rewrites local runtime requests to the local Studio port', async () => {
    const fetchRecorder = createFetchRecorder(jsonResponse({ tools: [] }));

    const ctx = createContext('http://localhost:3112');

    await platformTools({ action: 'list', projectId: 'proj_123' }, ctx, fetchRecorder.dependencies);

    expect(fetchRecorder.calls[0]?.url).toBe('http://localhost:5173/api/projects/proj_123/tools');
    expect(fetchRecorder.calls[0]?.timeoutMs).toBe(10_000);
  });

  it('forwards list pagination without changing headers or timeout', async () => {
    const fetchRecorder = createFetchRecorder(
      jsonResponse({
        success: true,
        data: [{ id: 'tool_51' }],
        pagination: { page: 2, limit: 50, total: 92, hasMore: false },
      }),
    );

    const result = JSON.parse(
      await platformTools(
        { action: 'list', projectId: 'proj_123', page: 2, limit: 50 },
        createContext('https://agents-dev.kore.ai'),
        fetchRecorder.dependencies,
      ),
    ) as {
      success: boolean;
      data: { pagination: { page: number; limit: number; total: number; hasMore: boolean } };
    };

    expect(result.data.pagination).toEqual({ page: 2, limit: 50, total: 92, hasMore: false });
    expect(fetchRecorder.calls).toEqual([
      {
        url: 'https://agents-dev.kore.ai/api/projects/proj_123/tools?page=2&limit=50',
        options: {
          headers: {
            Authorization: 'Bearer token-123',
            'Content-Type': 'application/json',
            Origin: 'https://agents-dev.kore.ai',
          },
        },
        timeoutMs: 10_000,
      },
    ]);
  });

  it.each([
    {
      name: 'gets a tool',
      args: { action: 'get', projectId: 'proj_123', toolId: 'tool_1' },
      response: { id: 'tool_1', name: 'lookup' },
      expectedCall: {
        url: 'https://agents-dev.kore.ai/api/projects/proj_123/tools/tool_1',
        method: undefined,
        body: undefined,
        timeoutMs: 10_000,
      },
    },
    {
      name: 'creates a tool from definition plus top-level overrides',
      args: {
        action: 'create',
        projectId: 'proj_123',
        name: 'lookup',
        type: 'http',
        definition: { method: 'GET', url: 'https://api.example.test/search' },
      },
      response: { id: 'tool_1' },
      expectedCall: {
        url: 'https://agents-dev.kore.ai/api/projects/proj_123/tools',
        method: 'POST',
        body: {
          method: 'GET',
          url: 'https://api.example.test/search',
          name: 'lookup',
          toolType: 'http',
        },
        timeoutMs: 10_000,
      },
    },
    {
      name: 'updates a tool',
      args: {
        action: 'update',
        projectId: 'proj_123',
        toolId: 'tool_1',
        name: 'lookup-v2',
        definition: { timeoutMs: 2_000 },
      },
      response: { id: 'tool_1', name: 'lookup-v2' },
      expectedCall: {
        url: 'https://agents-dev.kore.ai/api/projects/proj_123/tools/tool_1',
        method: 'PUT',
        body: { timeoutMs: 2_000, name: 'lookup-v2' },
        timeoutMs: 10_000,
      },
    },
    {
      name: 'deletes a confirmed tool',
      args: { action: 'delete', projectId: 'proj_123', toolId: 'tool_1', confirm: true },
      response: {},
      expectedCall: {
        url: 'https://agents-dev.kore.ai/api/projects/proj_123/tools/tool_1',
        method: 'DELETE',
        body: undefined,
        timeoutMs: 10_000,
      },
    },
    {
      name: 'tests a tool with the longer execution timeout',
      args: {
        action: 'test',
        projectId: 'proj_123',
        toolId: 'tool_1',
        input: { request: JSON.stringify({ member_id: 'member-1' }) },
        timeoutMs: 45_000,
      },
      response: { ok: true },
      expectedCall: {
        url: 'https://agents-dev.kore.ai/api/projects/proj_123/tools/tool_1/test',
        method: 'POST',
        body: {
          input: { request: JSON.stringify({ member_id: 'member-1' }) },
          timeoutMs: 45_000,
        },
        timeoutMs: 45_000,
      },
    },
  ] satisfies Array<{
    name: string;
    args: PlatformToolsArgs;
    response: unknown;
    expectedCall: {
      url: string;
      method?: string;
      body?: unknown;
      timeoutMs: number;
    };
  }>)('$name', async ({ args, response, expectedCall }) => {
    const fetchRecorder = createFetchRecorder(jsonResponse(response));

    const result = JSON.parse(
      await platformTools(
        args,
        createContext('https://agents-dev.kore.ai'),
        fetchRecorder.dependencies,
      ),
    ) as { success: boolean; data: unknown };

    expect(result).toMatchObject({ success: true });
    expect(fetchRecorder.calls).toHaveLength(1);
    const call = fetchRecorder.calls[0];
    expect(call).toBeDefined();
    expect(call?.url).toBe(expectedCall.url);
    expect(call?.timeoutMs).toBe(expectedCall.timeoutMs);
    expect(call?.options.method).toBe(expectedCall.method);
    if (expectedCall.body === undefined) {
      expect(call?.options.body).toBeUndefined();
    } else {
      expect(JSON.parse(String(call?.options.body))).toEqual(expectedCall.body);
    }
  });

  it('keeps the Studio body valid when no test input is provided', async () => {
    const fetchRecorder = createFetchRecorder(jsonResponse({ ok: true }));

    await platformTools(
      { action: 'test', projectId: 'proj_123', toolId: 'tool_1' },
      createContext('https://agents-dev.kore.ai'),
      fetchRecorder.dependencies,
    );

    expect(fetchRecorder.calls[0]?.options.body).toBe('{}');
    expect(fetchRecorder.calls[0]?.timeoutMs).toBe(15_000);
  });

  it('requires confirmation before deleting a tool', async () => {
    const fetchRecorder = createFetchRecorder(jsonResponse({}));

    const result = JSON.parse(
      await platformTools(
        { action: 'delete', projectId: 'proj_123', toolId: 'tool_1' },
        createContext('https://agents-dev.kore.ai'),
        fetchRecorder.dependencies,
      ),
    ) as { success: boolean; needsConfirmation: boolean };

    expect(result).toMatchObject({ success: false, needsConfirmation: true });
    expect(fetchRecorder.calls).toHaveLength(0);
  });

  it.each([
    {
      action: 'get' as const,
      expectedError: 'toolId is required for the "get" action.',
    },
    {
      action: 'update' as const,
      expectedError: 'toolId is required for the "update" action.',
    },
    {
      action: 'delete' as const,
      expectedError: 'toolId is required for the "delete" action.',
    },
    {
      action: 'test' as const,
      expectedError: 'toolId is required for the "test" action.',
    },
  ])('validates toolId before $action requests', async ({ action, expectedError }) => {
    const fetchRecorder = createFetchRecorder(jsonResponse({}));

    const result = JSON.parse(
      await platformTools(
        { action, projectId: 'proj_123' },
        createContext('https://agents-dev.kore.ai'),
        fetchRecorder.dependencies,
      ),
    ) as { success: boolean; error: string };

    expect(result).toEqual({ success: false, error: expectedError });
    expect(fetchRecorder.calls).toHaveLength(0);
  });

  it.each([
    {
      action: 'list' as const,
      args: {},
      method: 'GET',
      path: '/api/projects/proj_123/tools',
    },
    {
      action: 'get' as const,
      args: { toolId: 'tool_1' },
      method: 'GET',
      path: '/api/projects/proj_123/tools/tool_1',
    },
    {
      action: 'delete' as const,
      args: { toolId: 'tool_1', confirm: true },
      method: 'DELETE',
      path: '/api/projects/proj_123/tools/tool_1',
    },
  ])('returns the upstream status when $action fails', async ({ action, args, method, path }) => {
    const fetchRecorder = createFetchRecorder(httpErrorResponse(503, 'Service Unavailable'));

    const result = JSON.parse(
      await platformTools(
        { action, projectId: 'proj_123', ...args },
        createContext('https://agents-dev.kore.ai'),
        fetchRecorder.dependencies,
      ),
    ) as { success: boolean; error: string };

    // `delete` also forwards the upstream body as `hint` (ABLP-3265) so a 409
    // listing the agents/workflows that still reference the tool is visible.
    expect(result).toMatchObject({
      success: false,
      error: `${method} https://agents-dev.kore.ai${path} failed: 503 Service Unavailable`,
    });
  });

  it.each([
    {
      action: 'create' as const,
      args: { definition: { timeoutMs: 1_000 } },
      method: 'POST',
      path: '/api/projects/proj_123/tools',
    },
    {
      action: 'update' as const,
      args: { toolId: 'tool_1', definition: { timeoutMs: 1_000 } },
      method: 'PUT',
      path: '/api/projects/proj_123/tools/tool_1',
    },
    {
      action: 'test' as const,
      args: { toolId: 'tool_1' },
      method: 'POST',
      path: '/api/projects/proj_123/tools/tool_1/test',
    },
  ])(
    'returns a safe empty hint when the $action error body cannot be read',
    async ({ action, args, method, path }) => {
      const fetchRecorder = createFetchRecorder(textFailureResponse(502, 'Bad Gateway'));

      const result = JSON.parse(
        await platformTools(
          { action, projectId: 'proj_123', ...args },
          createContext('https://agents-dev.kore.ai'),
          fetchRecorder.dependencies,
        ),
      ) as { success: boolean; error: string };

      expect(result).toEqual({
        success: false,
        error: `${method} https://agents-dev.kore.ai${path} failed: 502 Bad Gateway`,
      });
    },
  );

  it('returns a structured error for an unknown action', async () => {
    const fetchRecorder = createFetchRecorder(jsonResponse({}));

    const result = JSON.parse(
      await platformTools(
        { action: 'unknown', projectId: 'proj_123' } as unknown as PlatformToolsArgs,
        createContext('https://agents-dev.kore.ai'),
        fetchRecorder.dependencies,
      ),
    ) as { success: boolean; error: string };

    expect(result).toEqual({ success: false, error: 'Unknown action: unknown' });
    expect(fetchRecorder.calls).toHaveLength(0);
  });

  it('rejects credentials in tool definitions and redacts upstream error hints', async () => {
    const rejectedFetch = createFetchRecorder(jsonResponse({}));
    const rejected = JSON.parse(
      await platformTools(
        {
          action: 'create',
          projectId: 'proj_123',
          name: 'unsafe',
          definition: { config: { credential: 'sentinel' } },
        },
        createContext('https://agents-dev.kore.ai'),
        rejectedFetch.dependencies,
      ),
    ) as { success: boolean };
    expect(rejected.success).toBe(false);
    expect(rejectedFetch.calls).toHaveLength(0);

    const rejectedName = JSON.parse(
      await platformTools(
        { action: 'create', projectId: 'proj_123', name: 'credential=sentinel', definition: {} },
        createContext('https://agents-dev.kore.ai'),
        rejectedFetch.dependencies,
      ),
    ) as { success: boolean };
    expect(rejectedName.success).toBe(false);
    expect(rejectedFetch.calls).toHaveLength(0);

    const upstream = createFetchRecorder(
      new Response('authorization=sentinel', { status: 502, statusText: 'Bad Gateway' }),
    );
    const failure = await platformTools(
      { action: 'create', projectId: 'proj_123', name: 'safe', definition: {} },
      createContext('https://agents-dev.kore.ai'),
      upstream.dependencies,
    );
    expect(failure).not.toContain('sentinel');
    expect(failure).toContain('[REDACTED]');
  });

  it('returns a Studio hint when the fetch operation fails', async () => {
    const fetchRecorder = createFetchRecorder(new Error('offline'));

    const result = JSON.parse(
      await platformTools(
        { action: 'list', projectId: 'proj_123' },
        createContext('http://localhost:3112'),
        fetchRecorder.dependencies,
      ),
    ) as { success: boolean; error: string; hint: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain('offline');
    expect(result.hint).toContain('Studio');
  });
});

function createContext(baseUrl: string): DebugContext {
  return {
    httpClient: {
      getBaseUrl: () => baseUrl,
      getAuthToken: () => 'token-123',
    },
  } as DebugContext;
}

function createFetchRecorder(...responses: Array<Response | Error>): FetchRecorder {
  const calls: FetchCall[] = [];
  const queue = [...responses];
  const fetchWithTimeout: PlatformToolsDependencies['fetchWithTimeout'] = async (
    url,
    options = {},
    timeoutMs = 5000,
  ) => {
    calls.push({ url, options, timeoutMs });
    const next = queue.shift();
    if (next instanceof Error) {
      throw next;
    }
    return next ?? jsonResponse({});
  };

  return {
    calls,
    dependencies: { fetchWithTimeout },
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    statusText: 'OK',
    headers: { 'Content-Type': 'application/json' },
  });
}

function httpErrorResponse(status: number, statusText: string): Response {
  return new Response(JSON.stringify({ error: statusText }), {
    status,
    statusText,
    headers: { 'Content-Type': 'application/json' },
  });
}

function textFailureResponse(status: number, statusText: string): Response {
  return {
    ok: false,
    status,
    statusText,
    text: async () => {
      throw new Error('body unavailable');
    },
  } as unknown as Response;
}
