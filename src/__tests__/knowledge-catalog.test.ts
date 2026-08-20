import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  createArchKnowledgeCatalog,
  extractToolActions,
  validateFeatureDependencies,
  validateOperationKnowledge,
} from '../knowledge/catalog.js';
import type { FeatureDependency } from '../knowledge/contracts.js';
import { ARCH_KNOWLEDGE_LIMITS } from '../knowledge/contracts.js';
import { tools, type ToolDefinition } from '../tools/index.js';
import { createWorkflowDomainProvider } from '../project-building/domains/workflow.js';
import {
  OPERATION_CONFIDENCE_EVIDENCE,
  PROTOCOL_TEST_SOURCE_BY_REF,
  focusedTestSourceForOperation,
} from '../knowledge/confidence-evidence.js';
import {
  buildMutationVerification,
  verificationGuidanceForOperation,
} from '../knowledge/verification-guidance.js';

describe('Arch operation and dependency knowledge catalog', () => {
  it('covers every published tool and every effective-schema action exactly once', () => {
    const catalog = createArchKnowledgeCatalog();

    expect(catalog.tools.map(({ name }) => name)).toEqual(tools.map(({ name }) => name));
    expect(catalog.tools).toHaveLength(45);
    expect(catalog.operations.map(({ id }) => id)).toEqual(
      tools.flatMap((tool) => extractToolActions(tool).map((action) => `${tool.name}:${action}`)),
    );
    expect(new Set(catalog.operations.map(({ id }) => id)).size).toBe(catalog.operations.length);
    expect(catalog.operations.length).toBeGreaterThan(150);
  });

  it('extracts enum, literal-union, and actionless operations from published schemas', () => {
    expect(
      extractToolActions(tool('enum', z.object({ action: z.enum(['read', 'write']) }))),
    ).toEqual(['read', 'write']);
    expect(
      extractToolActions(
        tool(
          'union',
          z.discriminatedUnion('action', [
            z.object({ action: z.literal('create') }),
            z.object({ action: z.literal('delete') }),
          ]),
        ),
      ),
    ).toEqual(['create', 'delete']);
    expect(extractToolActions(tool('invoke', z.object({ projectId: z.string() })))).toEqual([
      'invoke',
    ]);
    expect(
      extractToolActions({
        ...tool('composed', z.object({})),
        inputSchema: {
          anyOf: [null, { properties: { action: { enum: ['read', 7] } } }],
          allOf: [{ properties: { action: { const: 'write' } } }],
        },
      }),
    ).toEqual(['read', 'write']);
  });

  it('rejects registry/knowledge drift before publishing a partial catalog', () => {
    expect(() => createArchKnowledgeCatalog(tools.slice(0, -1))).toThrow(/tool knowledge drift/);
    expect(() => createArchKnowledgeCatalog([...tools, tools[0]])).toThrow(/tool knowledge drift/);
  });

  it('rejects invalid operation evidence, support, and verification references', () => {
    const operation = createArchKnowledgeCatalog().operations.find(
      ({ support }) => support === 'verified',
    )!;
    expect(() => validateOperationKnowledge([operation, operation])).toThrow(/Duplicate/);
    expect(() =>
      validateOperationKnowledge([
        {
          ...operation,
          evidence: operation.evidence.map((item, index) =>
            index === 0 ? { ...item, tool: 'unknown' } : item,
          ),
        },
      ]),
    ).toThrow(/Evidence does not resolve/);
    expect(() =>
      validateOperationKnowledge([
        { ...operation, evidence: operation.evidence.filter(({ kind }) => kind !== 'handler') },
      ]),
    ).toThrow(/Missing handler evidence/);
    expect(() =>
      validateOperationKnowledge([
        {
          ...operation,
          evidence: operation.evidence.filter(({ kind }) => kind !== 'focused-test'),
        },
      ]),
    ).toThrow(/Missing focused-test evidence/);
    expect(() =>
      validateOperationKnowledge([
        {
          ...operation,
          evidence: operation.evidence.filter(({ kind }) => kind !== 'protocol-test'),
        },
      ]),
    ).toThrow(/lacks protocol evidence/);
    expect(() =>
      validateOperationKnowledge([
        { ...operation, validatesWith: { tool: 'unknown', action: 'read' } },
      ]),
    ).toThrow(/Unknown verification operation/);
  });

  it('rejects dangling, unproved, duplicate, and cyclic feature dependencies', () => {
    const catalog = createArchKnowledgeCatalog();
    const edge = catalog.dependencies[0];
    const check = (dependencies: readonly FeatureDependency[]) =>
      validateFeatureDependencies(
        catalog.operations,
        dependencies,
        catalog.features.map(({ id }) => id),
      );

    expect(() => check([{ ...edge, to: 'unknown' }])).toThrow(/Dangling/);
    expect(() => check([{ ...edge, to: edge.from }])).toThrow(/Self dependency/);
    expect(() => check([{ ...edge, evidence: [] } as unknown as FeatureDependency])).toThrow(
      /lacks evidence/,
    );
    expect(() =>
      check([
        {
          ...edge,
          evidence: [
            { kind: 'handler', tool: 'unknown', action: 'invoke', ref: 'handler:unknown:invoke' },
          ],
        },
      ]),
    ).toThrow(/Invalid dependency evidence/);
    expect(() => check([{ ...edge, authority: 'authoritative-live' }])).toThrow(
      /lacks protocol evidence/,
    );
    expect(() => check([edge, edge])).toThrow(/Duplicate feature dependency/);

    const evidence = edge.evidence;
    const cycle: FeatureDependency[] = [
      { ...edge, from: 'connection-context', to: 'live-agent-debug', evidence },
      { ...edge, from: 'live-agent-debug', to: 'connection-context', evidence },
    ];
    expect(() => check(cycle)).toThrow(/cycle detected/);
  });

  it('resolves every feature, requirement, dependency, and verification reference', () => {
    const catalog = createArchKnowledgeCatalog();
    const featureIds = new Set(catalog.features.map(({ id }) => id));
    const operationIds = new Set(catalog.operations.map(({ id }) => id));

    for (const operation of catalog.operations) {
      expect(featureIds.has(operation.featureId)).toBe(true);
      expect(operation.requires.every((id) => featureIds.has(id))).toBe(true);
      expect(
        operationIds.has(`${operation.validatesWith.tool}:${operation.validatesWith.action}`),
      ).toBe(true);
      expect(operation.evidence.map(({ kind }) => kind)).toEqual(
        expect.arrayContaining(['tool-registry', 'input-schema', 'handler', 'focused-test']),
      );
      expect(operation.confidenceBasis).toBe(
        operation.support === 'verified' ? 'protocol-verified' : 'implementation-backed',
      );
    }
    for (const edge of catalog.dependencies) {
      expect(featureIds.has(edge.from)).toBe(true);
      expect(featureIds.has(edge.to)).toBe(true);
      expect(edge.from).not.toBe(edge.to);
      expect(edge.evidence.length).toBeGreaterThan(0);
      for (const evidence of edge.evidence) {
        expect(operationIds.has(`${evidence.tool}:${evidence.action ?? 'invoke'}`)).toBe(true);
      }
      if (edge.authority === 'authoritative-live') {
        expect(edge.evidence.some(({ kind }) => kind === 'protocol-test')).toBe(true);
      }
    }
  });

  it('binds every operation confidence claim to an explicit passing-test inventory', async () => {
    const catalog = createArchKnowledgeCatalog();
    expect(Object.keys(OPERATION_CONFIDENCE_EVIDENCE)).toEqual(
      catalog.operations.map(({ id }) => id),
    );

    for (const operation of catalog.operations) {
      const inventory = OPERATION_CONFIDENCE_EVIDENCE[operation.id];
      expect(inventory).toBeDefined();
      const focusedSource = focusedTestSourceForOperation(operation.id);
      expect(focusedSource).toBeDefined();
      await expect(
        readFile(resolve(new URL('../../', import.meta.url).pathname, focusedSource!), 'utf8'),
      ).resolves.toContain('describe(');

      if (inventory.protocolTestRef) {
        const protocolSource = PROTOCOL_TEST_SOURCE_BY_REF[inventory.protocolTestRef];
        expect(protocolSource).toBeDefined();
        await expect(
          readFile(resolve(new URL('../../', import.meta.url).pathname, protocolSource), 'utf8'),
        ).resolves.toContain('callTool');
        expect(operation.support).toBe('verified');
        expect(operation.confidenceBasis).toBe('protocol-verified');
      } else {
        expect(operation.support).toBe(
          operation.id === 'platform_versions:create' ||
            operation.id === 'platform_versions:promote'
            ? 'unsupported'
            : 'implemented',
        );
        expect(operation.confidenceBasis).toBe('implementation-backed');
      }
    }

    expect(focusedTestSourceForOperation('platform_projects:not_registered')).toBeUndefined();
  });

  it('matches every shared project-builder action mode to the production provider', () => {
    const catalog = createArchKnowledgeCatalog();
    const projectBuilderOperations = new Map(
      catalog.operations
        .filter(
          ({ tool }) =>
            tool === 'platform_project_builder' || tool === 'platform_project_builder_operations',
        )
        .map(({ action, safety }) => [action, safety]),
    );

    for (const descriptor of createWorkflowDomainProvider().actions) {
      const action = descriptor.id.slice('workflow:'.length);
      expect(projectBuilderOperations.get(action)).toBe(descriptor.mode);
    }
  });

  it('assigns verification by operation outcome instead of by tool name', () => {
    const operations = new Map(
      createArchKnowledgeCatalog().operations.map((operation) => [operation.id, operation]),
    );
    expect(operations.get('platform_sdk_channels:create_key')).toMatchObject({
      validatesWith: { tool: 'platform_sdk_channels', action: 'list_keys' },
      verificationRequiredContext: ['public API key id returned by create_key'],
    });
    expect(operations.get('agent_tables:insert')).toMatchObject({
      validatesWith: { tool: 'agent_tables', action: 'query' },
    });
    expect(operations.get('agent_tables:update_row')).toMatchObject({
      validatesWith: { tool: 'agent_tables', action: 'get_row' },
    });
    expect(operations.get('agent_tables:delete_row')).toMatchObject({
      validatesWith: { tool: 'agent_tables', action: 'get_row' },
      verificationExpectedEvidence: expect.stringContaining('not-found'),
    });
    expect(operations.get('platform_auth_profiles:providers')).toMatchObject({
      validatesWith: { tool: 'platform_auth_profiles', action: 'providers' },
      verificationRequiredContext: [],
    });
    expect(operations.get('platform_import_export:import')).toMatchObject({
      validatesWith: { tool: 'platform_import_export', action: 'export_preview' },
      verificationRequiredContext: expect.arrayContaining([
        'accepted import preview digest and expected asset/change manifest',
      ]),
      verificationExpectedEvidence: expect.stringContaining('every imported asset'),
    });
    expect(operations.get('platform_mcp_servers:test_tool')).toMatchObject({
      safety: 'grant_gated_write',
      validatesWith: { tool: 'platform_mcp_servers', action: 'list_tools' },
      verificationExpectedEvidence: expect.stringContaining('original governed test result'),
    });
    expect(operations.get('platform_tools:test')).toMatchObject({
      safety: 'grant_gated_write',
      validatesWith: { tool: 'platform_tools', action: 'get' },
      verificationExpectedEvidence: expect.stringContaining('original governed test result'),
    });

    for (const operation of operations.values()) {
      expect(operation.verificationExpectedEvidence.trim()).not.toBe('');
      if (operation.safety === 'read') {
        expect(operation.validatesWith).toEqual({
          tool: operation.tool,
          action: operation.action,
        });
      } else {
        expect(operation.verificationRequiredContext.length).toBeGreaterThan(0);
      }
    }

    expect(() => verificationGuidanceForOperation('unknown:mutation', 'write')).toThrow(
      /Missing mutation verification guidance/,
    );
    const guidance = {
      validatesWith: { tool: 'platform_projects', action: 'get' },
      requiredContext: ['project id'],
      expectedEvidence: 'The project exists.',
    } as const;
    expect(() =>
      buildMutationVerification([
        ['platform_projects:create', guidance],
        ['platform_projects:create', guidance],
      ]),
    ).toThrow(/Duplicate mutation verification/);
  });

  it('matches executable tool-test semantics and Studio execution guards', async () => {
    const packageRoot = new URL('../../', import.meta.url).pathname;
    const [projectToolsSource, mcpServersSource, studioGuardsSource, intentPolicySource] =
      await Promise.all([
        readFile(resolve(packageRoot, 'src/tools/platform-tools.ts'), 'utf8'),
        readFile(resolve(packageRoot, 'src/tools/platform-mcp-servers.ts'), 'utf8'),
        readFile(resolve(packageRoot, '../../apps/studio/src/lib/arch-ai/guards.ts'), 'utf8'),
        readFile(
          resolve(
            packageRoot,
            '../../apps/studio/src/lib/arch-ai/processors/intent-turn-shaping.ts',
          ),
          'utf8',
        ),
      ]);

    expect(projectToolsSource).toMatch(/case 'test':[\s\S]*method: 'POST'/);
    expect(mcpServersSource).toMatch(/case 'test_tool':[\s\S]*method = 'POST'/);
    expect(studioGuardsSource).toMatch(/test:\s*'tool:execute'/);
    expect(studioGuardsSource).toMatch(/test_tool:\s*'tool:execute'/);
    for (const policyAction of [
      'auth_ops create/update/validate/delete',
      'connection_ops create/update/delete/test',
      'mcp_server_ops create/update/test_connection/discover_preview',
    ]) {
      expect(intentPolicySource).toContain(policyAction);
    }

    const operations = new Map(
      createArchKnowledgeCatalog().operations.map((operation) => [operation.id, operation]),
    );
    for (const operationId of [
      'platform_auth_profiles:validate',
      'platform_integrations:test',
      'platform_mcp_servers:test_connection',
      'platform_mcp_servers:discover_preview',
    ]) {
      expect(operations.get(operationId)?.safety).toBe('grant_gated_write');
      expect(operations.get(operationId)?.verificationRequiredContext).toEqual(
        expect.arrayContaining([expect.stringContaining('original non-replayed')]),
      );
    }
  });

  it('constructs the complete catalog within the supported-node budget', () => {
    createArchKnowledgeCatalog();
    const durations = Array.from({ length: 10 }, () => {
      const started = performance.now();
      createArchKnowledgeCatalog();
      return performance.now() - started;
    });
    expect(Math.max(...durations)).toBeLessThan(25);
  });

  it('is deterministic, immutable, bounded, and free of credential-shaped public content', () => {
    const first = createArchKnowledgeCatalog();
    const second = createArchKnowledgeCatalog();
    const serialized = JSON.stringify(first);

    expect(second).toEqual(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.operations[0])).toBe(true);
    expect(first.features.length).toBeLessThanOrEqual(ARCH_KNOWLEDGE_LIMITS.maxFeatures);
    expect(first.tools.length).toBeLessThanOrEqual(ARCH_KNOWLEDGE_LIMITS.maxTools);
    expect(first.operations.length).toBeLessThanOrEqual(ARCH_KNOWLEDGE_LIMITS.maxOperations);
    expect(serialized).not.toMatch(/authorization:|bearer\s|api[_-]?key\s*[=:]|https?:\/\//i);
  });
});

function tool(name: string, schema: z.ZodType<unknown>): ToolDefinition {
  return {
    name,
    description: name,
    schema,
    handler: async () => JSON.stringify({ success: true }),
  };
}
