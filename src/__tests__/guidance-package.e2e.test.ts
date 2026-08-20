import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const execute = promisify(execFile);
const packageRoot = resolve(new URL('../../', import.meta.url).pathname);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('published Arch MCP guidance package', () => {
  it('packs both executable shims and the canonical skill assets', async () => {
    const destination = await temporaryRoot();
    const { stdout } = await execute(
      'npm',
      ['pack', '--json', '--ignore-scripts', '--pack-destination', destination],
      { cwd: packageRoot, env: npmChildEnvironment(), maxBuffer: 10 * 1024 * 1024 },
    );
    const packed = JSON.parse(stdout) as Array<{ files: Array<{ path: string }>; size: number }>;
    const paths = packed[0].files.map(({ path }) => path);

    expect(paths).toEqual(
      expect.arrayContaining([
        'bin/mcp-debug.js',
        'bin/arch-mcp-guidance.js',
        'skills/arch-platform/SKILL.md',
        'skills/arch-platform/agents/openai.yaml',
        'dist/bin/arch-mcp-guidance.js',
        'dist/src/guidance-installer.js',
      ]),
    );
    expect(packed[0].size).toBeLessThan(5 * 1024 * 1024);
  }, 30_000);

  it('runs every client and scope through the clean-installed published shim', async () => {
    const { installRoot, guidanceBin } = await cleanInstallPackedPackage();
    for (const { client, scope } of [
      { client: 'codex', scope: 'user' },
      { client: 'codex', scope: 'project' },
      { client: 'claude', scope: 'user' },
      { client: 'claude', scope: 'project' },
    ] as const) {
      const projectRoot = await temporaryRoot();
      const codexHome = join(projectRoot, '.codex-user');
      const environment = {
        ...process.env,
        HOME: projectRoot,
        CODEX_HOME: codexHome,
      };
      const installed = await execute(
        guidanceBin,
        ['install', '--client', client, '--scope', scope],
        { cwd: projectRoot, env: environment },
      );
      const clientDirectory = client === 'codex' ? '.codex' : '.claude';
      const skillRoot =
        scope === 'project'
          ? join(projectRoot, clientDirectory, 'skills', 'arch-platform')
          : join(
              client === 'codex' ? codexHome : join(projectRoot, '.claude'),
              'skills',
              'arch-platform',
            );

      expect(installed.stdout).toContain(`Installed ${skillRoot}`);
      expect(await readFile(join(skillRoot, 'SKILL.md'), 'utf8')).toContain(
        'arch://guidance/v1/manifest',
      );
      const idempotent = await execute(
        guidanceBin,
        ['install', '--client', client, '--scope', scope],
        { cwd: projectRoot, env: environment },
      );
      expect(idempotent.stdout).toContain(`Installed ${skillRoot}`);

      const uninstalled = await execute(
        guidanceBin,
        ['uninstall', '--client', client, '--scope', scope],
        { cwd: projectRoot, env: environment },
      );
      expect(uninstalled.stdout).toContain(`Uninstalled ${skillRoot}`);
      await expect(readFile(join(skillRoot, 'SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(installRoot).not.toBe(packageRoot);
  }, 30_000);

  it('serves the complete guidance graph from the clean-installed stdio package without startup writes', async () => {
    const { mcpBin } = await cleanInstallPackedPackage();
    const sandbox = await temporaryRoot();
    const projectRoot = join(sandbox, 'project');
    const homeRoot = join(sandbox, 'home');
    const codexHome = join(sandbox, 'codex-home');
    await Promise.all([mkdir(projectRoot), mkdir(homeRoot), mkdir(codexHome)]);
    const before = await snapshotTree(sandbox);
    const { client, transport } = await connectPackagedServer(mcpBin, projectRoot, {
      ...process.env,
      HOME: homeRoot,
      CODEX_HOME: codexHome,
    });
    try {
      expect((await client.listTools()).tools).toHaveLength(45);
      expect((await client.listResources()).resources.map(({ uri }) => uri)).toEqual([
        'arch://project-builder/registry',
        'arch://project-builder/providers/workflow',
        'arch://guidance/v1/manifest',
        'arch://guidance/v1/features',
        'arch://guidance/v1/operations',
        'arch://guidance/v1/dependencies',
      ]);
      expect(
        (await client.listResourceTemplates()).resourceTemplates.map(({ name }) => name),
      ).toEqual([
        'project-builder-project-report',
        'guidance-feature-detail',
        'guidance-tool-detail',
      ]);
      expect((await client.listPrompts()).prompts.map(({ name }) => name)).toEqual([
        'build-agentic-project',
        'continue-project-operation',
        'plan-platform-operation',
        'verify-platform-operation',
      ]);

      const manifest = (await readJsonResource(client, 'arch://guidance/v1/manifest')) as {
        schemaVersion: string;
        counts: { operations: number };
      };
      const operations = (await readJsonResource(
        client,
        'arch://guidance/v1/operations',
      )) as Array<{
        id: string;
        featureId: string;
        validatesWith: { tool: string; action: string };
      }>;
      const dependencies = (await readJsonResource(
        client,
        'arch://guidance/v1/dependencies',
      )) as Array<{
        from: string;
        to: string;
        evidence: Array<{ tool: string; action?: string }>;
      }>;
      const operationIds = new Set(operations.map(({ id }) => id));
      const featureIds = new Set(
        (
          (await readJsonResource(client, 'arch://guidance/v1/features')) as Array<{ id: string }>
        ).map(({ id }) => id),
      );
      expect(manifest.schemaVersion).toBe('1');
      expect(manifest.counts.operations).toBe(operations.length);
      for (const operation of operations) {
        expect(featureIds.has(operation.featureId)).toBe(true);
        expect(
          operationIds.has(`${operation.validatesWith.tool}:${operation.validatesWith.action}`),
        ).toBe(true);
      }
      for (const edge of dependencies) {
        expect(featureIds.has(edge.from)).toBe(true);
        expect(featureIds.has(edge.to)).toBe(true);
        for (const evidence of edge.evidence) {
          expect(operationIds.has(`${evidence.tool}:${evidence.action ?? 'invoke'}`)).toBe(true);
        }
      }
      await expect(
        readJsonResource(client, 'arch://guidance/v1/tools/platform_project_builder'),
      ).resolves.toMatchObject({ tool: { name: 'platform_project_builder' } });
    } finally {
      await client.close();
      await transport.close().catch(() => undefined);
    }
    expect(await snapshotTree(sandbox)).toEqual(before);
  }, 30_000);

  it('keeps every packaged installer failure non-mutating, including descendant symlinks', async () => {
    const { guidanceBin } = await cleanInstallPackedPackage();

    const unmanagedRoot = await temporaryRoot();
    const unmanagedTarget = join(unmanagedRoot, '.codex', 'skills', 'arch-platform');
    await mkdir(unmanagedTarget, { recursive: true });
    await writeFile(join(unmanagedTarget, 'SKILL.md'), 'unmanaged');
    await expectNoMutation(
      unmanagedRoot,
      () =>
        execute(guidanceBin, ['install', '--client', 'codex', '--scope', 'project'], {
          cwd: unmanagedRoot,
        }),
      /owned|overwrite/i,
    );

    const modifiedRoot = await temporaryRoot();
    await execute(guidanceBin, ['install', '--client', 'codex', '--scope', 'project'], {
      cwd: modifiedRoot,
    });
    const modifiedTarget = join(modifiedRoot, '.codex', 'skills', 'arch-platform');
    await writeFile(join(modifiedTarget, 'SKILL.md'), 'modified');
    await expectNoMutation(
      modifiedRoot,
      () =>
        execute(guidanceBin, ['uninstall', '--client', 'codex', '--scope', 'project'], {
          cwd: modifiedRoot,
        }),
      /modified guidance file/i,
    );

    const mismatchRoot = await temporaryRoot();
    await execute(guidanceBin, ['install', '--client', 'codex', '--scope', 'project'], {
      cwd: mismatchRoot,
    });
    const mismatchManifest = join(
      mismatchRoot,
      '.codex',
      'skills',
      'arch-platform',
      '.arch-mcp-guidance.json',
    );
    const manifest = JSON.parse(await readFile(mismatchManifest, 'utf8'));
    await writeFile(mismatchManifest, JSON.stringify({ ...manifest, client: 'claude' }));
    await expectNoMutation(
      mismatchRoot,
      () =>
        execute(guidanceBin, ['uninstall', '--client', 'codex', '--scope', 'project'], {
          cwd: mismatchRoot,
        }),
      /ownership does not match/i,
    );

    const symlinkRoot = await temporaryRoot();
    await execute(guidanceBin, ['install', '--client', 'codex', '--scope', 'project'], {
      cwd: symlinkRoot,
    });
    const skillRoot = join(symlinkRoot, '.codex', 'skills', 'arch-platform');
    const expectedAgent = await readFile(join(skillRoot, 'agents', 'openai.yaml'), 'utf8');
    const external = join(symlinkRoot, 'external');
    await mkdir(external);
    await writeFile(join(external, 'openai.yaml'), expectedAgent);
    await rm(join(skillRoot, 'agents'), { recursive: true });
    await symlink(external, join(skillRoot, 'agents'));
    await expectNoMutation(
      symlinkRoot,
      () =>
        execute(guidanceBin, ['uninstall', '--client', 'codex', '--scope', 'project'], {
          cwd: symlinkRoot,
        }),
      /symlink/i,
    );
    await expect(readFile(join(external, 'openai.yaml'), 'utf8')).resolves.toBe(expectedAgent);
  }, 30_000);

  it('returns nonzero and leaves no skill on invalid CLI input', async () => {
    const { guidanceBin } = await cleanInstallPackedPackage();
    const projectRoot = await temporaryRoot();
    await expect(
      execute(guidanceBin, ['install', '--client', 'unknown', '--scope', 'project'], {
        cwd: projectRoot,
      }),
    ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Expected --client') });
    await expect(
      readFile(join(projectRoot, '.codex', 'skills', 'arch-platform', 'SKILL.md')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  }, 30_000);
});

async function cleanInstallPackedPackage(): Promise<{
  installRoot: string;
  guidanceBin: string;
  mcpBin: string;
}> {
  const installRoot = await temporaryRoot();
  const artifacts = join(installRoot, 'artifacts');
  await mkdir(artifacts);
  await writeFile(
    join(installRoot, 'package.json'),
    '{"name":"arch-guidance-clean-install","private":true}\n',
  );
  const { stdout } = await execute(
    'npm',
    ['pack', '--json', '--ignore-scripts', '--pack-destination', artifacts],
    { cwd: packageRoot, env: npmChildEnvironment(), maxBuffer: 10 * 1024 * 1024 },
  );
  const [{ filename }] = JSON.parse(stdout) as Array<{ filename: string }>;
  await execute(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-package-lock',
      '--no-audit',
      '--no-fund',
      join(artifacts, filename),
    ],
    { cwd: installRoot, env: npmChildEnvironment(), maxBuffer: 10 * 1024 * 1024 },
  );
  return {
    installRoot,
    guidanceBin: join(installRoot, 'node_modules', '.bin', 'arch-mcp-guidance'),
    mcpBin: join(installRoot, 'node_modules', '.bin', 'arch-mcp-tools'),
  };
}

function npmChildEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // `npm publish --dry-run` exports this setting to lifecycle scripts. Nested
    // pack/install E2E commands must create artifacts even when the parent publish is dry-run.
    npm_config_dry_run: 'false',
  };
}

async function connectPackagedServer(
  command: string,
  cwd: string,
  environment: NodeJS.ProcessEnv,
): Promise<{ client: Client; transport: StdioClientTransport }> {
  const env = Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  const transport = new StdioClientTransport({ command, cwd, env, stderr: 'pipe' });
  const client = new Client({ name: 'published-package-e2e', version: '1.0.0' });
  await client.connect(transport);
  return { client, transport };
}

async function readJsonResource(client: Client, uri: string): Promise<unknown> {
  const result = await client.readResource({ uri });
  const content = result.contents[0];
  if (!content || !('text' in content)) throw new Error(`Expected text resource for ${uri}`);
  return JSON.parse(content.text);
}

async function expectNoMutation(
  root: string,
  operation: () => Promise<unknown>,
  message: RegExp,
): Promise<void> {
  const before = await snapshotTree(root);
  await expect(operation()).rejects.toMatchObject({
    code: 1,
    stderr: expect.stringMatching(message),
  });
  expect(await snapshotTree(root)).toEqual(before);
}

async function snapshotTree(root: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  const visit = async (directory: string, prefix = ''): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = join(directory, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        snapshot[relative] = `symlink:${await readlink(absolute)}`;
      } else if (entry.isDirectory()) {
        snapshot[`${relative}/`] = 'directory';
        await visit(absolute, relative);
      } else {
        snapshot[relative] = `file:${(await readFile(absolute)).toString('base64')}`;
      }
    }
  };
  await visit(root);
  return snapshot;
}

async function temporaryRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'arch-guidance-package-')));
  roots.push(root);
  return root;
}
