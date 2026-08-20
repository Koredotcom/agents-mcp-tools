import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  deleteProjectFixture,
  RunnerFailure,
  executeApiSteps,
  loginActors,
  materialize,
  partitionTransitionProcesses,
  requestJson,
  runBootstrapCommands,
  startOwnedServices,
  stopOwnedProcesses,
  validateBaseConfig,
  waitForCommand,
  waitForHttp,
} from '../../scripts/project-builder-runner-lib.mjs';

const cleanup = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((work) => work()));
});

describe('project-builder release runner', () => {
  it('requires explicit isolated state and rejects duplicate service ownership', () => {
    const base = {
      studioBaseUrl: 'http://127.0.0.1:15173',
      runtimeBaseUrl: 'http://127.0.0.1:13112',
      isolation: { mongoDatabase: 'builder-current', redisNamespace: 'builder-current' },
      services: [service('studio'), service('studio')],
    };

    expect(() => validateBaseConfig(base)).toThrowError(
      expect.objectContaining({ code: 'DUPLICATE_SERVICE' }),
    );
    expect(() =>
      validateBaseConfig({ ...base, services: [service('studio')], isolation: {} }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_CONFIG_VALUE' }));
  });

  it('materializes only declared runner substitutions', () => {
    expect(
      materialize(
        { cwd: '${WORKTREE}', env: { DATABASE: '${DATABASE}', UNRESOLVED: '${SECRET}' } },
        { WORKTREE: '/tmp/owned', DATABASE: 'builder-upgrade' },
      ),
    ).toEqual({
      cwd: '/tmp/owned',
      env: { DATABASE: 'builder-upgrade', UNRESOLVED: '${SECRET}' },
    });
  });

  it('runs ordered bootstrap commands and retains singular-command compatibility', async () => {
    const calls = [];
    const runCommand = async (command, options) => calls.push({ command, options });

    await runBootstrapCommands(
      {
        bootstrapCommands: [
          ['pnpm', 'install'],
          ['pnpm', '--dir', '${WORKTREE}', 'build'],
        ],
      },
      { WORKTREE: '/tmp/owned' },
      '/tmp/owned',
      runCommand,
    );
    await runBootstrapCommands(
      { bootstrapCommand: ['pnpm', 'install', '--frozen-lockfile'] },
      {},
      '/tmp/prior',
      runCommand,
    );

    expect(calls).toEqual([
      { command: ['pnpm', 'install'], options: { cwd: '/tmp/owned' } },
      {
        command: ['pnpm', '--dir', '/tmp/owned', 'build'],
        options: { cwd: '/tmp/owned' },
      },
      {
        command: ['pnpm', 'install', '--frozen-lockfile'],
        options: { cwd: '/tmp/prior' },
      },
    ]);
  });

  it('keeps named transition infrastructure separate from phase-local services', () => {
    const owned = [{ name: 'mongo' }, { name: 'redis' }, { name: 'studio' }];

    expect(partitionTransitionProcesses(owned)).toEqual({
      transition: [{ name: 'mongo' }, { name: 'redis' }],
      phase: [{ name: 'studio' }],
    });
    expect(() => partitionTransitionProcesses(owned, ['mongo', 'workflow-engine'])).toThrowError(
      expect.objectContaining({ code: 'TRANSITION_SERVICE_MISSING' }),
    );
  });

  it('bounds readiness and reports the last HTTP failure', async () => {
    await expect(
      waitForHttp('http://127.0.0.1:1/health', {
        timeoutMs: 20,
        intervalMs: 1,
        fetchImpl: async () => new Response(null, { status: 503 }),
      }),
    ).rejects.toMatchObject({
      code: 'READINESS_TIMEOUT',
      details: { lastFailure: 'HTTP 503' },
    });
  });

  it('supports bounded command readiness for isolated Mongo and Redis processes', async () => {
    await expect(
      waitForCommand([process.execPath, '-e', 'process.exit(0)'], { timeoutMs: 5_000 }),
    ).resolves.toBeUndefined();
    await expect(
      waitForCommand([process.execPath, '-e', 'process.exit(2)'], {
        timeoutMs: 20,
        intervalMs: 1,
      }),
    ).rejects.toMatchObject({ code: 'READINESS_TIMEOUT' });
  });

  it('starts and stops only the process it owns', async () => {
    const port = await availablePort();
    const root = await mkdtemp(join(tmpdir(), 'builder-runner-test-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const config = {
      configDirectory: root,
      studioBaseUrl: `http://127.0.0.1:${port}`,
      runtimeBaseUrl: `http://127.0.0.1:${port}`,
      isolation: { mongoDatabase: 'owned-db', redisNamespace: 'owned-redis' },
      services: [
        {
          name: 'owned-http',
          command: [
            process.execPath,
            '-e',
            `require('node:http').createServer((_,r)=>{r.end('ok')}).listen(${port},'127.0.0.1')`,
          ],
          readyUrl: `http://127.0.0.1:${port}`,
        },
      ],
    };

    const owned = await startOwnedServices(config);
    expect(owned).toHaveLength(1);
    expect(owned[0].child.exitCode).toBeNull();
    await stopOwnedProcesses(owned);
    expect(owned[0].child.exitCode !== null || owned[0].child.signalCode !== null).toBe(true);
  });

  it('kills descendants that ignore SIGTERM after their service wrapper exits', async () => {
    const port = await availablePort();
    const root = await mkdtemp(join(tmpdir(), 'builder-runner-tree-test-'));
    const pidFile = join(root, 'descendant.pid');
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const grandchild = `require('node:fs').writeFileSync(${JSON.stringify(
      pidFile,
    )}, String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)`;
    const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(
      grandchild,
    )}], { stdio: 'ignore' }); require('node:http').createServer((_,r)=>r.end('ok')).listen(${port}, '127.0.0.1')`;
    const owned = await startOwnedServices({
      configDirectory: root,
      studioBaseUrl: `http://127.0.0.1:${port}`,
      runtimeBaseUrl: `http://127.0.0.1:${port}`,
      isolation: { mongoDatabase: 'owned-db', redisNamespace: 'owned-redis' },
      services: [
        {
          name: 'owned-tree',
          command: [process.execPath, '-e', parent],
          readyUrl: `http://127.0.0.1:${port}`,
        },
      ],
    });
    const descendantPid = Number.parseInt(await readFile(pidFile, 'utf8'), 10);
    await stopOwnedProcesses(owned);
    let descendantAlive = true;
    for (let attempt = 0; attempt < 20 && descendantAlive; attempt += 1) {
      try {
        process.kill(descendantPid, 0);
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
      } catch {
        descendantAlive = false;
      }
    }
    expect(descendantAlive).toBe(false);
  });

  it('executes API-only upgrade steps with actor auth and captured opaque IDs', async () => {
    const received = [];
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => (body += chunk));
      request.on('end', () => {
        received.push({ authorization: request.headers.authorization, body, url: request.url });
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ data: { operationId: 'operation-1' } }));
      });
    });
    await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    cleanup.push(() => new Promise((resolveClose) => server.close(resolveClose)));
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const context = {
      actors: { owner: { accessToken: 'opaque-token', userId: 'owner-1' } },
      variables: { PROJECT_ID: 'project-1' },
    };

    await executeApiSteps(
      baseUrl,
      [
        {
          actor: 'owner',
          method: 'POST',
          path: '/api/projects/${PROJECT_ID}/operations',
          body: { projectId: '${PROJECT_ID}' },
          capture: { OPERATION_ID: ['data', 'operationId'] },
        },
      ],
      context,
    );

    expect(context.variables.OPERATION_ID).toBe('operation-1');
    expect(received).toEqual([
      {
        authorization: 'Bearer opaque-token',
        body: JSON.stringify({ projectId: 'project-1' }),
        url: '/api/projects/project-1/operations',
      },
    ]);
  });

  it('captures actor and tenant identities from refreshed login tokens', async () => {
    const tokenPayload = Buffer.from(JSON.stringify({ tenantId: 'tenant-1' })).toString(
      'base64url',
    );
    const server = createServer((_request, response) => {
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify({
          accessToken: `header.${tokenPayload}.signature`,
          user: { id: 'delegate-1' },
        }),
      );
    });
    await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    cleanup.push(() => new Promise((resolveClose) => server.close(resolveClose)));
    const address = server.address();

    await expect(
      loginActors(`http://127.0.0.1:${address.port}`, {
        delegate: 'delegate@example.test',
      }),
    ).resolves.toEqual({
      delegate: {
        accessToken: `header.${tokenPayload}.signature`,
        userId: 'delegate-1',
        tenantId: 'tenant-1',
      },
    });
  });

  it('never includes HTTP error response values in runner failures', async () => {
    const server = createServer((_request, response) => {
      response.statusCode = 500;
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ nested: { accessToken: 'secret-sentinel' } }));
    });
    await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    cleanup.push(() => new Promise((resolveClose) => server.close(resolveClose)));
    const address = server.address();

    let failure;
    try {
      await requestJson(`http://127.0.0.1:${address.port}/api/failure`);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(RunnerFailure);
    expect(JSON.stringify(failure)).not.toContain('secret-sentinel');
    expect(failure.details).toEqual({
      status: 500,
      responseShape: { bodyType: 'object', fieldCount: 1 },
    });
  });

  it('deletes created project fixtures with actor auth and treats cleanup as best effort', async () => {
    const received = [];
    const server = createServer((request, response) => {
      received.push({
        authorization: request.headers.authorization,
        method: request.method,
        url: request.url,
      });
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ success: true }));
    });
    await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    cleanup.push(() => new Promise((resolveClose) => server.close(resolveClose)));
    const address = server.address();
    const config = { studioBaseUrl: `http://127.0.0.1:${address.port}` };

    await expect(
      deleteProjectFixture(config, { accessToken: 'opaque-token', projectId: 'project/one' }),
    ).resolves.toBe(true);
    await expect(deleteProjectFixture(undefined, undefined)).resolves.toBe(false);
    expect(received).toEqual([
      {
        authorization: 'Bearer opaque-token',
        method: 'DELETE',
        url: '/api/projects/project%2Fone',
      },
    ]);
  });
});

function service(name) {
  return { name, command: ['node', '--version'], readyUrl: 'http://127.0.0.1:3000' };
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  const port = address.port;
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}
