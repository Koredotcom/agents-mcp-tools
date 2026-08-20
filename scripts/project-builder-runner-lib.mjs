import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const READINESS_TIMEOUT_MS = 180_000;
export const PROCESS_STOP_TIMEOUT_MS = 10_000;
export const PRIOR_STUDIO_COMMIT = '0f4d97e3fe66cff58614be7ef38158db4d635c23';
export const ACTOR_UPGRADE_BASELINE_COMMIT = 'baa4271749e2e06e19d32835cb27c5ec5eee9443';

const REQUIRED_SERVICES = Object.freeze({
  current: ['mongo', 'redis', 'workflow-engine', 'runtime', 'studio'],
  prior: ['mongo', 'redis', 'runtime', 'studio'],
  upgrade: ['mongo', 'redis', 'studio'],
});

export class RunnerFailure extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RunnerFailure';
    this.code = code;
    this.details = details;
  }
}

export async function loadRunnerConfig(argv, expectedLane) {
  const configFlag = argv.indexOf('--config');
  const configuredPath = configFlag >= 0 ? argv[configFlag + 1] : undefined;
  if (!configuredPath) {
    throw new RunnerFailure('CONFIG_REQUIRED', 'Pass --config <path>.');
  }
  const configPath = resolve(configuredPath);
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  if (!isRecord(config) || config.lane !== expectedLane) {
    throw new RunnerFailure('CONFIG_LANE_MISMATCH', `Expected a ${expectedLane} runner config.`, {
      configPath,
    });
  }
  validateBaseConfig(config, configPath, expectedLane);
  return { ...config, configPath, configDirectory: dirname(configPath) };
}

export function validateBaseConfig(config, configPath = '<inline>', lane) {
  requireHttpUrl(config.studioBaseUrl, 'studioBaseUrl');
  requireHttpUrl(config.runtimeBaseUrl, 'runtimeBaseUrl');
  if (!Array.isArray(config.services) || config.services.length === 0) {
    throw new RunnerFailure(
      'SERVICES_REQUIRED',
      'Config must declare at least one owned service.',
      {
        configPath,
      },
    );
  }
  const names = new Set();
  for (const service of config.services) {
    if (!isRecord(service) || typeof service.name !== 'string' || !service.name) {
      throw new RunnerFailure('INVALID_SERVICE', 'Every service requires a non-empty name.');
    }
    if (names.has(service.name)) {
      throw new RunnerFailure('DUPLICATE_SERVICE', `Duplicate service name: ${service.name}`);
    }
    names.add(service.name);
    validateCommand(service.command, `services.${service.name}.command`);
    if (service.readyUrl) requireHttpUrl(service.readyUrl, `services.${service.name}.readyUrl`);
    if (service.readyCommand) {
      validateCommand(service.readyCommand, `services.${service.name}.readyCommand`);
    }
    if (!service.readyUrl && !service.readyCommand) {
      throw new RunnerFailure(
        'READINESS_PROBE_REQUIRED',
        `Service ${service.name} requires readyUrl or readyCommand.`,
      );
    }
  }
  for (const required of REQUIRED_SERVICES[lane] ?? []) {
    if (!names.has(required)) {
      throw new RunnerFailure(
        'REQUIRED_SERVICE_MISSING',
        `${lane} lane must own a service named ${required}.`,
      );
    }
  }
  if (!isRecord(config.isolation)) {
    throw new RunnerFailure('ISOLATION_REQUIRED', 'Config must declare isolation metadata.');
  }
  requireNonEmpty(config.isolation.mongoDatabase, 'isolation.mongoDatabase');
  requireNonEmpty(config.isolation.redisNamespace, 'isolation.redisNamespace');
}

export async function startOwnedServices(config, substitutions = {}) {
  const logDirectory = resolve(
    config.configDirectory ?? process.cwd(),
    config.logDirectory ?? 'test-reports/mcp-project-builder-processes',
  );
  await mkdir(logDirectory, { recursive: true });
  const owned = [];
  try {
    for (const definition of config.services) {
      const service = materialize(definition, substitutions);
      const [command, ...args] = service.command;
      const logPath = join(logDirectory, `${safeName(service.name)}.log`);
      const logFd = openSync(logPath, 'a');
      let child;
      try {
        child = spawn(command, args, {
          cwd: resolve(config.configDirectory ?? process.cwd(), service.cwd ?? '.'),
          env: { ...process.env, ...(service.env ?? {}) },
          detached: process.platform !== 'win32',
          stdio: ['ignore', logFd, logFd],
        });
      } finally {
        closeSync(logFd);
      }
      const record = { child, logPath, name: service.name };
      child.once('error', (error) => {
        record.spawnError = error;
      });
      owned.push(record);
      const readiness = {
        timeoutMs: service.readinessTimeoutMs ?? READINESS_TIMEOUT_MS,
        child: record,
      };
      if (service.readyUrl) await waitForHttp(service.readyUrl, readiness);
      else {
        await waitForCommand(service.readyCommand, {
          ...readiness,
          cwd: resolve(config.configDirectory ?? process.cwd(), service.cwd ?? '.'),
          env: { ...process.env, ...(service.env ?? {}) },
        });
      }
    }
    return owned;
  } catch (error) {
    await stopOwnedProcesses(owned);
    throw error;
  }
}

export async function stopOwnedProcesses(owned) {
  const active = [...owned]
    .reverse()
    .filter((record) => record.child.exitCode === null && record.child.signalCode === null);
  for (const record of active) {
    signalOwnedProcess(record.child, 'SIGTERM');
  }
  await Promise.all(
    active.map(async (record) => {
      await waitForExit(record.child, PROCESS_STOP_TIMEOUT_MS);
      // A wrapper can exit on SIGTERM while a descendant in its detached
      // process group survives. Always kill the owned group before returning.
      signalOwnedProcess(record.child, 'SIGKILL');
    }),
  );
}

export function partitionTransitionProcesses(owned, transitionServiceNames = ['mongo', 'redis']) {
  if (
    !Array.isArray(transitionServiceNames) ||
    transitionServiceNames.length === 0 ||
    transitionServiceNames.some((name) => typeof name !== 'string' || !name)
  ) {
    throw new RunnerFailure(
      'INVALID_TRANSITION_SERVICES',
      'transitionServiceNames must be a non-empty string array.',
    );
  }
  const requested = new Set(transitionServiceNames);
  const transition = owned.filter((record) => requested.has(record.name));
  const found = new Set(transition.map((record) => record.name));
  const missing = transitionServiceNames.filter((name) => !found.has(name));
  if (missing.length > 0) {
    throw new RunnerFailure(
      'TRANSITION_SERVICE_MISSING',
      `Transition services are not owned by the old phase: ${missing.join(', ')}.`,
    );
  }
  return {
    transition,
    phase: owned.filter((record) => !requested.has(record.name)),
  };
}

export async function waitForHttp(
  url,
  { timeoutMs = READINESS_TIMEOUT_MS, intervalMs = 500, child, fetchImpl = fetch } = {},
) {
  requireHttpUrl(url, 'readiness URL');
  const deadline = Date.now() + timeoutMs;
  let lastFailure = 'no response';
  while (Date.now() < deadline) {
    if (child && (child.child.exitCode !== null || child.child.signalCode !== null)) {
      throw new RunnerFailure(
        'SERVICE_EXITED',
        `${child.name} exited before readiness. See ${child.logPath}.`,
      );
    }
    if (child?.spawnError) {
      throw new RunnerFailure(
        'SERVICE_SPAWN_FAILED',
        `${child.name} failed to start. See ${child.logPath}.`,
        { cause: child.spawnError.message },
      );
    }
    try {
      const remainingMs = Math.max(1, deadline - Date.now());
      const response = await fetchImpl(url, {
        signal: AbortSignal.timeout(Math.min(5_000, remainingMs)),
      });
      if (response.ok) return;
      lastFailure = `HTTP ${response.status}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    await delay(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }
  throw new RunnerFailure('READINESS_TIMEOUT', `Readiness timed out for ${url}.`, {
    timeoutMs,
    lastFailure,
    logPath: child?.logPath,
  });
}

export async function waitForCommand(
  command,
  {
    timeoutMs = READINESS_TIMEOUT_MS,
    intervalMs = 500,
    child,
    cwd = process.cwd(),
    env = process.env,
  } = {},
) {
  validateCommand(command, 'readiness command');
  const deadline = Date.now() + timeoutMs;
  let lastFailure = 'command has not completed';
  while (Date.now() < deadline) {
    assertServiceStillRunning(child);
    const remainingMs = Math.max(1, deadline - Date.now());
    let result;
    try {
      result = await probeCommand(command, {
        cwd,
        env,
        timeoutMs: Math.min(5_000, remainingMs),
      });
    } catch (error) {
      throw new RunnerFailure(
        'READINESS_PROBE_FAILED',
        `Readiness command failed to start for ${child?.name}.`,
        { cause: error instanceof Error ? error.message : String(error) },
      );
    }
    if (result.code === 0) return;
    lastFailure = result.timedOut ? 'probe timed out' : `exit ${result.code ?? 'unknown'}`;
    await delay(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }
  throw new RunnerFailure('READINESS_TIMEOUT', `Readiness command timed out for ${child?.name}.`, {
    timeoutMs,
    lastFailure,
    logPath: child?.logPath,
  });
}

export async function devLoginAndCreateProject(config) {
  const email = config.e2eEmail ?? `arch-project-builder-${Date.now()}@e2e-smoke.test`;
  const login = await requestJson(`${config.studioBaseUrl}/api/auth/dev-login`, {
    method: 'POST',
    body: { email },
  });
  const accessToken = readString(login, ['accessToken']);
  const project = await requestJson(`${config.studioBaseUrl}/api/projects`, {
    method: 'POST',
    token: accessToken,
    body: { name: `arch-project-builder-${Date.now()}` },
  });
  const projectId =
    readOptionalString(project, ['project', 'id']) ??
    readOptionalString(project, ['data', 'id']) ??
    readString(project, ['id']);
  return { accessToken, projectId, email };
}

export async function deleteProjectFixture(config, fixture) {
  if (!config?.studioBaseUrl || !fixture?.accessToken || !fixture?.projectId) return false;
  try {
    await requestJson(
      `${config.studioBaseUrl}/api/projects/${encodeURIComponent(fixture.projectId)}`,
      {
        method: 'DELETE',
        token: fixture.accessToken,
      },
    );
    return true;
  } catch {
    // Cleanup is best effort so the original test failure remains authoritative.
    return false;
  }
}

export async function loginActors(studioBaseUrl, actors) {
  if (!isRecord(actors) || Object.keys(actors).length === 0) {
    throw new RunnerFailure('ACTORS_REQUIRED', 'Upgrade config must declare named actor emails.');
  }
  const result = {};
  for (const [name, email] of Object.entries(actors)) {
    requireNonEmpty(email, `actors.${name}`);
    const login = await requestJson(`${studioBaseUrl}/api/auth/dev-login`, {
      method: 'POST',
      body: { email },
    });
    const accessToken = readString(login, ['accessToken']);
    const tokenParts = accessToken.split('.');
    const tokenPayload =
      tokenParts.length === 3
        ? safeJson(Buffer.from(tokenParts[1], 'base64url').toString('utf8'))
        : {};
    result[name] = {
      accessToken,
      userId: readString(login, ['user', 'id']),
      tenantId: readString(tokenPayload, ['tenantId']),
    };
  }
  return result;
}

export async function executeApiSteps(studioBaseUrl, steps, context) {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new RunnerFailure('API_STEPS_REQUIRED', 'Compatibility phase requires API steps.');
  }
  for (const [index, rawStep] of steps.entries()) {
    const step = materialize(rawStep, context.variables);
    if (!isRecord(step) || typeof step.path !== 'string' || !step.path.startsWith('/api/')) {
      throw new RunnerFailure('INVALID_API_STEP', `API step ${index + 1} requires an /api/ path.`);
    }
    const actor = step.actor ? context.actors[step.actor] : undefined;
    if (step.actor && !actor) {
      throw new RunnerFailure('UNKNOWN_ACTOR', `API step ${index + 1} references ${step.actor}.`);
    }
    const response = await requestJson(`${studioBaseUrl}${step.path}`, {
      method: step.method ?? 'GET',
      token: actor?.accessToken,
      body: step.body,
      expectedStatus: step.expectedStatus,
    });
    if (step.capture) {
      if (!isRecord(step.capture)) {
        throw new RunnerFailure(
          'INVALID_CAPTURE',
          `API step ${index + 1} capture must be an object.`,
        );
      }
      for (const [variable, path] of Object.entries(step.capture)) {
        if (
          !Array.isArray(path) ||
          path.some(
            (part) => typeof part !== 'string' && !(Number.isInteger(part) && Number(part) >= 0),
          )
        ) {
          throw new RunnerFailure(
            'INVALID_CAPTURE',
            `Capture ${variable} must be a string/integer path array.`,
          );
        }
        context.variables[variable] = readString(response, path);
      }
    }
  }
}

export async function requestJson(url, { method = 'GET', token, body, expectedStatus } = {}) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(url, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  const parsed = text ? safeJson(text) : null;
  const accepted = expectedStatus === undefined ? response.ok : response.status === expectedStatus;
  if (!accepted) {
    throw new RunnerFailure(
      'HTTP_REQUEST_FAILED',
      `${method} ${url} returned HTTP ${response.status}.`,
      {
        status: response.status,
        responseShape: summarizeBody(parsed),
      },
    );
  }
  return parsed;
}

export async function runMcpProtocolLane(config, fixture, mode) {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const vitestEntry = resolve(packageRoot, 'node_modules/vitest/vitest.mjs');
  await runChecked(
    [
      process.execPath,
      vitestEntry,
      'run',
      'src/__tests__/project-builder.mcp.e2e.test.ts',
      '--reporter=verbose',
    ],
    {
      cwd: packageRoot,
      env: {
        ARCH_PROJECT_BUILDER_E2E: 'true',
        ARCH_PROJECT_BUILDER_E2E_MODE: mode,
        ARCH_PROJECT_BUILDER_STUDIO_URL: config.studioBaseUrl,
        ARCH_PROJECT_BUILDER_RUNTIME_URL: config.runtimeBaseUrl,
        ARCH_PROJECT_BUILDER_ACCESS_TOKEN: fixture.accessToken,
        ARCH_PROJECT_BUILDER_PROJECT_ID: fixture.projectId,
      },
    },
  );
}

export async function runChecked(command, { cwd = process.cwd(), env = {} } = {}) {
  validateCommand(command, 'command');
  const [executable, ...args] = command;
  const child = spawn(executable, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: 'inherit',
  });
  const { code, signal } = await childResult(child);
  if (code !== 0) {
    throw new RunnerFailure('COMMAND_FAILED', `${executable} exited unsuccessfully.`, {
      code,
      signal,
    });
  }
}

export async function runBootstrapCommands(config, substitutions, cwd, runCommand = runChecked) {
  const commands =
    config.bootstrapCommands ??
    (config.bootstrapCommand === undefined ? [] : [config.bootstrapCommand]);
  if (!Array.isArray(commands)) {
    throw new RunnerFailure(
      'INVALID_BOOTSTRAP_COMMANDS',
      'bootstrapCommands must be an array of command arrays.',
    );
  }
  for (const command of commands) {
    await runCommand(materialize(command, substitutions), { cwd });
  }
}

export async function createPinnedWorktree(repositoryRoot, expectedCommit = PRIOR_STUDIO_COMMIT) {
  const worktree = await mkdtemp(join(tmpdir(), 'arch-prior-studio-'));
  await rm(worktree, { recursive: true, force: true });
  try {
    await runChecked(['git', 'worktree', 'add', '--detach', worktree, expectedCommit], {
      cwd: repositoryRoot,
    });
    const resolvedCommit = await captureChecked(['git', 'rev-parse', 'HEAD'], { cwd: worktree });
    if (resolvedCommit.trim() !== expectedCommit) {
      throw new RunnerFailure('PINNED_COMMIT_MISMATCH', 'Pinned Studio worktree commit mismatch.', {
        expected: expectedCommit,
        actual: resolvedCommit.trim(),
      });
    }
    return worktree;
  } catch (error) {
    await cleanupPinnedWorktree(repositoryRoot, worktree, { tolerateUnregistered: true });
    throw error;
  }
}

export async function cleanupPinnedWorktree(
  repositoryRoot,
  worktree,
  { tolerateUnregistered = false } = {},
) {
  const ownedPrefix = join(tmpdir(), 'arch-prior-studio-');
  if (!isAbsolute(worktree) || !worktree.startsWith(ownedPrefix)) {
    throw new RunnerFailure('UNOWNED_WORKTREE', `Refusing to remove unowned worktree: ${worktree}`);
  }
  try {
    await runChecked(['git', 'worktree', 'remove', '--force', worktree], {
      cwd: repositoryRoot,
    });
  } catch (error) {
    if (!tolerateUnregistered) throw error;
  }
  await rm(worktree, { recursive: true, force: true });
}

export function materialize(value, substitutions) {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Z0-9_]+)\}/g, (match, key) => substitutions[key] ?? match);
  }
  if (Array.isArray(value)) return value.map((entry) => materialize(entry, substitutions));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, materialize(entry, substitutions)]),
    );
  }
  return value;
}

export function printRunnerFailure(error) {
  const failure =
    error instanceof RunnerFailure
      ? error
      : new RunnerFailure(
          'UNEXPECTED_RUNNER_FAILURE',
          error instanceof Error ? error.message : String(error),
        );
  console.error(
    JSON.stringify(
      {
        success: false,
        error: { code: failure.code, message: failure.message, details: failure.details },
      },
      null,
      2,
    ),
  );
}

async function captureChecked(command, { cwd }) {
  const [executable, ...args] = command;
  const child = spawn(executable, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => (output += chunk));
  const { code } = await childResult(child);
  if (code !== 0) throw new RunnerFailure('COMMAND_FAILED', `${executable} exited with ${code}.`);
  return output;
}

function validateCommand(command, label) {
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    command.some((part) => typeof part !== 'string' || !part)
  ) {
    throw new RunnerFailure('INVALID_COMMAND', `${label} must be a non-empty string array.`);
  }
}

function requireHttpUrl(value, label) {
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('unsupported protocol');
  } catch {
    throw new RunnerFailure('INVALID_URL', `${label} must be an HTTP(S) URL.`);
  }
}

function requireNonEmpty(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new RunnerFailure('INVALID_CONFIG_VALUE', `${label} must be a non-empty string.`);
  }
}

function safeName(value) {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function summarizeBody(value) {
  if (Array.isArray(value)) return { bodyType: 'array', itemCount: value.length };
  if (isRecord(value)) return { bodyType: 'object', fieldCount: Object.keys(value).length };
  if (value === null) return { bodyType: 'empty' };
  return { bodyType: typeof value };
}

function readString(value, path) {
  const result = readOptionalString(value, path);
  if (!result)
    throw new RunnerFailure('RESPONSE_FIELD_MISSING', `Missing response field ${path.join('.')}.`);
  return result;
}

function readOptionalString(value, path) {
  let current = value;
  for (const segment of path) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return typeof current === 'string' && current ? current : undefined;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function childResult(child) {
  return new Promise((resolveResult, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolveResult({ code, signal }));
  });
}

async function probeCommand(command, { cwd, env, timeoutMs }) {
  const [executable, ...args] = command;
  const child = spawn(executable, args, { cwd, env, stdio: 'ignore' });
  const result = await Promise.race([
    childResult(child).then(({ code }) => ({ code, timedOut: false })),
    delay(timeoutMs).then(() => ({ code: null, timedOut: true })),
  ]);
  if (result.timedOut && child.exitCode === null && child.signalCode === null)
    child.kill('SIGKILL');
  return result;
}

function assertServiceStillRunning(child) {
  if (child?.spawnError) {
    throw new RunnerFailure(
      'SERVICE_SPAWN_FAILED',
      `${child.name} failed to start. See ${child.logPath}.`,
      { cause: child.spawnError.message },
    );
  }
  if (child && (child.child.exitCode !== null || child.child.signalCode !== null)) {
    throw new RunnerFailure(
      'SERVICE_EXITED',
      `${child.name} exited before readiness. See ${child.logPath}.`,
    );
  }
}

function signalOwnedProcess(child, signal) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (!isRecord(error) || error.code !== 'ESRCH') throw error;
  }
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return Promise.race([childResult(child).then(() => true), delay(timeoutMs).then(() => false)]);
}
