import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const packageRoot = resolve(new URL('../../', import.meta.url).pathname);
const releaseScript = resolve(packageRoot, '../../tools/release-mcp-tools.sh');
const RELEASE_SCRIPT_TEST_TIMEOUT_MS = 15_000;
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe('Arch MCP release rewrite cleanup', () => {
  it(
    'restores every temporarily rewritten file byte-for-byte and preserves the original exit',
    async () => {
      const fixture = await releaseFixture();
      const before = await snapshots(fixture.root, fixture.files);

      await expect(
        runReleaseShell(
          fixture.root,
          `source ${shellQuote(releaseScript)}; rewrite_to_dev '1.5.0-rc.test'; exit 37`,
        ),
      ).rejects.toMatchObject({ code: 37 });

      expect(await snapshots(fixture.root, fixture.files)).toEqual(before);
      expect(await recoveryDirectories(fixture.tempRoot)).toEqual([]);
    },
    RELEASE_SCRIPT_TEST_TIMEOUT_MS,
  );

  it(
    'fails cleanup and retains recovery backups when one rewritten file cannot be restored',
    async () => {
      const fixture = await releaseFixture();
      const personaPath = join(fixture.root, 'packages/mcp-debug/src/tools/persona.ts');

      await expect(
        runReleaseShell(
          fixture.root,
          [
            `source ${shellQuote(releaseScript)}`,
            `rewrite_to_dev '1.5.0-rc.test'`,
            `export ARCH_MCP_TEST_FAIL_RESTORE='persona.ts.release-restore'`,
            'exit 0',
          ].join('; '),
        ),
      ).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('recovery backups retained'),
      });

      const backups = await recoveryDirectories(fixture.tempRoot);
      expect(backups).toHaveLength(1);
      expect(await readFile(join(fixture.tempRoot, backups[0], 'persona.ts'), 'utf8')).toContain(
        "ARCH_MCP_SERVER_VERSION = '1.5.0'",
      );
      expect(await readFile(personaPath, 'utf8')).toContain(
        "ARCH_MCP_SERVER_VERSION = '1.5.0-rc.test'",
      );
    },
    RELEASE_SCRIPT_TEST_TIMEOUT_MS,
  );

  it(
    'does not mutate sources when a backup copy fails',
    async () => {
      const fixture = await releaseFixture();
      const before = await snapshots(fixture.root, fixture.files);

      await expect(
        runReleaseShell(
          fixture.root,
          [
            `source ${shellQuote(releaseScript)}`,
            `export ARCH_MCP_TEST_FAIL_BACKUP='persona.ts.partial'`,
            `rewrite_to_dev '1.5.0-rc.test'`,
          ].join('; '),
        ),
      ).rejects.toMatchObject({ code: 91 });

      expect(await snapshots(fixture.root, fixture.files)).toEqual(before);
      expect(await recoveryDirectories(fixture.tempRoot)).toEqual([]);
    },
    RELEASE_SCRIPT_TEST_TIMEOUT_MS,
  );

  it(
    'fails cleanup and retains available recovery data when a backup is missing',
    async () => {
      const fixture = await releaseFixture();
      const personaPath = join(fixture.root, 'packages/mcp-debug/src/tools/persona.ts');

      await expect(
        runReleaseShell(
          fixture.root,
          [
            `source ${shellQuote(releaseScript)}`,
            `rewrite_to_dev '1.5.0-rc.test'`,
            `rm -f "$BAK_DIR/persona.ts"`,
            'exit 0',
          ].join('; '),
        ),
      ).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('Missing recovery backup'),
      });

      expect(await readFile(personaPath, 'utf8')).toContain(
        "ARCH_MCP_SERVER_VERSION = '1.5.0-rc.test'",
      );
      const retainedDirectories = (await readdir(fixture.tempRoot, { withFileTypes: true })).filter(
        (entry) => entry.isDirectory() && entry.name.startsWith('arch-mcp-release.'),
      );
      expect(retainedDirectories).toHaveLength(1);
    },
    RELEASE_SCRIPT_TEST_TIMEOUT_MS,
  );
});

async function releaseFixture(): Promise<{
  root: string;
  tempRoot: string;
  files: string[];
}> {
  const root = await mkdtemp(join(tmpdir(), 'arch-release-script-'));
  roots.push(root);
  const tempRoot = join(root, 'tmp');
  const fakeBin = join(root, 'bin');
  const files = [
    'packages/mcp-debug/package.json',
    'packages/mcp-debug/README.md',
    'packages/mcp-debug/bin/mcp-debug.ts',
    'packages/mcp-debug/src/tools/persona.ts',
  ];
  await mkdir(tempRoot, { recursive: true });
  await mkdir(fakeBin, { recursive: true });
  for (const file of files) await mkdir(dirname(join(root, file)), { recursive: true });
  await writeFile(
    join(root, files[0]),
    '{"name":"@koreai/arch-mcp-tools","version":"1.5.0","private":true}\n',
  );
  await writeFile(join(root, files[1]), '@koreai/arch-mcp-tools@1.5.0\n');
  await writeFile(join(root, files[2]), '@koreai/arch-mcp-tools\n');
  await writeFile(join(root, files[3]), "export const ARCH_MCP_SERVER_VERSION = '1.5.0';\n");
  const fakeCp = join(fakeBin, 'cp');
  await writeFile(
    fakeCp,
    [
      '#!/usr/bin/env bash',
      'destination="${@: -1}"',
      'destination_name="$(basename "$destination")"',
      'if [[ -n "${ARCH_MCP_TEST_FAIL_RESTORE:-}"',
      '  && "$1" == "-f"',
      '  && "$destination_name" == "$ARCH_MCP_TEST_FAIL_RESTORE".* ]]; then',
      '  exit 91',
      'fi',
      'if [[ -n "${ARCH_MCP_TEST_FAIL_BACKUP:-}"',
      '  && "$destination_name" == "$ARCH_MCP_TEST_FAIL_BACKUP" ]]; then',
      '  exit 91',
      'fi',
      'exec /bin/cp "$@"',
      '',
    ].join('\n'),
  );
  await chmod(fakeCp, 0o755);
  return { root, tempRoot, files };
}

async function snapshots(root: string, files: string[]): Promise<Record<string, string>> {
  return Object.fromEntries(
    await Promise.all(files.map(async (file) => [file, await readFile(join(root, file), 'utf8')])),
  );
}

async function recoveryDirectories(tempRoot: string): Promise<string[]> {
  const entries = await readdir(tempRoot, { withFileTypes: true });
  const candidates = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        try {
          await readFile(join(tempRoot, entry.name, 'persona.ts'));
          return entry.name;
        } catch (error: unknown) {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
          throw error;
        }
      }),
  );
  return candidates.filter((entry): entry is string => entry !== null);
}

async function runReleaseShell(root: string, command: string): Promise<void> {
  await execute('bash', ['-c', command], {
    env: {
      ...process.env,
      ARCH_MCP_RELEASE_REPO_ROOT: root,
      TMPDIR: join(root, 'tmp'),
      PATH: `${join(root, 'bin')}:${process.env.PATH ?? ''}`,
    },
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
