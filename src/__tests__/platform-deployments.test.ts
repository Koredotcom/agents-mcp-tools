import { describe, expect, it } from 'vitest';
import type { DebugContext } from '../tools/index.js';
import {
  platformDeployments,
  platformDeploymentsSchema,
  type PlatformDeploymentsArgs,
} from '../tools/platform-deployments.js';
import { tools } from '../tools/index.js';

interface Call {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
}

function harness(responses: unknown[] = []) {
  const calls: Call[] = [];
  const queue = [...responses];
  const next = async () => {
    const value = queue.shift();
    if (value instanceof Error) throw value;
    return value ?? { ok: true };
  };
  return {
    calls,
    ctx: {
      httpClient: {
        async get(path: string) {
          calls.push({ method: 'GET', path });
          return next();
        },
        async post(path: string, body?: unknown) {
          calls.push({ method: 'POST', path, body });
          return next();
        },
      },
    } as DebugContext,
  };
}

function parse(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}

const base = { projectId: 'project-1' } as const;

describe('platformDeployments', () => {
  it('retains one registered tool and rejects legacy string manifests at schema boundary', () => {
    expect(tools.filter(({ name }) => name === 'platform_deployments')).toHaveLength(1);
    expect(
      platformDeploymentsSchema.safeParse({
        ...base,
        action: 'create',
        environment: 'dev',
        entryAgentName: 'support',
        agentVersionManifest: { support: '1.0.0' },
      }).success,
    ).toBe(false);
    expect(
      platformDeploymentsSchema.parse({
        ...base,
        action: 'create',
        environment: 'dev',
        entryAgentName: 'support',
        agentVersionManifest: { support: { version: '1.0.0' } },
      }),
    ).toMatchObject({ action: 'create' });
  });

  it('lists and gets deployments while sanitizing secrets', async () => {
    const list = harness([{ deployments: [{ id: 'd-1', token: 'secret' }] }]);
    expect(parse(await platformDeployments({ ...base, action: 'list' }, list.ctx))).toMatchObject({
      success: true,
      data: { deployments: [{ token: '[REDACTED]' }] },
    });
    expect(list.calls[0]?.path).toBe('/api/projects/project-1/deployments');

    const get = harness([{ deployment: { id: 'd-1' } }]);
    await platformDeployments(
      { ...base, action: 'get', deploymentId: 'deployment/ü'.replace('/', '-') },
      get.ctx,
    );
    expect(get.calls[0]?.path).toBe('/api/projects/project-1/deployments/deployment-%C3%BC');
  });

  it('creates with the full typed Runtime body', async () => {
    const { calls, ctx } = harness([{ deployment: { id: 'd-1', apiKey: 'omit' } }]);
    const result = parse(
      await platformDeployments(
        {
          ...base,
          action: 'create',
          environment: 'production',
          entryAgentName: 'support',
          agentVersionManifest: {
            support: { version: '1.0.0', configVarsVersion: 'c-1', settingsVersion: 's-1' },
          },
          workflowVersionManifest: { flow: { version: '2.0.0' } },
          label: 'candidate',
          description: 'release',
          modelOverrides: { support: { temperature: 0 } },
          settingsVersionId: 'settings-1',
          deploymentConfigVarsVersion: 'config-1',
          force: true,
          bypassQualificationGate: true,
          bypassReason: 'approved',
        },
        ctx,
      ),
    );
    expect(result).toMatchObject({ success: true, data: { deployment: { apiKey: '[REDACTED]' } } });
    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/api/projects/project-1/deployments',
        body: {
          environment: 'production',
          entryAgentName: 'support',
          agentVersionManifest: {
            support: { version: '1.0.0', configVarsVersion: 'c-1', settingsVersion: 's-1' },
          },
          workflowVersionManifest: { flow: { version: '2.0.0' } },
          label: 'candidate',
          description: 'release',
          modelOverrides: { support: { temperature: 0 } },
          settingsVersionId: 'settings-1',
          deploymentConfigVarsVersion: 'config-1',
          force: true,
          bypassQualificationGate: true,
          bypassReason: 'approved',
        },
      },
    ]);
  });

  it('creates minimal agent and workflow-only deployments without optional fields', async () => {
    const minimal = harness([{}]);
    await platformDeployments(
      {
        ...base,
        action: 'create',
        environment: 'dev',
        entryAgentName: 'support',
        agentVersionManifest: { support: { version: '1.0.0' } },
      },
      minimal.ctx,
    );
    expect(minimal.calls[0]?.body).toEqual({
      environment: 'dev',
      entryAgentName: 'support',
      agentVersionManifest: { support: { version: '1.0.0' } },
    });

    const workflow = harness([{}]);
    await platformDeployments(
      {
        ...base,
        action: 'create',
        environment: 'dev',
        entryAgentName: '',
        agentVersionManifest: {},
        workflowVersionManifest: { flow: { version: '2.0.0' } },
      },
      workflow.ctx,
    );
    expect(workflow.calls).toHaveLength(1);
  });

  it('promotes through the current target-environment contract', async () => {
    const { calls, ctx } = harness([{}]);
    await platformDeployments(
      {
        ...base,
        action: 'promote',
        deploymentId: 'd-1',
        targetEnvironment: 'staging',
        modelOverrides: { support: { temperature: 0 } },
      },
      ctx,
    );
    expect(calls[0]).toEqual({
      method: 'POST',
      path: '/api/projects/project-1/deployments/d-1/promote',
      body: { targetEnvironment: 'staging', modelOverrides: { support: { temperature: 0 } } },
    });
  });

  it('promotes with descriptions and an explicit qualification bypass', async () => {
    const { calls, ctx } = harness([{}]);
    await platformDeployments(
      {
        ...base,
        action: 'promote',
        deploymentId: 'd-1',
        targetEnvironment: 'production',
        label: 'release',
        description: 'approved release',
        bypassQualificationGate: true,
        bypassReason: 'break glass approved',
      },
      ctx,
    );
    expect(calls[0]?.body).toEqual({
      targetEnvironment: 'production',
      label: 'release',
      description: 'approved release',
      bypassQualificationGate: true,
      bypassReason: 'break glass approved',
    });
  });

  it.each([
    ['rollback', {}],
    ['restore', { bypassQualificationGate: true, bypassReason: 'approved' }],
    ['retire', { force: true }],
  ] as const)('sends a confirmed current %s body', async (action, extra) => {
    const { calls, ctx } = harness([{}]);
    await platformDeployments(
      {
        ...base,
        action,
        deploymentId: 'd-1',
        confirm: true,
        ...extra,
      } as PlatformDeploymentsArgs,
      ctx,
    );
    expect(calls).toEqual([
      {
        method: 'POST',
        path: `/api/projects/project-1/deployments/d-1/${action}`,
        body: extra,
      },
    ]);
  });

  it.each(['rollback', 'restore', 'retire'] as const)(
    'requires confirmation before %s with zero HTTP',
    async (action) => {
      const { calls, ctx } = harness();
      expect(
        parse(await platformDeployments({ ...base, action, deploymentId: 'd-1' }, ctx)),
      ).toMatchObject({
        success: false,
        code: 'CONFIRMATION_REQUIRED',
        needsConfirmation: true,
      });
      expect(calls).toHaveLength(0);
    },
  );

  it('retires without force using the explicit empty Runtime body', async () => {
    const { calls, ctx } = harness([{}]);
    await platformDeployments(
      { ...base, action: 'retire', deploymentId: 'd-1', confirm: true },
      ctx,
    );
    expect(calls[0]?.body).toEqual({});
  });

  it.each([
    [{ ...base, action: 'create' }, 'environment'],
    [{ ...base, action: 'create', environment: 'dev' }, 'entryAgentName'],
    [
      { ...base, action: 'create', environment: 'dev', entryAgentName: 'support' },
      'agentVersionManifest',
    ],
    [
      {
        ...base,
        action: 'create',
        environment: 'dev',
        entryAgentName: '',
        agentVersionManifest: {},
      },
      'manifest',
    ],
    [{ ...base, action: 'get' }, 'deploymentId'],
    [{ ...base, action: 'promote', deploymentId: 'd-1' }, 'targetEnvironment'],
    [
      {
        ...base,
        action: 'promote',
        deploymentId: 'd-1',
        targetEnvironment: 'production',
        bypassQualificationGate: true,
      },
      'bypassReason',
    ],
  ] as Array<[PlatformDeploymentsArgs, string]>)(
    'rejects missing intent %#',
    async (args, field) => {
      const { calls, ctx } = harness();
      expect(parse(await platformDeployments(args, ctx))).toMatchObject({
        success: false,
        error: expect.stringContaining(field),
      });
      expect(calls).toHaveLength(0);
    },
  );

  it('returns structured transport and invalid-path failures', async () => {
    const failed = harness([new Error('offline')]);
    expect(parse(await platformDeployments({ ...base, action: 'list' }, failed.ctx))).toMatchObject(
      {
        success: false,
        error: expect.stringContaining('offline'),
        hint: expect.stringContaining('platform_connect'),
      },
    );
    expect(
      parse(
        await platformDeployments({ ...base, action: 'get', deploymentId: '../other' }, failed.ctx),
      ),
    ).toMatchObject({ success: false, error: expect.stringContaining('Invalid deploymentId') });
  });
});
