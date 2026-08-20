import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  PROJECT_BUILDER_LIMITS,
  createProjectBuilderResult,
  validateBoundedValue,
  type ProjectBuilderDomainProvider,
} from '../project-building/contracts.js';
import {
  CORE_ONTOLOGY,
  assertValidOntology,
  topologicallySortKinds,
} from '../project-building/ontology.js';
import {
  createProjectBuilderDomainRegistry,
  createProductionProjectBuilderDomainRegistry,
} from '../project-building/domain-registry.js';
import { createWorkflowDomainProvider } from '../project-building/domains/workflow.js';
import { tools } from '../tools/index.js';
import {
  findSensitiveFieldPathBounded,
  sanitizeResponse,
  sanitizeResponseBounded,
} from '../utils/sanitize.js';

describe('project-building public core', () => {
  it('keeps core vocabulary domain-neutral and produces deterministic topology', () => {
    expect(JSON.stringify(CORE_ONTOLOGY)).not.toMatch(/workflow|agent|integration|auth|mcp/i);
    expect(() => assertValidOntology(CORE_ONTOLOGY)).not.toThrow();
    expect(topologicallySortKinds(CORE_ONTOLOGY)).toEqual(['core:principal', 'core:project']);
    expect(new Set(CORE_ONTOLOGY.kinds.map(({ id }) => id)).size).toBe(CORE_ONTOLOGY.kinds.length);
  });

  it('exposes exactly the two Phase 6 generic project-builder tools', () => {
    expect(
      tools.map(({ name }) => name).filter((name) => name.startsWith('platform_project_')),
    ).toEqual(['platform_project_builder', 'platform_project_builder_operations']);
  });

  it('keeps the standalone public contract free of private workspace runtime imports', () => {
    const sources = [
      '../project-building/contracts.ts',
      '../project-building/ontology.ts',
      '../project-building/domain-registry.ts',
      '../project-building/domains/workflow.ts',
    ].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'));
    expect(sources.join('\n')).not.toMatch(/from ['"]@(abl|agent-platform)\//);
  });

  it('rejects dangling kinds and lifecycle cycles', () => {
    expect(() =>
      assertValidOntology({
        kinds: [{ id: 'sample:one', label: 'One' }],
        edges: [{ id: 'sample:edge', from: 'sample:one', to: 'sample:missing' }],
        lifecycle: [],
      }),
    ).toThrow(/dangling/i);
    expect(() =>
      topologicallySortKinds({
        kinds: [
          { id: 'sample:one', label: 'One' },
          { id: 'sample:two', label: 'Two' },
        ],
        edges: [],
        lifecycle: [
          { from: 'sample:one', to: 'sample:two' },
          { from: 'sample:two', to: 'sample:one' },
        ],
      }),
    ).toThrow(/cycle/i);
    expect(() =>
      assertValidOntology({
        kinds: [{ id: 'sample:one', label: 'One' }],
        edges: [],
        lifecycle: [{ from: 'sample:one', to: 'sample:missing' }],
      }),
    ).toThrow(/dangling/i);
    expect(() =>
      topologicallySortKinds({
        kinds: [{ id: 'sample:one', label: 'One' }],
        edges: [],
        lifecycle: [{ from: 'sample:one', to: 'sample:missing' }],
      }),
    ).toThrow(/dangling/i);
    expect(() =>
      assertValidOntology({
        kinds: [
          { id: 'sample:one', label: 'One' },
          { id: 'sample:one', label: 'Duplicate' },
        ],
        edges: [],
        lifecycle: [],
      }),
    ).toThrow(/duplicate/i);
    expect(() =>
      assertValidOntology({
        kinds: [{ id: 'unqualified', label: 'Invalid' }],
        edges: [],
        lifecycle: [],
      }),
    ).toThrow(/qualified/i);
  });

  it('enforces bounded structured values and identical text/structured envelopes', () => {
    expect(() => validateBoundedValue({ safe: ['value'] })).not.toThrow();
    expect(() =>
      validateBoundedValue('x'.repeat(PROJECT_BUILDER_LIMITS.maxStringLength + 1)),
    ).toThrow(/string/i);
    expect(() =>
      validateBoundedValue(
        Array.from({ length: PROJECT_BUILDER_LIMITS.maxArrayItems + 1 }, () => true),
      ),
    ).toThrow(/array/i);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => validateBoundedValue(cycle)).toThrow(/cyclic/i);
    expect(() => validateBoundedValue({ nested: { value: true } }, { maxDepth: 1 })).toThrow(
      /depth/i,
    );
    expect(() => validateBoundedValue({ one: 1, two: 2 }, { maxObjectKeys: 1 })).toThrow(/object/i);
    expect(() => validateBoundedValue({ value: 'large' }, { maxPayloadBytes: 1 })).toThrow(
      /payload/i,
    );
    const unreadable = Object.defineProperty({}, 'payload', {
      enumerable: true,
      get: () => {
        throw new Error('getter failed');
      },
    });
    expect(() => validateBoundedValue(unreadable)).toThrow(/cannot be read/i);
    expect(() =>
      validateBoundedValue(Object.assign(new Error('safe'), { code: 'SAFE' })),
    ).not.toThrow();

    const result = createProjectBuilderResult('describe', { domains: ['workflow'] });
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
    const failure = createProjectBuilderResult('inspect', null, {
      code: 'NOT_FOUND',
      message: 'Not found',
      retryable: false,
      nextActions: [],
    });
    expect(failure.isError).toBe(true);
    expect(JSON.parse(failure.content[0].text)).toEqual(failure.structuredContent);

    const frozenCycle: Record<string, unknown> = {};
    frozenCycle.self = frozenCycle;
    expect(() => Object.freeze(frozenCycle)).not.toThrow();
  });

  it('constructs a deeply immutable deterministic registry with workflow as the only default', () => {
    const workflow = createWorkflowDomainProvider();
    const synthetic = syntheticProvider();
    const expected = createProjectBuilderDomainRegistry([workflow, synthetic]).describe();
    for (let run = 0; run < 100; run += 1) {
      const providers = run % 2 === 0 ? [synthetic, workflow] : [workflow, synthetic];
      expect(createProjectBuilderDomainRegistry(providers).describe()).toEqual(expected);
    }
    const production = createProductionProjectBuilderDomainRegistry();
    expect(production.providers.map(({ domain }) => domain)).toEqual(['workflow']);
    expect(Object.isFrozen(production)).toBe(true);
    expect(Object.isFrozen(production.providers)).toBe(true);
    expect(Object.isFrozen(production.providers[0]?.ontology)).toBe(true);
  });

  it('isolates synthetic registration from core, workflow, and workflow route transcripts', () => {
    const workflow = createWorkflowDomainProvider();
    const coreBefore = JSON.stringify(CORE_ONTOLOGY);
    const workflowOnly = createProjectBuilderDomainRegistry([workflow]);
    const workflowBefore = JSON.stringify(workflowOnly.getProvider('workflow'));
    const transcriptBefore = workflowOnly
      .getProvider('workflow')
      .routeAdapter.buildRequest('inspect', {
        projectId: 'project-1',
        operationId: 'operation-1',
        input: { includeReadiness: false },
      });
    const registry = createProjectBuilderDomainRegistry([workflow, syntheticProvider()]);
    expect(registry.describe().providers.map(({ domain }) => domain)).toEqual([
      'synthetic',
      'workflow',
    ]);
    expect(JSON.stringify(CORE_ONTOLOGY)).toBe(coreBefore);
    expect(JSON.stringify(registry.getProvider('workflow'))).toBe(workflowBefore);
    expect(
      registry.getProvider('workflow').routeAdapter.buildRequest('inspect', {
        projectId: 'project-1',
        operationId: 'operation-1',
        input: { includeReadiness: false },
      }),
    ).toEqual(transcriptBefore);
  });

  it.each([
    [
      'plan',
      undefined,
      { method: 'POST', path: '/api/projects/project-1/arch-workflow-builds', body: {} },
    ],
    ['list', undefined, { method: 'GET', path: '/api/projects/project-1/arch-workflow-builds' }],
    [
      'read',
      undefined,
      { method: 'GET', path: '/api/projects/project-1/arch-workflow-builds/op%2F1' },
    ],
    [
      'dependency_report',
      undefined,
      {
        method: 'GET',
        path: '/api/projects/project-1/arch-workflow-builds/op%2F1/dependency-report?includeReadiness=false',
      },
    ],
    [
      'readiness_report',
      undefined,
      {
        method: 'GET',
        path: '/api/projects/project-1/arch-workflow-builds/op%2F1/dependency-report?includeReadiness=true',
      },
    ],
    [
      'resume',
      { expectedVersion: 1 },
      {
        method: 'POST',
        path: '/api/projects/project-1/arch-workflow-builds/op%2F1/resume',
        body: { expectedVersion: 1 },
      },
    ],
    [
      'cancel',
      undefined,
      {
        method: 'POST',
        path: '/api/projects/project-1/arch-workflow-builds/op%2F1/cancel',
        body: {},
      },
    ],
    [
      'create_confirmation_grant',
      undefined,
      {
        method: 'POST',
        path: '/api/projects/project-1/arch-workflow-builds/op%2F1/confirmation-grants',
        body: {},
      },
    ],
    [
      'execute_action',
      { action: 'create' },
      {
        method: 'POST',
        path: '/api/projects/project-1/arch-workflow-builds/op%2F1/actions',
        body: { action: 'create' },
      },
    ],
  ] as const)('maps workflow action %s to one allow-listed route', (action, input, expected) => {
    const adapter = createWorkflowDomainProvider().routeAdapter;
    expect(
      adapter.buildRequest(action, {
        projectId: 'project-1',
        ...(action === 'plan' || action === 'list' ? {} : { operationId: 'op/1' }),
        ...(input === undefined ? {} : { input }),
      }),
    ).toEqual(expected);
  });

  it('fails closed for static, unknown, and operation-scoped workflow dispatch errors', () => {
    const adapter = createWorkflowDomainProvider().routeAdapter;
    expect(() => adapter.buildRequest('describe', { projectId: 'project-1' })).toThrow(/static/i);
    expect(() => adapter.buildRequest('unknown', { projectId: 'project-1' })).toThrow(
      /unsupported/i,
    );
    expect(() => adapter.buildRequest('read', { projectId: 'project-1' })).toThrow(/operationId/i);
    expect(() =>
      adapter.buildRequest('execute_action', {
        projectId: 'project-1',
        operationId: 'operation-1',
        input: { nested: { accessToken: 'sentinel' } },
      }),
    ).toThrow(/nested\.accessToken/i);
  });

  it.each([
    ['duplicate domain', [syntheticProvider(), syntheticProvider()]],
    ['reserved prefix', [syntheticProvider({ domain: 'core' })]],
    [
      'duplicate export',
      [syntheticProvider(), syntheticProvider({ domain: 'other', exportId: 'synthetic:asset' })],
    ],
    ['dangling import', [syntheticProvider({ requiredImport: 'absent:asset' })]],
    ['unknown action schema', [syntheticProvider({ omitActionSchema: true })]],
  ])('rejects invalid registry composition: %s', (_name, providers) => {
    expect(() =>
      createProjectBuilderDomainRegistry(providers as ProjectBuilderDomainProvider[]),
    ).toThrow();
  });

  it('allows unresolved optional imports but rejects duplicate readiness ownership', () => {
    expect(() =>
      createProjectBuilderDomainRegistry([syntheticProvider({ optionalImport: 'absent:asset' })]),
    ).not.toThrow();
    expect(() =>
      createProjectBuilderDomainRegistry([
        syntheticProvider(),
        syntheticProvider({ domain: 'other', readinessAssertion: 'synthetic:ready' }),
      ]),
    ).toThrow(/readiness/i);
  });

  it('supports compatible resolved imports and domain-scoped discovery', () => {
    const exporter = syntheticProvider();
    const importer = syntheticProvider({
      domain: 'other',
      requiredImport: 'synthetic:asset',
      importContractRange: '^1.1',
    });
    const registry = createProjectBuilderDomainRegistry([importer, exporter]);
    expect(registry.describe('other').providers.map(({ domain }) => domain)).toEqual(['other']);
    expect(() => registry.getProvider('missing')).toThrow(/unsupported/i);
  });

  it.each([
    ['bad contract', { contractVersion: '2.0' }],
    ['foreign kind', { kindId: 'foreign:asset' }],
    ['foreign action', { actionId: 'foreign:inspect' }],
    ['missing route', { supportedActions: [] }],
    ['missing readiness', { noReadiness: true }],
    ['unknown export kind', { exportKind: 'synthetic:missing' }],
    ['incompatible import', { optionalImport: 'absent:asset', importContractRange: '^2.0' }],
  ])('rejects provider invariant: %s', (_name, mutation) => {
    expect(() =>
      createProjectBuilderDomainRegistry([
        syntheticProvider(mutation as Parameters<typeof syntheticProvider>[0]),
      ]),
    ).toThrow();
  });

  it('rejects and redacts secrets through cycles, errors, arrays, and bounded traversal', () => {
    const cycle: Record<string, unknown> = {
      safeId: 'opaque-123',
      nested: [{ refreshToken: 'sentinel' }],
    };
    cycle.self = cycle;
    expect(findSensitiveFieldPathBounded(cycle)).toBe('nested[0].refreshToken');
    const sanitized = sanitizeResponseBounded(cycle) as Record<string, unknown>;
    expect(JSON.stringify(sanitized)).not.toContain('sentinel');
    expect(sanitized.safeId).toBe('opaque-123');
    expect(sanitized.self).toBe('[CIRCULAR]');

    const error = new Error('request failed with token=sentinel');
    Object.assign(error, { cause: { apiKey: 'sentinel' }, code: 'UPSTREAM' });
    const sanitizedError = JSON.stringify(sanitizeResponseBounded(error));
    expect(sanitizedError).not.toContain('sentinel');
    expect(sanitizedError).toContain('[REDACTED]');
    expect(() =>
      findSensitiveFieldPathBounded({ deeply: { nested: { value: true } } }, { maxDepth: 1 }),
    ).toThrow(/depth/i);
    expect(findSensitiveFieldPathBounded(cycle, { maxDepth: 12 })).toBe('nested[0].refreshToken');
    expect(findSensitiveFieldPathBounded({ clientSecret: 'unsafe' })).toBe('clientSecret');
    expect(
      findSensitiveFieldPathBounded({ config: { headers: { 'X-API-Key': 'sentinel' } } }),
    ).toBe('config.headers.X-API-Key');
    expect(findSensitiveFieldPathBounded({ metadata: { cookie: 'sid=sentinel' } })).toBe(
      'metadata.cookie',
    );
    expect(findSensitiveFieldPathBounded({ message: 'Authorization: Bearer sentinel' })).toBe(
      'message',
    );
    expect(findSensitiveFieldPathBounded({ endpoint: 'https://user:sentinel@example.com' })).toBe(
      'endpoint',
    );
    expect(JSON.stringify(sanitizeResponseBounded('Authorization: Bearer sentinel'))).not.toContain(
      'sentinel',
    );
    expect(
      JSON.stringify(sanitizeResponse({ message: 'Authorization: Bearer sentinel' })),
    ).not.toContain('sentinel');
    expect(
      JSON.stringify(sanitizeResponse({ message: 'Cookie: sid=sentinel; csrf=sentinel-two' })),
    ).not.toContain('sentinel');
    for (const alias of [
      'secret',
      'credential',
      'private_key',
      'access_key',
      'id_token',
      'bearer_token',
    ]) {
      const text = `${alias}=sentinel`;
      expect(findSensitiveFieldPathBounded({ message: text })).toBe('message');
      expect(JSON.stringify(sanitizeResponseBounded(text))).not.toContain('sentinel');
    }
    expect(() => sanitizeResponseBounded('x'.repeat(4), { maxStringLength: 3 })).toThrow(/string/i);
    expect(() => sanitizeResponseBounded([1, 2], { maxArrayItems: 1 })).toThrow(/array/i);
    expect(() => sanitizeResponseBounded({ one: 1, two: 2 }, { maxObjectKeys: 1 })).toThrow(
      /object/i,
    );
    const unreadable = Object.defineProperty({}, 'payload', {
      enumerable: true,
      get: () => {
        throw new Error('getter failed');
      },
    });
    expect(sanitizeResponseBounded(unreadable)).toEqual({ payload: '[UNREADABLE]' });
  });
});

function syntheticProvider(
  options: {
    domain?: string;
    exportId?: string;
    requiredImport?: string;
    optionalImport?: string;
    readinessAssertion?: string;
    omitActionSchema?: boolean;
    importContractRange?: string;
    contractVersion?: string;
    kindId?: string;
    actionId?: string;
    supportedActions?: string[];
    noReadiness?: boolean;
    exportKind?: string;
  } = {},
): ProjectBuilderDomainProvider {
  const domain = options.domain ?? 'synthetic';
  const kindId = options.kindId ?? `${domain}:asset`;
  const actionId = options.actionId ?? `${domain}:inspect`;
  return {
    domain,
    contractVersion: (options.contractVersion ?? '1.1') as '1.1',
    ontology: {
      kinds: [{ id: kindId, label: 'Synthetic asset' }],
      edges: [],
      lifecycle: [],
    },
    actions: [{ id: actionId, mode: 'read', inputSchema: actionId, outputSchema: actionId }],
    inputSchemas: options.omitActionSchema ? {} : { [actionId]: { type: 'object' } },
    outputSchemas: { [actionId]: { type: 'object' } },
    imports: [
      ...(options.requiredImport
        ? [
            {
              id: options.requiredImport,
              required: true,
              contractRange: options.importContractRange,
            },
          ]
        : []),
      ...(options.optionalImport
        ? [
            {
              id: options.optionalImport,
              required: false,
              contractRange: options.importContractRange,
            },
          ]
        : []),
    ],
    exports: [{ id: options.exportId ?? `${domain}:asset`, kind: options.exportKind ?? kindId }],
    readinessOwner: {
      kind: 'authoritative_service',
      service: `${domain}-service`,
      supportsDependencyOnly: true,
      assertions: options.noReadiness ? [] : [options.readinessAssertion ?? `${domain}:ready`],
    },
    routeAdapter: {
      supportedActions: options.supportedActions ?? [actionId],
      buildRequest: () => ({ method: 'GET', path: `/api/synthetic/${domain}` }),
    },
  };
}
