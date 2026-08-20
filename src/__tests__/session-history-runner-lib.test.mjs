import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PRIOR_RUNTIME_COMMIT,
  PRIOR_RUNTIME_TAG,
  assertDistinctIsolation,
  buildRuntimeEnvironment,
  buildSessionHistoryFixturePlan,
  captureWithinLane,
  cleanupGraceTime,
  cleanupSessionHistoryPinnedWorktree,
  remainingLaneTime,
  runCheckedWithinLane,
  validateSessionHistoryConfig,
} from '../../scripts/session-history-runner-lib.mjs';

const scripts = new URL('../../scripts/', import.meta.url);
async function config(name) {
  return JSON.parse(await readFile(new URL(name, scripts), 'utf8'));
}

describe('session history process runner contract', () => {
  it('accepts the strict current/prior configs and keeps lane-owned infrastructure distinct', async () => {
    const current = await config('session-history-current.config.json');
    const prior = await config('session-history-prior.config.json');
    expect(() => validateSessionHistoryConfig(current, 'current')).not.toThrow();
    expect(() => validateSessionHistoryConfig(prior, 'prior')).not.toThrow();
    expect(() => assertDistinctIsolation(current, prior)).not.toThrow();
    expect(current.preparationCommands.map(({ argv }) => argv)).toEqual([
      ['--filter', '@koreai/arch-mcp-tools', 'build'],
      ['--filter', '@agent-platform/runtime^...', 'build'],
      ['--filter', '@agent-platform/runtime', 'build'],
    ]);
    expect(current.isolation.clickhouseDatabase).toBe('abl_platform');
    expect(prior.isolation.clickhouseDatabase).toBe('abl_platform');
    expect(prior).toMatchObject({
      expectedTag: PRIOR_RUNTIME_TAG,
      expectedCommit: PRIOR_RUNTIME_COMMIT,
    });
  });

  it.each([
    [
      'shell command',
      (value) => {
        value.preparationCommands[0] = { executable: 'sh', argv: ['-c', 'echo unsafe'] };
      },
      'SHELL_COMMAND_REJECTED',
    ],
    [
      'mutable install',
      (value) => {
        value.preparationCommands[0].argv = ['install'];
      },
      'PRIOR_PREPARATION_ORDER',
    ],
    [
      'wrong preparation order',
      (value) => {
        value.preparationCommands.reverse();
      },
      'PRIOR_PREPARATION_ORDER',
    ],
    [
      'watch Runtime',
      (value) => {
        value.services.find(({ name }) => name === 'runtime').command.argv = [
          '--filter',
          '@agent-platform/runtime',
          'dev',
        ];
      },
      'PRIOR_RUNTIME_COMMAND',
    ],
    [
      'duplicate service',
      (value) => {
        value.services.push(value.services[0]);
      },
      'DUPLICATE_SERVICE',
    ],
    [
      'missing readiness',
      (value) => {
        delete value.services[0].readyCommand;
      },
      'READINESS_PROBE_REQUIRED',
    ],
    [
      'tag mismatch',
      (value) => {
        value.expectedCommit = 'bad';
      },
      'PIN_MISMATCH',
    ],
  ])('rejects %s', async (_label, mutate, code) => {
    const prior = await config('session-history-prior.config.json');
    mutate(prior);
    expect(() => validateSessionHistoryConfig(prior, 'prior')).toThrowError(
      expect.objectContaining({ code }),
    );
  });

  it('rejects shared state between lanes', async () => {
    const current = await config('session-history-current.config.json');
    const prior = await config('session-history-prior.config.json');
    prior.isolation.redisNamespace = current.isolation.redisNamespace;
    expect(() => assertDistinctIsolation(current, prior)).toThrowError(
      expect.objectContaining({ code: 'SHARED_ISOLATION' }),
    );
  });

  it.each([
    ['session-history-current.config.json', '13212', '27119', '6391', '8135'],
    ['session-history-prior.config.json', '13213', '27120', '6392', '8136'],
  ])(
    'derives the isolated Runtime child environment for %s',
    async (name, runtime, mongo, redis, clickhouse) => {
      const value = await config(name);
      const env = buildRuntimeEnvironment(value);
      expect(env).toMatchObject({
        HOST: '127.0.0.1',
        PORT: runtime,
        MONGODB_URL: `mongodb://127.0.0.1:${mongo}/${value.isolation.mongoDatabase}`,
        MONGODB_DATABASE: value.isolation.mongoDatabase,
        REDIS_URL: `redis://127.0.0.1:${redis}`,
        SESSION_HISTORY_REDIS_NAMESPACE: value.isolation.redisNamespace,
        CLICKHOUSE_URL: `http://127.0.0.1:${clickhouse}`,
        CLICKHOUSE_USER: 'abl_admin',
        CLICKHOUSE_PASSWORD: 'arch_history_test',
        CLICKHOUSE_DATABASE: value.isolation.clickhouseDatabase,
      });
      expect(
        value.services.find(({ name: serviceName }) => serviceName === 'runtime').command.envRefs,
      ).toEqual([]);
      expect(env.JWT_SECRET).toHaveLength(64);
      expect(env.ENCRYPTION_MASTER_KEY).toHaveLength(64);
    },
  );

  it.each(['session-history-current.config.json', 'session-history-prior.config.json'])(
    'builds a lane-local authorized durable fixture plan for %s',
    async (name) => {
      const value = await config(name);
      const plan = buildSessionHistoryFixturePlan(value, 'fixed');
      expect(plan.fixture).toMatchObject({
        projectId: `history-project-${value.lane}-fixed`,
        sessionId: `history-session-${value.lane}-fixed`,
      });
      expect(plan.fixture.accessToken).toMatch(/^abl_hist_/);
      expect(plan.mongoCommand).toEqual(
        expect.arrayContaining(['docker', 'exec', 'mongosh', '--eval']),
      );
      expect(plan.mongoCommand.join(' ')).not.toContain(plan.fixture.accessToken);
      expect(plan.clickHouseUrl).toContain(String(value.isolation.clickhouseHttpPort));
      expect(plan.clickHouseUrl).toContain('platform_events_by_session');
      expect(plan.trace).toMatchObject({
        tenant_id: `history-tenant-${value.lane}-fixed`,
        project_id: plan.fixture.projectId,
        session_id: plan.fixture.sessionId,
        event_type: 'agent_exit',
      });
    },
  );

  it('enforces one overall lane deadline', () => {
    expect(remainingLaneTime({ laneDeadlineAt: 2_000 }, 500)).toBe(1_500);
    expect(() => remainingLaneTime({ laneDeadlineAt: 2_000 }, 2_001)).toThrowError(
      expect.objectContaining({ code: 'LANE_TIMEOUT' }),
    );
  });

  it('terminates a spawned process tree and reports LANE_TIMEOUT', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'session-history-timeout-'));
    const marker = join(directory, 'grandchild-survived');
    const grandchild = `process.on('SIGTERM', () => {}); setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(
      marker,
    )}, 'alive'), 300); setInterval(() => {}, 1000)`;
    const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(
      grandchild,
    )}], { stdio: 'ignore' }); setInterval(() => {}, 1000)`;
    try {
      await expect(
        runCheckedWithinLane([process.execPath, '-e', parent], {
          cwd: directory,
          env: {},
          timeoutMs: 50,
        }),
      ).rejects.toMatchObject({ code: 'LANE_TIMEOUT' });
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 400));
      await expect(access(marker)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('force-kills an output-capturing child that ignores SIGTERM', async () => {
    const command = [
      process.execPath,
      '-e',
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
    ];
    await expect(
      captureWithinLane(command, {
        cwd: process.cwd(),
        timeoutMs: 25,
        forceKillGraceMs: 25,
      }),
    ).rejects.toMatchObject({ code: 'LANE_TIMEOUT' });
  });

  it('cleans an owned temporary path after the main lane deadline expires', async () => {
    expect(cleanupGraceTime({ laneDeadlineAt: 1 }, 2)).toBe(300_000);
    const worktree = await mkdtemp(join(tmpdir(), 'arch-prior-runtime-'));
    await cleanupSessionHistoryPinnedWorktree(
      { laneDeadlineAt: Date.now() - 1 },
      process.cwd(),
      worktree,
      true,
    );
    await expect(access(worktree)).rejects.toThrow();
  });
});
