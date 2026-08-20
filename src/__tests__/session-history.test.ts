import { createServer, type RequestListener, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { HttpClient } from '../client/http-client.js';
import { WebSocketClient } from '../client/websocket-client.js';
import { SessionStore } from '../store/session-store.js';
import { TraceStore } from '../store/trace-store.js';
import {
  HISTORY_ARRAY_MAX,
  HISTORY_FILTER_MAX_CHARS,
  HISTORY_ID_MAX_CHARS,
  HISTORY_LIST_SEARCH_MAX_CHARS,
  HISTORY_PAGE_MAX,
  buildSessionHistoryPath,
  historyGetSchema,
  historyListSchema,
  historyListSortFields,
  sessionHistory,
  sessionHistorySchema,
} from '../tools/session-history.js';
import type { DebugContext } from '../tools/index.js';
import type { HistoryArgs, HistoryToolResult } from '../types.js';

const websocketClients: WebSocketClient[] = [];

afterEach(() => {
  for (const client of websocketClients.splice(0)) client.disconnect();
});

describe('session history schemas', () => {
  it('applies stable defaults for both actions', () => {
    expect(historyListSchema.parse({ action: 'list', projectId: 'project' })).toMatchObject({
      limit: 50,
      offset: 0,
      sortBy: 'lastActivityAt',
      sortDir: 'desc',
    });
    expect(
      historyGetSchema.parse({ action: 'get', projectId: 'project', sessionId: 'session' }),
    ).toMatchObject({ limit: 50, offset: 0 });
  });

  it.each([
    [{ action: 'list', projectId: '' }, 'empty project ID'],
    [{ action: 'list', projectId: 'p'.repeat(HISTORY_ID_MAX_CHARS + 1) }, 'long project ID'],
    [{ action: 'list', projectId: 'p', limit: 0 }, 'zero limit'],
    [{ action: 'list', projectId: 'p', limit: HISTORY_PAGE_MAX + 1 }, 'large limit'],
    [{ action: 'list', projectId: 'p', offset: -1 }, 'negative offset'],
    [
      { action: 'list', projectId: 'p', q: 'q'.repeat(HISTORY_LIST_SEARCH_MAX_CHARS + 1) },
      'long q',
    ],
    [{ action: 'list', projectId: 'p', status: [] }, 'empty array'],
    [
      { action: 'list', projectId: 'p', status: Array(HISTORY_ARRAY_MAX + 1).fill('active') },
      'large array',
    ],
    [
      { action: 'list', projectId: 'p', status: ['s'.repeat(HISTORY_FILTER_MAX_CHARS + 1)] },
      'long array item',
    ],
    [{ action: 'list', projectId: 'p', sortBy: 'unknown' }, 'unknown sort'],
    [{ action: 'list', projectId: 'p', from: 'not-a-date' }, 'invalid date'],
    [{ action: 'list', projectId: 'p', from: '2026' }, 'non-ISO date'],
    [{ action: 'list', projectId: 'p', range: '7D' }, 'uppercase range suffix'],
    [{ action: 'list', projectId: 'p', status: ['completed,failed'] }, 'comma-expanded list'],
    [
      { action: 'get', projectId: 'p', sessionId: 's', types: ['tool_call,llm_call'] },
      'comma-expanded trace types',
    ],
    [
      { action: 'list', projectId: 'p', from: '2026-02-02T00:00:00Z', to: '2026-01-01T00:00:00Z' },
      'reversed dates',
    ],
    [{ action: 'list', projectId: 'p', range: '0d' }, 'zero range'],
    [{ action: 'list', projectId: 'p', range: '100000d' }, 'large range'],
    [{ action: 'get', projectId: 'p' }, 'missing session ID'],
    [
      { action: 'list', projectId: 'p', projectAgentId: 'current-only' },
      'current-only list filter',
    ],
    [
      { action: 'list', projectId: 'p', currentProjectAgentsOnly: true },
      'current-only list boolean',
    ],
    [
      { action: 'get', projectId: 'p', sessionId: 's', hasError: true },
      'current-only trace boolean',
    ],
    [
      { action: 'get', projectId: 'p', sessionId: 's', search: 'current-only' },
      'current-only search',
    ],
  ])('rejects %s (%s)', (input, _label) => {
    expect(() => sessionHistorySchema.parse(input)).toThrow();
  });

  it('accepts every supported sort field and valid boundary neighbors', () => {
    for (const sortBy of historyListSortFields) {
      expect(
        sessionHistorySchema.parse({
          action: 'list',
          projectId: 'p'.repeat(HISTORY_ID_MAX_CHARS),
          limit: HISTORY_PAGE_MAX,
          q: 'q'.repeat(HISTORY_LIST_SEARCH_MAX_CHARS),
          status: Array(HISTORY_ARRAY_MAX).fill('s'.repeat(HISTORY_FILTER_MAX_CHARS)),
          range: '99999d',
          sortBy,
        }),
      ).toMatchObject({ sortBy });
    }
  });
});

describe('session history paths', () => {
  it('encodes list paths, arrays, booleans, and defaults exactly once', () => {
    const args = sessionHistorySchema.parse({
      action: 'list',
      projectId: 'project/with space',
      status: ['active', 'ended'],
      channel: ['web debug'],
      mine: false,
      q: 'failed & retried',
    });
    const path = buildSessionHistoryPath(args);
    const url = new URL(path, 'http://runtime.test');

    expect(url.pathname).toBe('/api/projects/project%2Fwith%20space/sessions');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      limit: '50',
      offset: '0',
      status: 'active,ended',
      channel: 'web debug',
      mine: 'false',
      q: 'failed & retried',
      sortBy: 'lastActivityAt',
      sortDir: 'desc',
    });
    expect(url.searchParams.getAll('status')).toHaveLength(1);
  });

  it('lets range override from while retaining an explicit to', () => {
    const args = sessionHistorySchema.parse({
      action: 'list',
      projectId: 'p',
      from: '2026-08-01T00:00:00Z',
      to: '2026-08-19T00:00:00Z',
      range: '7d',
    });
    const url = new URL(buildSessionHistoryPath(args), 'http://runtime.test');

    expect(url.searchParams.has('from')).toBe(false);
    expect(url.searchParams.get('to')).toBe('2026-08-19T00:00:00Z');
    expect(url.searchParams.get('range')).toBe('7d');
  });

  it('encodes get path segments and trace filters', () => {
    const args = sessionHistorySchema.parse({
      action: 'get',
      projectId: 'project/a',
      sessionId: 'session?b',
      limit: 200,
      offset: 5,
      types: ['llm:start', 'tool:end'],
      eventType: 'error event',
      spanId: 'span/1',
    });
    const url = new URL(buildSessionHistoryPath(args), 'http://runtime.test');

    expect(url.pathname).toBe('/api/projects/project%2Fa/sessions/session%3Fb/traces');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      limit: '200',
      offset: '5',
      types: 'llm:start,tool:end',
      eventType: 'error event',
      spanId: 'span/1',
    });
  });
});

describe('session history handler', () => {
  it('preserves list additive fields and exact Runtime order without mutating stores', async () => {
    const sessions = [{ id: 'second', additive: { version: 2 } }, { id: 'first' }];
    await withHttpServer(
      (_request, response) =>
        json(response, { success: true, total: 2, offset: 0, limit: 50, sessions }),
      async (baseUrl) => {
        const fixture = createContext(baseUrl);
        fixture.sessionStore.createSession('live', 'agent');
        const before = snapshotStores(fixture);
        const result = await sessionHistory({ action: 'list', projectId: 'project' }, fixture);

        expect(result.isError).toBeUndefined();
        expect(result.structuredContent).toEqual({
          success: true,
          total: 2,
          offset: 0,
          limit: 50,
          sessions,
        });
        expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
        expect(snapshotStores(fixture)).toEqual(before);
      },
    );
  });

  it('preserves trace order, unknown event fields, and source diagnostics', async () => {
    const traces = [
      { id: 'b', type: 'future:event', payload: { nested: true } },
      { id: 'a', type: 'llm:start' },
    ];
    const _meta = {
      source: 'combined',
      event_count: 2,
      loaded_count: 2,
      available_count: 2,
      is_truncated: false,
      source_chain: ['memory', 'clickhouse_platform_events'],
      warnings: [{ source: 'memory', code: 'PARTIAL', message: 'Partial replay', extra: true }],
      additive: 'retained',
    };
    await withHttpServer(
      (_request, response) =>
        json(response, { success: true, total: 2, offset: 0, limit: 50, traces, _meta }),
      async (baseUrl) => {
        const result = await sessionHistory(
          { action: 'get', projectId: 'project', sessionId: 'session' },
          createContext(baseUrl),
        );
        expect(result.structuredContent).toMatchObject({ traces, _meta });
        expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
      },
    );
  });

  it.each([
    [{ success: true, total: -1, offset: 0, limit: 50, sessions: [] }, 'negative total'],
    [{ success: true, total: 0, offset: 0.5, limit: 50, sessions: [] }, 'fractional offset'],
    [{ success: true, total: 0, offset: 0, limit: 0, sessions: [] }, 'zero limit'],
    [{ success: true, total: 0, offset: 0, limit: 50, traces: [], _meta: {} }, 'missing metadata'],
    [
      {
        success: true,
        total: 201,
        offset: 0,
        limit: 200,
        sessions: Array.from({ length: 201 }, (_, id) => ({ id })),
      },
      'oversized session page',
    ],
    [
      {
        success: true,
        total: 201,
        offset: 0,
        limit: 200,
        traces: Array.from({ length: 201 }, (_, id) => ({ id })),
        _meta: {
          source: 'memory',
          event_count: 201,
          is_truncated: false,
          source_chain: ['memory'],
        },
      },
      'oversized trace page',
    ],
    [
      {
        success: true,
        total: 0,
        offset: 0,
        limit: 50,
        traces: [],
        _meta: {
          source: 'memory',
          event_count: 0,
          is_truncated: false,
          source_chain: [],
          warnings: [{ source: 'memory', code: 'BAD' }],
        },
      },
      'malformed diagnostic',
    ],
  ])('maps malformed success envelope to an explicit failure (%s)', async (body, _label) => {
    await withHttpServer(
      (_request, response) => json(response, body),
      async (baseUrl) => {
        const action: HistoryArgs =
          'sessions' in body
            ? { action: 'list', projectId: 'project' }
            : { action: 'get', projectId: 'project', sessionId: 'session' };
        const result = await sessionHistory(action, createContext(baseUrl));
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          success: false,
          error: { status: 200, code: 'MALFORMED_RESPONSE' },
        });
      },
    );
  });

  it('preserves safe Runtime object, string, and unknown HTTP failures', async () => {
    const cases = [
      {
        status: 403,
        body: { success: false, error: { code: 'FORBIDDEN', message: 'Not allowed' } },
        expected: { status: 403, code: 'FORBIDDEN', message: 'Not allowed' },
      },
      {
        status: 404,
        body: { success: false, error: 'Session not found' },
        expected: { status: 404, code: 'HTTP_404', message: 'Session not found' },
      },
      {
        status: 503,
        body: { success: false },
        expected: { status: 503, code: 'HTTP_503', message: 'Service Unavailable' },
      },
    ];
    for (const testCase of cases) {
      await withHttpServer(
        (_request, response) => json(response, testCase.body, testCase.status),
        async (baseUrl) => {
          const result = await sessionHistory(
            { action: 'list', projectId: 'project' },
            createContext(baseUrl),
          );
          expect(result.isError).toBe(true);
          expect(result.structuredContent).toEqual({ success: false, error: testCase.expected });
        },
      );
    }
  });

  it('redacts and caps Runtime error diagnostics', async () => {
    await withHttpServer(
      (_request, response) =>
        json(
          response,
          {
            success: false,
            error: {
              code: `TOKEN_${'x'.repeat(200)}`,
              message: `authorization=sentinel ${'m'.repeat(700)}`,
            },
          },
          400,
        ),
      async (baseUrl) => {
        const result = await sessionHistory(
          { action: 'list', projectId: 'project' },
          createContext(baseUrl),
        );
        const envelope = result.structuredContent as { error: { code: string; message: string } };
        expect(envelope.error.code.length).toBeLessThanOrEqual(128);
        expect(envelope.error.message.length).toBeLessThanOrEqual(512);
        expect(envelope.error.message).not.toContain('sentinel');
        expect(envelope.error.message).toContain('[REDACTED]');
      },
    );
  });

  it('maps malformed JSON, oversized responses, and connection failures', async () => {
    await withHttpServer(
      (request, response) => {
        if (request.url?.includes('/traces')) {
          response.statusCode = 503;
          response.end('{bad json');
          return;
        }
        response.setHeader('Content-Length', String(2 * 1024 * 1024 + 1));
        response.end('{}');
      },
      async (baseUrl) => {
        const malformed = await sessionHistory(
          { action: 'get', projectId: 'project', sessionId: 'session' },
          createContext(baseUrl),
        );
        expect(malformed.structuredContent).toMatchObject({
          error: { status: 503, code: 'MALFORMED_RESPONSE' },
        });
        const oversized = await sessionHistory(
          { action: 'list', projectId: 'project' },
          createContext(baseUrl),
        );
        expect(oversized.structuredContent).toMatchObject({
          error: { code: 'RESPONSE_TOO_LARGE' },
        });
      },
    );

    const unavailable = await sessionHistory(
      { action: 'list', projectId: 'project' },
      createContext('http://127.0.0.1:1'),
    );
    expect(unavailable.structuredContent).toMatchObject({
      error: { code: 'NETWORK_ERROR' },
    });
  });

  it('isolates concurrent calls and performs one request per invocation', async () => {
    let requestCount = 0;
    await withHttpServer(
      (request, response) => {
        requestCount += 1;
        const id = request.url?.includes('/one/') ? 'one' : 'two';
        json(response, {
          success: true,
          total: 1,
          offset: 0,
          limit: 50,
          traces: [{ id }],
          _meta: {
            source: 'memory',
            event_count: 1,
            is_truncated: false,
            source_chain: ['memory'],
          },
        });
      },
      async (baseUrl) => {
        const fixture = createContext(baseUrl);
        const [one, two] = await Promise.all([
          sessionHistory({ action: 'get', projectId: 'project', sessionId: 'one' }, fixture),
          sessionHistory({ action: 'get', projectId: 'project', sessionId: 'two' }, fixture),
        ]);
        expect(one.structuredContent).toMatchObject({ traces: [{ id: 'one' }] });
        expect(two.structuredContent).toMatchObject({ traces: [{ id: 'two' }] });
      },
    );
    expect(requestCount).toBe(2);
  });
});

function createContext(baseUrl: string): DebugContext {
  const wsClient = new WebSocketClient({ url: 'ws://127.0.0.1:1', reconnect: false });
  websocketClients.push(wsClient);
  return {
    wsClient,
    httpClient: new HttpClient(baseUrl),
    sessionStore: new SessionStore(),
    traceStore: new TraceStore(),
    authenticate: async () => ({ token: 'test-token', method: 'explicit_token' }),
  };
}

function snapshotStores(context: DebugContext): unknown {
  return {
    sessions: context.sessionStore.getAllSessions(),
    activeSessionId: context.sessionStore.getActiveSessionId(),
    traces: context.traceStore.getStats(),
  };
}

async function withHttpServer(
  handler: RequestListener,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function json(response: ServerResponse, body: unknown, status = 200): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(body));
}

type _HistoryToolResultIsMcpObject = HistoryToolResult extends {
  structuredContent: object;
}
  ? true
  : never;
const historyToolResultCompatibility: _HistoryToolResultIsMcpObject = true;
void historyToolResultCompatibility;
