import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { MCPDebugServer } from '../server.js';
import { ARCH_KNOWLEDGE_MEDIA_TYPE } from '../knowledge/contracts.js';
import { getKnowledgePrompt, readKnowledgeResource } from '../knowledge/discovery.js';

const active: Array<{ client: Client; server: MCPDebugServer }> = [];

afterEach(async () => {
  await Promise.all(
    active.splice(0).map(({ client, server }) => Promise.all([client.close(), server.stop()])),
  );
});

describe('Arch knowledge MCP discovery', () => {
  it('preserves the complete 45-tool MCP discovery contract', async () => {
    const client = await connectedClient();
    const listed = await client.listTools();
    const digest = createHash('sha256').update(JSON.stringify(listed.tools)).digest('hex');

    expect(listed.tools).toHaveLength(45);
    expect(digest).toBe('74e2fb05b0268a213c5d11f1058c75321290c0626a9d46db3af905aea4b5a2a4');
  });

  it('appends versioned resources and templates after existing project-builder discovery', async () => {
    const client = await connectedClient();
    const resources = await client.listResources();

    expect(resources.resources.slice(0, 2).map(({ uri }) => uri)).toEqual([
      'arch://project-builder/registry',
      'arch://project-builder/providers/workflow',
    ]);
    expect(resources.resources.slice(2).map(({ uri }) => uri)).toEqual([
      'arch://guidance/v1/manifest',
      'arch://guidance/v1/features',
      'arch://guidance/v1/operations',
      'arch://guidance/v1/dependencies',
    ]);
    expect(
      resources.resources.slice(2).every(({ mimeType }) => mimeType === ARCH_KNOWLEDGE_MEDIA_TYPE),
    ).toBe(true);

    const templates = await client.listResourceTemplates();
    expect(templates.resourceTemplates.map(({ name }) => name)).toEqual([
      'project-builder-project-report',
      'guidance-feature-detail',
      'guidance-tool-detail',
    ]);
  });

  it('reads manifest, feature, tool, operation, and dependency projections', async () => {
    const client = await connectedClient();
    const manifest = await readJson(client, 'arch://guidance/v1/manifest');
    expect(manifest).toMatchObject({
      schemaVersion: '1',
      generatedFrom: 'runtime-tool-registry',
      counts: { features: 13, tools: 45 },
    });

    const features = (await readJson(client, 'arch://guidance/v1/features')) as unknown[];
    const operations = (await readJson(client, 'arch://guidance/v1/operations')) as unknown[];
    const dependencies = (await readJson(client, 'arch://guidance/v1/dependencies')) as unknown[];
    expect(features).toHaveLength(13);
    expect(operations.length).toBeGreaterThan(150);
    expect(dependencies.length).toBeGreaterThan(10);

    expect(await readJson(client, 'arch://guidance/v1/features/release-delivery')).toMatchObject({
      feature: { id: 'release-delivery' },
    });
    expect(await readJson(client, 'arch://guidance/v1/tools/platform_deployments')).toMatchObject({
      tool: { name: 'platform_deployments', featureId: 'release-delivery' },
    });
  });

  it('appends planning and verification prompts while preserving existing prompts', async () => {
    const client = await connectedClient();
    const prompts = await client.listPrompts();
    expect(prompts.prompts.map(({ name }) => name)).toEqual([
      'build-agentic-project',
      'continue-project-operation',
      'plan-platform-operation',
      'verify-platform-operation',
    ]);

    const plan = await client.getPrompt({
      name: 'plan-platform-operation',
      arguments: { goal: 'Safely deploy the project', featureId: 'release-delivery' },
    });
    expect(plan.messages[0]?.content).toMatchObject({
      type: 'text',
      text: expect.stringContaining('Resolve every required dependency'),
    });
    const verify = await client.getPrompt({
      name: 'verify-platform-operation',
      arguments: { tool: 'platform_deployments', action: 'create' },
    });
    expect(verify.messages[0]?.content).toMatchObject({
      type: 'text',
      text: expect.stringContaining('platform_deployments action=get'),
    });
  });

  it('keeps invalid knowledge identifiers and arguments explicit', async () => {
    const client = await connectedClient();
    await expect(
      client.readResource({ uri: 'arch://guidance/v1/features/unknown' }),
    ).rejects.toThrow(/Unknown Arch feature/);
    await expect(client.readResource({ uri: 'arch://guidance/v1/unknown' })).rejects.toThrow(
      /Unknown guidance resource/,
    );
    await expect(
      client.getPrompt({ name: 'plan-platform-operation', arguments: {} }),
    ).rejects.toThrow(/goal is required/);
    await expect(
      client.getPrompt({
        name: 'verify-platform-operation',
        arguments: { tool: 'unknown', action: 'invoke' },
      }),
    ).rejects.toThrow(/Unknown Arch operation/);
    expect(
      getKnowledgePrompt('plan-platform-operation', { goal: 'Inspect support' }).messages[0]
        ?.content,
    ).toMatchObject({ text: expect.stringContaining('discover before acting') });
    expect(
      getKnowledgePrompt('verify-platform-operation', {
        tool: 'platform_auth_profiles',
        action: 'create',
      }).messages[0]?.content,
    ).toMatchObject({ text: expect.stringContaining('Never pass raw secrets') });
    expect(() => getKnowledgePrompt('unknown-guidance-prompt')).toThrow(/Unknown guidance prompt/);
    expect(() => readKnowledgeResource('https://example.invalid/v1/manifest')).toThrow(
      /Unknown guidance resource/,
    );
  });
});

async function connectedClient(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = new MCPDebugServer();
  const client = new Client({ name: 'knowledge-test', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  active.push({ client, server });
  return client;
}

async function readJson(client: Client, uri: string): Promise<unknown> {
  const result = await client.readResource({ uri });
  const content = result.contents[0];
  if (!('text' in content)) throw new Error(`Expected text resource: ${uri}`);
  expect(content.mimeType).toBe(ARCH_KNOWLEDGE_MEDIA_TYPE);
  return JSON.parse(content.text);
}
