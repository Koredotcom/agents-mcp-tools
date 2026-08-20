import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  RunnerFailure,
  startOwnedServices,
  stopOwnedProcesses,
} from './project-builder-runner-lib.mjs';

export const PRIOR_RUNTIME_TAG = 'Artemis_1.1.0';
export const PRIOR_RUNTIME_COMMIT = '0f4d97e3fe66cff58614be7ef38158db4d635c23';
export const SESSION_HISTORY_LANE_TIMEOUT_MS = 30 * 60 * 1000;
const ALLOWED_CONFIG_KEYS = new Set([
  'lane',
  'runtimeBaseUrl',
  'isolation',
  'preparationCommands',
  'services',
  'reportDirectory',
  'repositoryRoot',
  'expectedTag',
  'expectedCommit',
]);

export { RunnerFailure, stopOwnedProcesses };

export async function loadSessionHistoryConfig(argv, expectedLane) {
  const flag = argv.indexOf('--config');
  if (flag < 0 || !argv[flag + 1])
    throw new RunnerFailure('CONFIG_REQUIRED', 'Pass --config <path>.');
  const configPath = resolve(argv[flag + 1]);
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  validateSessionHistoryConfig(config, expectedLane);
  return {
    ...config,
    configPath,
    configDirectory: dirname(configPath),
    laneDeadlineAt: Date.now() + SESSION_HISTORY_LANE_TIMEOUT_MS,
  };
}

export function validateSessionHistoryConfig(config, expectedLane = config?.lane) {
  if (
    !record(config) ||
    config.lane !== expectedLane ||
    !['current', 'prior'].includes(config.lane)
  ) {
    throw new RunnerFailure('CONFIG_LANE_MISMATCH', `Expected a ${expectedLane} config.`);
  }
  const extras = Object.keys(config).filter((key) => !ALLOWED_CONFIG_KEYS.has(key));
  if (extras.length)
    throw new RunnerFailure('UNKNOWN_CONFIG_KEY', `Unknown config keys: ${extras.join(', ')}`);
  requireHttp(config.runtimeBaseUrl, 'runtimeBaseUrl');
  if (!record(config.isolation))
    throw new RunnerFailure('ISOLATION_REQUIRED', 'isolation is required.');
  for (const key of ['mongoPort', 'redisPort', 'clickhouseHttpPort', 'runtimePort']) {
    if (!Number.isInteger(config.isolation[key]) || config.isolation[key] < 1) {
      throw new RunnerFailure('INVALID_ISOLATION', `${key} must be a positive integer.`);
    }
  }
  for (const key of ['mongoDatabase', 'redisNamespace', 'clickhouseDatabase'])
    nonEmpty(config.isolation[key], key);
  if (!Array.isArray(config.preparationCommands))
    throw new RunnerFailure('PREPARATION_REQUIRED', 'preparationCommands is required.');
  config.preparationCommands.forEach((command, index) =>
    validateCommand(command, `preparationCommands.${index}`),
  );
  if (!Array.isArray(config.services) || config.services.length === 0)
    throw new RunnerFailure('SERVICES_REQUIRED', 'services are required.');
  const names = new Set();
  for (const service of config.services) {
    nonEmpty(service?.name, 'service.name');
    if (names.has(service.name))
      throw new RunnerFailure('DUPLICATE_SERVICE', `Duplicate service: ${service.name}`);
    names.add(service.name);
    validateCommand(service.command, `services.${service.name}.command`);
    if (!service.readyUrl && !service.readyCommand)
      throw new RunnerFailure('READINESS_PROBE_REQUIRED', `${service.name} requires readiness.`);
    if (service.readyUrl) requireHttp(service.readyUrl, `${service.name}.readyUrl`);
    if (service.readyCommand) validateCommand(service.readyCommand, `${service.name}.readyCommand`);
  }
  for (const required of ['mongo', 'redis', 'clickhouse', 'runtime']) {
    if (!names.has(required))
      throw new RunnerFailure('REQUIRED_SERVICE_MISSING', `Missing ${required}.`);
  }
  if (config.lane === 'prior') validatePriorConfig(config);
}

export function validatePriorConfig(config) {
  if (config.expectedTag !== PRIOR_RUNTIME_TAG || config.expectedCommit !== PRIOR_RUNTIME_COMMIT) {
    throw new RunnerFailure('PIN_MISMATCH', 'Prior Runtime tag/SHA pin is immutable.');
  }
  nonEmpty(config.repositoryRoot, 'repositoryRoot');
  const commands = config.preparationCommands.map(commandArray);
  const expected = [
    ['pnpm', 'install', '--frozen-lockfile'],
    ['pnpm', '--filter', '@agent-platform/runtime^...', 'build'],
    ['pnpm', '--filter', '@agent-platform/runtime', 'build'],
  ];
  if (JSON.stringify(commands) !== JSON.stringify(expected)) {
    throw new RunnerFailure(
      'PRIOR_PREPARATION_ORDER',
      'Prior preparation commands must match the frozen ordered build sequence.',
    );
  }
  const runtime = config.services.find(({ name }) => name === 'runtime').command;
  if (
    JSON.stringify(commandArray(runtime)) !==
    JSON.stringify(['pnpm', '--filter', '@agent-platform/runtime', 'start'])
  ) {
    throw new RunnerFailure(
      'PRIOR_RUNTIME_COMMAND',
      'Prior Runtime must use the non-watch start command.',
    );
  }
}

export function assertDistinctIsolation(current, prior) {
  for (const key of [
    'mongoPort',
    'redisPort',
    'clickhouseHttpPort',
    'runtimePort',
    'mongoDatabase',
    'redisNamespace',
  ]) {
    if (current.isolation[key] === prior.isolation[key])
      throw new RunnerFailure('SHARED_ISOLATION', `${key} must differ between lanes.`);
  }
}

export async function verifyPriorPin(
  repositoryRoot,
  tag = PRIOR_RUNTIME_TAG,
  commit = PRIOR_RUNTIME_COMMIT,
  config,
) {
  const actual = (
    await captureWithinLane(['git', 'rev-list', '-n', '1', tag], {
      cwd: repositoryRoot,
      timeoutMs: config ? remainingLaneTime(config) : SESSION_HISTORY_LANE_TIMEOUT_MS,
    })
  ).trim();
  if (actual !== commit)
    throw new RunnerFailure('TAG_SHA_MISMATCH', `${tag} resolved to an unexpected commit.`);
}

export async function createSessionHistoryPinnedWorktree(config, repositoryRoot, expectedCommit) {
  const worktree = await mkdtemp(join(tmpdir(), 'arch-prior-runtime-'));
  await rm(worktree, { recursive: true, force: true });
  try {
    await runCheckedWithinLane(['git', 'worktree', 'add', '--detach', worktree, expectedCommit], {
      cwd: repositoryRoot,
      env: {},
      timeoutMs: remainingLaneTime(config),
    });
    const actual = (
      await captureWithinLane(['git', 'rev-parse', 'HEAD'], {
        cwd: worktree,
        timeoutMs: remainingLaneTime(config),
      })
    ).trim();
    if (actual !== expectedCommit)
      throw new RunnerFailure('PINNED_COMMIT_MISMATCH', 'Pinned Runtime worktree commit mismatch.');
    return worktree;
  } catch (error) {
    await cleanupSessionHistoryPinnedWorktree(config, repositoryRoot, worktree, true);
    throw error;
  }
}

export async function cleanupSessionHistoryPinnedWorktree(
  config,
  repositoryRoot,
  worktree,
  tolerateUnregistered = false,
) {
  const ownedPrefix = join(tmpdir(), 'arch-prior-runtime-');
  if (!isAbsolute(worktree) || !worktree.startsWith(ownedPrefix))
    throw new RunnerFailure('UNOWNED_WORKTREE', `Refusing to remove unowned worktree: ${worktree}`);
  try {
    await runCheckedWithinLane(['git', 'worktree', 'remove', '--force', worktree], {
      cwd: repositoryRoot,
      env: {},
      timeoutMs: cleanupGraceTime(config),
    });
  } catch (error) {
    if (!tolerateUnregistered) throw error;
  }
  await rm(worktree, { recursive: true, force: true });
}

export function cleanupGraceTime(config, now = Date.now()) {
  const remaining = (config.laneDeadlineAt ?? now) - now;
  const cleanupGraceMs = 5 * 60 * 1000;
  return Math.max(1, Math.min(cleanupGraceMs, remaining > 0 ? remaining : cleanupGraceMs));
}

export async function runPreparationCommands(config, cwd = config.configDirectory) {
  for (const command of config.preparationCommands) {
    await runCheckedWithinLane(commandArray(command), {
      cwd: resolve(cwd, command.cwd ?? '.'),
      env: resolveEnv(command.envRefs),
      timeoutMs: remainingLaneTime(config),
    });
  }
}

export async function startSessionHistoryServices(config, substitutions = {}) {
  const readinessBudgetMs = Math.max(
    1,
    Math.floor(remainingLaneTime(config) / config.services.length),
  );
  const converted = {
    configDirectory: config.configDirectory,
    logDirectory: config.reportDirectory,
    studioBaseUrl: config.runtimeBaseUrl,
    runtimeBaseUrl: config.runtimeBaseUrl,
    isolation: config.isolation,
    services: config.services.map((service) => ({
      name: service.name,
      command: commandArray(service.command).map((part) => substitute(part, substitutions)),
      ...(service.cwd ? { cwd: substitute(service.cwd, substitutions) } : {}),
      env: {
        ...resolveEnv(service.command.envRefs),
        ...(service.name === 'runtime' ? buildRuntimeEnvironment(config) : {}),
      },
      ...(service.readyUrl ? { readyUrl: substitute(service.readyUrl, substitutions) } : {}),
      readinessTimeoutMs: Math.min(180_000, readinessBudgetMs),
      ...(service.readyCommand
        ? {
            readyCommand: commandArray(service.readyCommand).map((part) =>
              substitute(part, substitutions),
            ),
          }
        : {}),
    })),
  };
  return startOwnedServices(converted, substitutions);
}

export function buildRuntimeEnvironment(config) {
  const isolation = config.isolation;
  const mongoUrl = `mongodb://127.0.0.1:${isolation.mongoPort}/${isolation.mongoDatabase}`;
  return {
    DATABASE_URL: mongoUrl,
    MONGODB_URL: mongoUrl,
    MONGODB_DATABASE: isolation.mongoDatabase,
    REDIS_URL: `redis://127.0.0.1:${isolation.redisPort}`,
    SESSION_HISTORY_REDIS_NAMESPACE: isolation.redisNamespace,
    CLICKHOUSE_URL: `http://127.0.0.1:${isolation.clickhouseHttpPort}`,
    CLICKHOUSE_USER: 'abl_admin',
    CLICKHOUSE_PASSWORD: 'arch_history_test',
    CLICKHOUSE_DATABASE: isolation.clickhouseDatabase,
    HOST: '127.0.0.1',
    PORT: String(isolation.runtimePort),
    JWT_SECRET: createHash('sha256').update(`${config.lane}:history-jwt`).digest('hex'),
    ENCRYPTION_MASTER_KEY: createHash('sha256')
      .update(`${config.lane}:history-encryption`)
      .digest('hex'),
  };
}

export function buildSessionHistoryFixturePlan(config, nonce = randomBytes(8).toString('hex')) {
  const suffix = `${config.lane}-${nonce}`;
  const tenantId = `history-tenant-${suffix}`;
  const projectId = `history-project-${suffix}`;
  const sessionId = `history-session-${suffix}`;
  const rawKey = `abl_hist_${nonce}_${config.lane}`;
  const now = new Date();
  const startedAt = new Date(now.getTime() - 60_000);
  const mongoName = serviceContainerName(config, 'mongo');
  const keyHash = createHash('sha256').update(rawKey).digest('hex');
  const mongoScript = [
    `const d=db.getSiblingDB(${JSON.stringify(config.isolation.mongoDatabase)})`,
    `d.projects.insertOne(${JSON.stringify({
      _id: projectId,
      tenantId,
      ownerId: 'session-history-fixture',
      name: 'Session History Fixture',
      slug: `session-history-${suffix}`,
      kind: 'application',
      createdAt: now,
      updatedAt: now,
    })})`,
    `d.api_keys.insertOne(${JSON.stringify({
      _id: `history-key-${suffix}`,
      tenantId,
      name: 'Session History E2E',
      clientId: `history-client-${suffix}`,
      keyHash,
      prefix: rawKey.substring(0, 8),
      scopes: ['session:read', 'project:read'],
      projectIds: [projectId],
      environments: [],
      expiresAt: null,
      lastUsedAt: null,
      createdBy: 'session-history-fixture',
      revokedAt: null,
      _v: 1,
      createdAt: now,
      updatedAt: now,
    })})`,
    `d.sessions.insertOne(${JSON.stringify({
      _id: sessionId,
      tenantId,
      projectId,
      currentAgent: 'HistoricalAgent',
      entryAgentName: 'HistoricalAgent',
      environment: 'production',
      channel: 'web_debug',
      status: 'completed',
      initiatedById: 'session-history-fixture',
      messageCount: 1,
      traceEventCount: 1,
      startedAt,
      lastActivityAt: now,
      endedAt: now,
      createdAt: startedAt,
      updatedAt: now,
    })})`,
  ].join(';');
  const trace = {
    tenant_id: tenantId,
    project_id: projectId,
    session_id: sessionId,
    event_id: `history-event-${nonce}`,
    event_seq: 1,
    event_cursor: `history-cursor-${nonce}`,
    event_type: 'agent_exit',
    category: 'agent',
    span_id: `history-span-${nonce}`,
    agent_name: 'HistoricalAgent',
    timestamp: now.toISOString().replace('T', ' ').replace('Z', ''),
    data: JSON.stringify({ completed: true, fixture: true }),
  };
  return {
    fixture: { accessToken: rawKey, projectId, sessionId },
    mongoCommand: ['docker', 'exec', mongoName, 'mongosh', '--quiet', '--eval', mongoScript],
    clickHouseUrl: `${config.runtimeBaseUrl.replace(/:\d+$/, `:${config.isolation.clickhouseHttpPort}`)}/?query=${encodeURIComponent(
      `INSERT INTO ${config.isolation.clickhouseDatabase}.platform_events_by_session FORMAT JSONEachRow`,
    )}`,
    trace,
  };
}

export async function provisionSessionHistoryFixture(config) {
  const plan = buildSessionHistoryFixturePlan(config);
  await runCheckedWithinLane(plan.mongoCommand, {
    cwd: config.configDirectory,
    env: {},
    timeoutMs: remainingLaneTime(config),
  });
  const response = await fetch(plan.clickHouseUrl, {
    method: 'POST',
    headers: {
      'X-ClickHouse-User': 'abl_admin',
      'X-ClickHouse-Key': 'arch_history_test',
    },
    body: `${JSON.stringify(plan.trace)}\n`,
    signal: AbortSignal.timeout(Math.min(60_000, remainingLaneTime(config))),
  });
  if (!response.ok) {
    const diagnostic = (await response.text()).replace(/\s+/g, ' ').slice(0, 512);
    throw new RunnerFailure(
      'FIXTURE_PROVISION_FAILED',
      `ClickHouse fixture insert failed with HTTP ${response.status}: ${diagnostic}`,
    );
  }
  return plan.fixture;
}

export async function runBuiltMcpJourney(config, clientName, fixture) {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const { accessToken: token, projectId, sessionId } = fixture ?? {};
  if (!token || !projectId || !sessionId)
    throw new RunnerFailure(
      'JOURNEY_FIXTURE_REQUIRED',
      'A provisioned history fixture is required.',
    );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(packageRoot, 'dist/bin/mcp-debug.js')],
    env: { ...process.env },
    stderr: 'pipe',
  });
  const client = new Client({ name: clientName, version: '1.0.0' });
  try {
    await client.connect(transport, laneRequestOptions(config));
    const listedTools = await client.listTools({}, laneRequestOptions(config));
    const history = listedTools.tools.filter(({ name }) => name === 'debug_session_history');
    if (history.length !== 1)
      throw new RunnerFailure(
        'DISCOVERY_MISMATCH',
        'History tool must be discovered exactly once.',
      );
    await client.callTool(
      {
        name: 'platform_connect',
        arguments: { serverUrl: config.runtimeBaseUrl, authToken: token },
      },
      undefined,
      laneRequestOptions(config),
    );
    const list = await client.callTool(
      {
        name: 'debug_session_history',
        arguments: { action: 'list', projectId },
      },
      undefined,
      laneRequestOptions(config),
    );
    const listBody = textBody(list);
    if (!listBody.success || listBody.limit !== 50 || listBody.offset !== 0)
      throw new RunnerFailure('LIST_FAILED', 'Default historical list journey failed.');
    const get = await client.callTool(
      {
        name: 'debug_session_history',
        arguments: { action: 'get', projectId, sessionId, limit: 1, offset: 0 },
      },
      undefined,
      laneRequestOptions(config),
    );
    const getBody = textBody(get);
    if (!getBody.success || getBody.limit !== 1 || getBody.offset !== 0 || getBody.total < 1)
      throw new RunnerFailure(
        'GET_FAILED',
        `Historical get fixture is required and must be non-empty: ${JSON.stringify(getBody).slice(0, 512)}`,
      );
    const final = await client.callTool(
      {
        name: 'debug_session_history',
        arguments: { action: 'get', projectId, sessionId, limit: 1, offset: getBody.total },
      },
      undefined,
      laneRequestOptions(config),
    );
    const finalBody = textBody(final);
    if (!finalBody.success || finalBody.traces.length !== 0)
      throw new RunnerFailure('PAGINATION_FAILED', 'Final historical page must be empty.');
    const legacy = await client.callTool(
      { name: 'debug_traces', arguments: {} },
      undefined,
      laneRequestOptions(config),
    );
    if (legacy.isError || !legacy.content?.some(({ type }) => type === 'text'))
      throw new RunnerFailure('LEGACY_CALL_FAILED', 'Representative legacy debug call failed.');
    return { schema: history[0].inputSchema, list: listBody, get: getBody, final: finalBody };
  } finally {
    await client.close();
  }
}

export function remainingLaneTime(config, now = Date.now()) {
  const deadline = config.laneDeadlineAt ?? now + SESSION_HISTORY_LANE_TIMEOUT_MS;
  const remaining = deadline - now;
  if (remaining <= 0)
    throw new RunnerFailure('LANE_TIMEOUT', 'Session history process lane exceeded 30 minutes.');
  return remaining;
}

function laneRequestOptions(config) {
  return { timeout: Math.min(60_000, remainingLaneTime(config)) };
}

export async function runCheckedWithinLane(command, { cwd, env, timeoutMs }) {
  const child = spawn(command[0], command.slice(1), {
    cwd,
    env: { ...process.env, ...env },
    detached: process.platform !== 'win32',
    stdio: 'inherit',
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    signalChildTree(child, 'SIGTERM');
  }, timeoutMs);
  const forceTimer = setTimeout(() => {
    if (timedOut && child.exitCode === null) signalChildTree(child, 'SIGKILL');
  }, timeoutMs + 5_000);
  try {
    const code = await new Promise((resolveExit, reject) => {
      child.once('error', reject);
      child.once('exit', resolveExit);
    });
    if (timedOut) {
      // The direct child can exit on SIGTERM while a late/racing descendant in
      // the same process group remains alive. Kill the group before returning.
      signalChildTree(child, 'SIGKILL');
      throw new RunnerFailure(
        'LANE_TIMEOUT',
        'Session history command exceeded its bounded deadline.',
      );
    }
    if (code !== 0)
      throw new RunnerFailure('COMMAND_FAILED', `${command[0]} exited unsuccessfully.`);
  } finally {
    clearTimeout(timer);
    clearTimeout(forceTimer);
  }
}

function signalChildTree(child, signal) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    // The process may have exited between the state check and signal.
  }
}

function serviceContainerName(config, serviceName) {
  const service = config.services.find(({ name }) => name === serviceName);
  const argv = service?.command?.argv ?? [];
  const nameIndex = argv.indexOf('--name');
  const containerName = nameIndex >= 0 ? argv[nameIndex + 1] : undefined;
  if (!containerName)
    throw new RunnerFailure('CONTAINER_NAME_REQUIRED', `${serviceName} requires --name.`);
  return containerName;
}

function validateCommand(command, label) {
  if (!record(command)) throw new RunnerFailure('INVALID_COMMAND', `${label} must be an object.`);
  const extras = Object.keys(command).filter(
    (key) => !['executable', 'argv', 'cwd', 'envRefs'].includes(key),
  );
  if (
    extras.length ||
    !command.executable ||
    !Array.isArray(command.argv) ||
    command.argv.some((value) => typeof value !== 'string')
  )
    throw new RunnerFailure('INVALID_COMMAND', `${label} must use executable plus argv.`);
  if (['sh', 'bash', 'zsh'].includes(command.executable))
    throw new RunnerFailure('SHELL_COMMAND_REJECTED', `${label} cannot invoke a shell.`);
  if (
    command.envRefs &&
    (!Array.isArray(command.envRefs) || command.envRefs.some((value) => typeof value !== 'string'))
  )
    throw new RunnerFailure('INVALID_ENV_REFS', `${label}.envRefs must be string names.`);
}
function commandArray(command) {
  return [command.executable, ...command.argv];
}
function resolveEnv(refs = []) {
  return Object.fromEntries(refs.map((name) => [name, process.env[name] ?? '']));
}
function substitute(value, substitutions) {
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (match, key) => substitutions[key] ?? match);
}
function textBody(result) {
  const block = result.content?.find(({ type }) => type === 'text');
  return JSON.parse(block?.text ?? 'null');
}
function nonEmpty(value, label) {
  if (typeof value !== 'string' || !value.trim())
    throw new RunnerFailure('INVALID_CONFIG_VALUE', `${label} is required.`);
}
function requireHttp(value, label) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
  } catch {
    throw new RunnerFailure('INVALID_URL', `${label} must be HTTP(S).`);
  }
}
function record(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export async function captureWithinLane(command, { cwd, timeoutMs, forceKillGraceMs = 5_000 }) {
  const child = spawn(command[0], command.slice(1), {
    cwd,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => (output += chunk));
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    signalChildTree(child, 'SIGTERM');
  }, timeoutMs);
  const forceTimer = setTimeout(() => {
    if (timedOut && child.exitCode === null) signalChildTree(child, 'SIGKILL');
  }, timeoutMs + forceKillGraceMs);
  const code = await new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', resolveExit);
  }).finally(() => {
    clearTimeout(timer);
    clearTimeout(forceTimer);
  });
  if (timedOut) {
    signalChildTree(child, 'SIGKILL');
    throw new RunnerFailure('LANE_TIMEOUT', 'Session history lane exceeded its deadline.');
  }
  if (code !== 0) throw new RunnerFailure('COMMAND_FAILED', `${command[0]} failed.`);
  return output;
}
