import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { MCPDebugServer } from '../server.js';

const active: Array<{ client: Client; server: { stop(): Promise<void> } }> = [];

afterEach(async () => {
  await Promise.all(
    active.splice(0).map(({ client, server }) => Promise.all([client.close(), server.stop()])),
  );
});

describe('guidance failure isolation', () => {
  it('keeps initialization, all tools, and legacy discovery usable when catalog construction fails', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = new MCPDebugServer({
      knowledgeCatalogFactory: () => {
        throw new Error('injected knowledge drift');
      },
    });
    const client = new Client({ name: 'knowledge-failure-isolation', version: '1.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    active.push({ client, server });

    expect((await client.listTools()).tools).toHaveLength(45);
    expect((await client.listResources()).resources.slice(0, 2).map(({ uri }) => uri)).toEqual([
      'arch://project-builder/registry',
      'arch://project-builder/providers/workflow',
    ]);
    await expect(client.readResource({ uri: 'arch://guidance/v1/manifest' })).rejects.toThrow(
      /injected knowledge drift/,
    );
    expect((await client.listTools()).tools).toHaveLength(45);
    expect(
      (await client.readResource({ uri: 'arch://project-builder/registry' })).contents,
    ).toHaveLength(1);
  });
});
