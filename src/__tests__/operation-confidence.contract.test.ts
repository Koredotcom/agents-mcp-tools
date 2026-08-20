import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  FOCUSED_OPERATION_TEST_SOURCE,
  OPERATION_CONFIDENCE_EVIDENCE,
  focusedTestSourceForOperation,
} from '../knowledge/confidence-evidence.js';
import { effectiveInputSchema, tools, type DebugContext } from '../tools/index.js';

const originalFetch = globalThis.fetch;

afterAll(() => {
  vi.stubGlobal('fetch', originalFetch);
});

describe('operation confidence focused evidence', () => {
  it.each(
    Object.keys(OPERATION_CONFIDENCE_EVIDENCE).filter(
      (operationId) => focusedTestSourceForOperation(operationId) === FOCUSED_OPERATION_TEST_SOURCE,
    ),
  )(
    '%s matches its schema, handler outcome, and transport-effect contract',
    async (operationId) => {
      const effects: string[] = [];
      if (operationId === 'debug_harness_logs:invoke') vi.stubEnv('HARNESS_API_KEY', 'test-key');
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          effects.push(`fetch:${init?.method ?? 'GET'}:${String(input)}`);
          const url = String(input);
          if (operationId === 'debug_harness_logs:invoke') {
            if (url === 'https://download.invalid/log.zip') {
              return new Response(
                Buffer.from(
                  'UEsDBBQAAAAIAGsYFF2Q4cZBRQAAAEoAAAAHABwAbG9nLnR4dFVUCQADISGGaiIhhmp1eAsAAQT4AQAABAAAAACrVirJzE1VslIyMjAy0zWw0DUyCDEwsAKjKCUdpZzUstQcoHRmXlo+kJtfWgLk5BekFiWWZObnKSTn5xbkpJakKtVyAQBQSwECHgMUAAAACABrGBRdkOHGQUUAAABKAAAABwAYAAAAAAABAAAApIEAAAAAbG9nLnR4dFVUBQADISGGanV4CwABBPgBAAAEAAAAAFBLBQYAAAAAAQABAE0AAACGAAAAAAA=',
                  'base64',
                ),
              );
            }
            return Response.json({ link: 'https://download.invalid/log.zip' });
          }
          const capability = url.includes('/api/arch-mcp/capabilities');
          return Response.json(
            capability
              ? {
                  schemaVersion: '1.1',
                  service: 'arch-project-builder',
                  contractVersions: ['1.1'],
                  compositeDomain: 'project',
                  domains: [{ domain: 'workflow', contractVersions: ['1.1'] }],
                }
              : {
                  success: true,
                  data: {},
                  project: {},
                  projects: [],
                  items: [],
                  workspaces: [],
                  tenants: [],
                  preview: {},
                  previewDigest: 'digest-1',
                },
            capability
              ? {
                  headers: {
                    'Content-Type': 'application/vnd.kore.arch-mcp-capabilities+json;version=1.1',
                  },
                }
              : undefined,
          );
        }),
      );
      const separator = operationId.lastIndexOf(':');
      const toolName = operationId.slice(0, separator);
      const action = operationId.slice(separator + 1);
      const definition = tools.find(({ name }) => name === toolName);
      expect(definition, `registered tool for ${operationId}`).toBeDefined();
      expect(focusedTestSourceForOperation(operationId)).toBe(FOCUSED_OPERATION_TEST_SOURCE);

      const candidate = sampleInput(effectiveInputSchema(definition!), action, operationId);
      const parsed = definition!.schema.safeParse(candidate);
      expect(parsed.success, JSON.stringify(parsed.success ? {} : parsed.error.issues)).toBe(true);
      if (!parsed.success) return;

      const result = await definition!.handler(parsed.data, createContext(effects));
      const serialized = typeof result === 'string' ? result : JSON.stringify(result);
      expect(serialized).not.toMatch(/unknown action|unsupported action|invalid enum/i);
      let envelope: Record<string, unknown>;
      let outcomeText: string | undefined;
      try {
        envelope = JSON.parse(serialized) as Record<string, unknown>;
      } catch {
        envelope = {};
        outcomeText = serialized;
      }
      const payload = isRecord(envelope.structuredContent) ? envelope.structuredContent : envelope;
      if (
        operationId === 'platform_versions:create' ||
        operationId === 'platform_versions:promote'
      ) {
        expect(payload).toMatchObject({ success: false, code: 'LEGACY_ACTION_UNSUPPORTED' });
      } else if ('success' in payload) {
        expect(payload.success, `${operationId}: ${JSON.stringify(payload)}`).toBe(true);
      } else if (!outcomeText) {
        expect(payload.error, `${operationId}: ${JSON.stringify(payload)}`).toBeUndefined();
      }
      expect({
        operationId,
        effects,
        outcomeKeys: Object.keys(payload).sort(),
        ...(outcomeText ? { outcomeText } : {}),
      }).toMatchSnapshot();
    },
  );
});

function sampleInput(
  schema: unknown,
  action: string,
  operationId: string,
): Record<string, unknown> {
  const selected = selectActionSchema(schema, action);
  const value = sampleValue(selected, 'root');
  if (!isRecord(value)) throw new Error(`Operation schema is not an object for ${action}`);
  value.action = action;
  if (operationId === 'platform_project_builder:inspect') value.domain = 'project';
  if (operationId === 'platform_auth_profiles:create') {
    value.authType = 'none';
    value.scope = 'project';
    value.config = {};
  }
  if (operationId.startsWith('platform_integrations:')) value.scope = 'tenant';
  if (operationId === 'platform_auth_profiles:oauth_initiate') delete value.authProfileRef;
  if (operationId === 'debug_docs:invoke') delete value.topic;
  return value;
}

function selectActionSchema(schema: unknown, action: string): unknown {
  if (!isRecord(schema)) return schema;
  for (const branchName of ['oneOf', 'anyOf'] as const) {
    const branches = schema[branchName];
    if (!Array.isArray(branches)) continue;
    const match = branches.find((branch) => schemaAcceptsAction(branch, action));
    if (match) return match;
  }
  return schema;
}

function schemaAcceptsAction(schema: unknown, action: string): boolean {
  if (!isRecord(schema)) return false;
  const properties = isRecord(schema.properties) ? schema.properties : undefined;
  const actionSchema = properties && isRecord(properties.action) ? properties.action : undefined;
  if (actionSchema?.const === action) return true;
  if (Array.isArray(actionSchema?.enum) && actionSchema.enum.includes(action)) return true;
  return ['oneOf', 'anyOf', 'allOf'].some(
    (key) =>
      Array.isArray(schema[key]) &&
      schema[key].some((branch) => schemaAcceptsAction(branch, action)),
  );
}

function sampleValue(schema: unknown, propertyName: string): unknown {
  if (!isRecord(schema)) return 'value';
  if (propertyName === 'range') return '1d';
  if (propertyName === 'timeoutMs') return 1000;
  if (propertyName === 'domain') return 'workflow';
  if (propertyName === 'domains') return ['workflow'];
  if (propertyName === 'paramMapping') return { sample: '$.summary' };
  if (propertyName === 'allowedOrigins') return ['https://example.invalid'];
  if (propertyName === 'metadata') return {};
  if (propertyName === 'scope') return 'project';
  if (propertyName === 'runIds') return ['run-a', 'run-b'];
  if (propertyName === 'transcript') return '{}';
  if ('const' in schema) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if (schema.format === 'date-time') return '2026-08-20T00:00:00.000Z';
  for (const branchName of ['oneOf', 'anyOf'] as const) {
    const branches = schema[branchName];
    if (Array.isArray(branches) && branches.length > 0) {
      const branch =
        branches.find((entry) => isRecord(entry) && entry.type !== 'null') ?? branches[0];
      return sampleValue(branch, propertyName);
    }
  }
  if (Array.isArray(schema.allOf)) {
    return Object.assign(
      {},
      ...schema.allOf.map((branch) => sampleValue(branch, propertyName)).filter(isRecord),
    );
  }
  if (schema.type === 'object' || isRecord(schema.properties)) {
    if (!isRecord(schema.properties)) {
      if (schema.additionalProperties) {
        return { sample: sampleValue(schema.additionalProperties, 'sample') };
      }
      return {};
    }
    return Object.fromEntries(
      Object.entries(schema.properties).map(([name, child]) => [name, sampleValue(child, name)]),
    );
  }
  if (schema.type === 'array') return [sampleValue(schema.items, propertyName)];
  if (schema.type === 'boolean') return true;
  if (schema.type === 'number' || schema.type === 'integer') {
    return typeof schema.minimum === 'number' ? Math.max(1, schema.minimum) : 1;
  }
  if (schema.format === 'uri' || schema.format === 'url' || /url$/i.test(propertyName)) {
    return 'https://example.invalid';
  }
  if (/email/i.test(propertyName)) return 'developer@example.invalid';
  return `${propertyName || 'value'}-1`;
}

function createContext(effects: string[]): DebugContext {
  const functionProxy = (overrides: Record<string, unknown>) =>
    new Proxy(overrides, {
      get(target, property) {
        if (property in target) return target[property as string];
        return () => undefined;
      },
    });
  const jwt = `header.${Buffer.from(
    JSON.stringify({ sub: 'user-1', tenantId: 'tenantId-1', email: 'developer@example.invalid' }),
  ).toString('base64url')}.signature`;
  const session = {
    sessionId: 'sessionId-1',
    agentId: 'workflow/agent',
    agentDetails: { id: 'workflow/agent', name: 'agent', domain: 'workflow', mode: 'reasoning' },
    state: { currentStep: 'start', phase: 'running', collectedFields: {}, flowState: {} },
    lastActivityAt: new Date('2026-08-20T00:00:00.000Z'),
  };
  const wsTarget: Record<string, unknown> = {};
  const wsClient = functionProxy(wsTarget);
  Object.assign(wsTarget, {
    isConnected: () => true,
    prepareReplacement: async () => ({
      isReady: () => true,
      commit: () => effects.push('ws:commit'),
      abort: () => effects.push('ws:abort'),
    }),
    connect: async () => effects.push('ws:connect'),
    disconnect: () => effects.push('ws:disconnect'),
    loadAgent: () =>
      queueMicrotask(() =>
        (
          wsTarget.onAgentLoaded as
            | ((id: string, agent: Record<string, unknown>) => void)
            | undefined
        )?.('sessionId-1', session.agentDetails),
      ),
    sendMessage: () =>
      queueMicrotask(() => {
        (wsTarget.onResponseStart as ((sid: string, mid: string) => void) | undefined)?.(
          'sessionId-1',
          'message-1',
        );
        (
          wsTarget.onResponseChunk as ((sid: string, mid: string, text: string) => void) | undefined
        )?.('sessionId-1', 'message-1', 'done');
        (
          wsTarget.onResponseEnd as
            | ((sid: string, mid: string, fullText: string) => void)
            | undefined
        )?.('sessionId-1', 'message-1', 'done');
      }),
    listSessions: () =>
      queueMicrotask(() =>
        (wsTarget.onSessionList as ((sessions: unknown[]) => void) | undefined)?.([]),
      ),
    subscribeSession: (id: string) =>
      queueMicrotask(() =>
        (wsTarget.onSubscribed as ((sid: string, count: number) => void) | undefined)?.(id, 0),
      ),
    unsubscribeSession: (id: string) =>
      queueMicrotask(() => (wsTarget.onUnsubscribed as ((sid: string) => void) | undefined)?.(id)),
    getState: (id: string) =>
      queueMicrotask(() =>
        (wsTarget.onStateUpdate as ((sid: string, state: unknown) => void) | undefined)?.(
          id,
          session.state,
        ),
      ),
  });
  return {
    httpClient: functionProxy({
      getBaseUrl: () => 'http://127.0.0.1:3112',
      getAuthToken: () => jwt,
      setAuthToken: () => effects.push('http:set-auth-token'),
      listAgents: async () => {
        effects.push('http:list-agents');
        return { success: true, agents: [] };
      },
      getBoundedJson: async (path: string) => {
        effects.push(`http:GET:${path}`);
        return {
          status: 200,
          statusText: 'OK',
          headers: {},
          body: path.includes('/traces?')
            ? {
                success: true,
                total: 0,
                offset: 0,
                limit: 1,
                traces: [],
                _meta: {
                  source: 'runtime',
                  event_count: 0,
                  is_truncated: false,
                  source_chain: ['runtime'],
                },
              }
            : { success: true, total: 0, offset: 0, limit: 1, sessions: [], _meta: {} },
        };
      },
      get: async (path: string) => {
        effects.push(`http:GET:${path}`);
        if (path.includes('/diagnostics/')) {
          return {
            success: true,
            data: {
              status: 'healthy',
              target: { type: 'session', id: 'sessionId-1', agentName: 'agent' },
              findings: [],
              summary: { errors: 0, warnings: 0, infos: 0, analyzersRun: [] },
              config: {},
              timestamp: '2026-08-20T00:00:00.000Z',
            },
          };
        }
        return {};
      },
      post: async (path: string) => {
        effects.push(`http:POST:${path}`);
        return {};
      },
      put: async (path: string) => {
        effects.push(`http:PUT:${path}`);
        return {};
      },
      patch: async (path: string) => {
        effects.push(`http:PATCH:${path}`);
        return {};
      },
      delete: async (path: string) => {
        effects.push(`http:DELETE:${path}`);
        return {};
      },
    }),
    wsClient,
    sessionStore: functionProxy({
      getActiveSession: () => session,
      getActiveSessionId: () => 'sessionId-1',
      getSession: () => session,
      getAllSessions: () => [session],
      getDecisionLog: () => [],
      createSession: () => effects.push('session:create'),
      setActiveSession: () => effects.push('session:activate'),
      touchSession: () => effects.push('session:touch'),
    }),
    traceStore: functionProxy({
      getEvents: () => [],
      getBySession: () => [],
      getAll: () => [],
      getRecent: () => [],
      getErrors: () => [],
      getById: () => ({
        id: 'eventId-1',
        type: 'llm_call',
        timestamp: '2026-08-20T00:00:00.000Z',
        data: { model: 'test', input: {}, output: {} },
      }),
      getBySpan: () => [],
      search: () => [],
    }),
    authenticate: async () => ({ token: 'opaque-test-token', source: 'explicit' }),
  } as unknown as DebugContext;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
