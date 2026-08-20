import { describe, expect, it } from 'vitest';
import { platformSdkChannels } from '../tools/platform-sdk-channels.js';

describe('platform_sdk_channels', () => {
  it('rejects credential-bearing creation fields and sanitizes thrown errors', async () => {
    const rejected = await platformSdkChannels(
      { action: 'create_key', projectId: 'project-1', name: 'secret=sentinel' },
      { httpClient: { post: async () => ({}) } } as never,
    );
    expect(rejected).not.toContain('sentinel');

    const failure = await platformSdkChannels({ action: 'list_keys', projectId: 'project-1' }, {
      httpClient: {
        get: async () => {
          throw new Error('authorization=sentinel');
        },
      },
    } as never);
    expect(failure).not.toContain('sentinel');
    expect(failure).toContain('[REDACTED]');
  });

  it('lists public keys and channels without optional pagination', async () => {
    const gets: string[] = [];
    const context = {
      httpClient: {
        get: async (path: string) => {
          gets.push(path);
          return { success: true, token: 'must-redact' };
        },
      },
    } as never;

    const keys = JSON.parse(
      await platformSdkChannels({ action: 'list_keys', projectId: 'project-1' }, context),
    );
    const channels = JSON.parse(
      await platformSdkChannels({ action: 'list_channels', projectId: 'project-1' }, context),
    );

    expect(keys).toMatchObject({ success: true, data: { token: '[REDACTED]' } });
    expect(channels.success).toBe(true);
    expect(gets).toEqual([
      '/api/projects/project-1/sdk-public-keys',
      '/api/projects/project-1/sdk-channels',
    ]);
  });

  it('forwards bounded pagination when listing SDK channels', async () => {
    const gets: string[] = [];
    const output = JSON.parse(
      await platformSdkChannels(
        { action: 'list_channels', projectId: 'project-1', limit: 25, offset: 50 },
        {
          httpClient: {
            get: async (path: string) => {
              gets.push(path);
              return { success: true, channels: [] };
            },
          },
        } as never,
      ),
    );

    expect(output.success).toBe(true);
    expect(gets).toEqual(['/api/projects/project-1/sdk-channels?limit=25&offset=50']);
  });

  it('creates a public key with the project-scoped API contract', async () => {
    const posts: Array<{ path: string; body: unknown }> = [];
    const output = JSON.parse(
      await platformSdkChannels(
        {
          action: 'create_key',
          projectId: 'project-1',
          name: 'Packed SDK E2E',
          permissions: { chat: true, voice: false },
        },
        {
          httpClient: {
            post: async (path: string, body: unknown) => {
              posts.push({ path, body });
              return { success: true, key: { id: 'key-1', key: 'pk_public' } };
            },
          },
        } as never,
      ),
    );

    expect(output.success).toBe(true);
    expect(posts).toEqual([
      {
        path: '/api/projects/project-1/sdk-public-keys',
        body: {
          name: 'Packed SDK E2E',
          permissions: { chat: true, voice: false },
        },
      },
    ]);
  });

  it('preserves allowed origins when creating a public key', async () => {
    let posted: unknown;
    await platformSdkChannels(
      {
        action: 'create_key',
        projectId: 'project-1',
        name: 'Browser SDK',
        allowedOrigins: ['https://example.com'],
      },
      {
        httpClient: {
          post: async (_path: string, body: unknown) => {
            posted = body;
            return {};
          },
        },
      } as never,
    );

    expect(posted).toEqual({
      name: 'Browser SDK',
      allowedOrigins: ['https://example.com'],
    });
  });

  it('creates an SDK channel that follows the selected environment', async () => {
    let posted: unknown;
    await platformSdkChannels(
      {
        action: 'create_channel',
        projectId: 'project-1',
        name: 'web',
        channelType: 'web',
        publicApiKeyId: 'key-1',
        environment: 'dev',
        authMode: 'anonymous',
      },
      {
        httpClient: {
          post: async (_path: string, body: unknown) => {
            posted = body;
            return { success: true };
          },
        },
      } as never,
    );

    expect(posted).toEqual({
      name: 'web',
      channelType: 'web',
      publicApiKeyId: 'key-1',
      environment: 'dev',
      auth: { mode: 'anonymous' },
    });
  });

  it('applies safe channel defaults and preserves allowed origins', async () => {
    let posted: unknown;
    await platformSdkChannels(
      {
        action: 'create_channel',
        projectId: 'project-1',
        name: 'web',
        channelType: 'web',
        publicApiKeyId: 'key-1',
        allowedOrigins: ['https://example.com'],
      },
      {
        httpClient: {
          post: async (_path: string, body: unknown) => {
            posted = body;
            return {};
          },
        },
      } as never,
    );

    expect(posted).toEqual({
      name: 'web',
      channelType: 'web',
      publicApiKeyId: 'key-1',
      environment: 'dev',
      auth: { mode: 'anonymous' },
      allowedOrigins: ['https://example.com'],
    });
  });

  it.each([
    [{ action: 'create_key', projectId: 'project-1' }, 'name'],
    [{ action: 'create_channel', projectId: 'project-1' }, 'name'],
    [{ action: 'create_channel', projectId: 'project-1', name: 'web' }, 'channelType'],
    [
      {
        action: 'create_channel',
        projectId: 'project-1',
        name: 'web',
        channelType: 'web',
      },
      'publicApiKeyId',
    ],
  ] as const)('rejects missing create input with zero HTTP: %s', async (args, field) => {
    let calls = 0;
    const output = JSON.parse(
      await platformSdkChannels(args, {
        httpClient: {
          post: async () => {
            calls += 1;
            return {};
          },
        },
      } as never),
    );

    expect(output).toMatchObject({ success: false, error: expect.stringContaining(field) });
    expect(calls).toBe(0);
  });

  it.each([new Error('offline'), 'offline'])(
    'returns a structured transport failure',
    async (error) => {
      const output = JSON.parse(
        await platformSdkChannels({ action: 'list_keys', projectId: 'project-1' }, {
          httpClient: {
            get: async () => {
              throw error;
            },
          },
        } as never),
      );

      expect(output).toEqual({
        success: false,
        error: 'platform_sdk_channels list_keys failed: offline',
      });
    },
  );
});
