import { describe, expect, it } from 'vitest';

import { platformAgents } from '../tools/platform-agents.js';

describe('platform_agents security boundary', () => {
  it('rejects credential-bearing DSL before transport', async () => {
    let called = false;
    const result = await platformAgents(
      {
        action: 'save_dsl',
        projectId: 'project-1',
        agentName: 'SupportAgent',
        dslContent: 'authorization=sentinel',
      },
      {
        httpClient: {
          put: async () => {
            called = true;
            return {};
          },
        },
      } as never,
    );

    expect(result).not.toContain('sentinel');
    expect(called).toBe(false);
  });

  it('sanitizes successful responses and thrown error messages', async () => {
    const success = await platformAgents({ action: 'list', projectId: 'project-1' }, {
      httpClient: { get: async () => ({ token: 'sentinel' }) },
    } as never);
    expect(success).not.toContain('sentinel');
    expect(success).toContain('[REDACTED]');

    const failure = await platformAgents({ action: 'list', projectId: 'project-1' }, {
      httpClient: {
        get: async () => {
          throw new Error('private_key=sentinel');
        },
      },
    } as never);
    expect(failure).not.toContain('sentinel');
    expect(failure).toContain('[REDACTED]');
  });
});
