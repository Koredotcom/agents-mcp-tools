import { cp, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  installGuidance,
  resolveDestination,
  uninstallGuidance,
  type GuidanceClient,
} from '../guidance-installer.js';

const roots: string[] = [];
const sourceRoot = new URL('../../skills/arch-platform/', import.meta.url).pathname;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Arch MCP guidance installer', () => {
  for (const client of ['codex', 'claude'] as const) {
    it(`installs and uninstalls owned ${client} user guidance idempotently`, async () => {
      const userRoot = await temporaryRoot();
      const options = { client, scope: 'user' as const, userRoot, sourceRoot };

      const destination = await installGuidance(options);
      expect(destination).toBe(join(userRoot, 'skills', 'arch-platform'));
      expect(await readFile(join(destination, 'SKILL.md'), 'utf8')).toContain(
        'arch://guidance/v1/manifest',
      );
      expect(
        JSON.parse(await readFile(join(destination, '.arch-mcp-guidance.json'), 'utf8')),
      ).toMatchObject({
        schemaVersion: 1,
        knowledgeSchemaVersion: '1',
        client,
        scope: 'user',
      });
      expect(await installGuidance(options)).toBe(destination);
      expect(await uninstallGuidance(options)).toBe(destination);
      await expect(readFile(join(destination, 'SKILL.md'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });
  }

  it('resolves project-scoped client destinations without touching the user home', async () => {
    const projectRoot = await temporaryRoot();
    expect(await resolveDestination({ client: 'codex', scope: 'project', projectRoot })).toBe(
      join(projectRoot, '.codex', 'skills', 'arch-platform'),
    );
    expect(await resolveDestination({ client: 'claude', scope: 'project', projectRoot })).toBe(
      join(projectRoot, '.claude', 'skills', 'arch-platform'),
    );
  });

  it('refuses unmanaged, modified, and symlinked targets', async () => {
    const userRoot = await temporaryRoot();
    const destination = join(userRoot, 'skills', 'arch-platform');
    await mkdir(destination, { recursive: true });
    await writeFile(join(destination, 'SKILL.md'), 'unmanaged');
    await expect(
      installGuidance({ client: 'codex', scope: 'user', userRoot, sourceRoot }),
    ).rejects.toThrow(/not owned|overwrite/i);

    await rm(destination, { recursive: true });
    const options = {
      client: 'codex' as GuidanceClient,
      scope: 'user' as const,
      userRoot,
      sourceRoot,
    };
    await installGuidance(options);
    await writeFile(join(destination, 'SKILL.md'), 'modified');
    await expect(installGuidance(options)).rejects.toThrow(/modified guidance file/);
    await expect(uninstallGuidance(options)).rejects.toThrow(/modified guidance file/);

    await rm(destination, { recursive: true });
    const external = await temporaryRoot();
    await mkdir(join(userRoot, 'skills'), { recursive: true });
    await symlink(external, destination);
    await expect(installGuidance(options)).rejects.toThrow(/symlink/);
  });

  it('refuses descendant symlinks without reading or deleting external owned-looking files', async () => {
    const userRoot = await temporaryRoot();
    const options = {
      client: 'codex' as const,
      scope: 'user' as const,
      userRoot,
      sourceRoot,
    };
    const destination = await installGuidance(options);
    const expected = await readFile(join(destination, 'agents', 'openai.yaml'), 'utf8');
    const external = await temporaryRoot();
    await writeFile(join(external, 'openai.yaml'), expected);
    await rm(join(destination, 'agents'), { recursive: true });
    await symlink(external, join(destination, 'agents'));

    await expect(installGuidance(options)).rejects.toThrow(/symlink/);
    await expect(uninstallGuidance(options)).rejects.toThrow(/symlink/);
    await expect(readFile(join(external, 'openai.yaml'), 'utf8')).resolves.toBe(expected);
  });

  it('rejects changed sources and malformed or mismatched ownership manifests', async () => {
    const userRoot = await temporaryRoot();
    const copiedSource = join(await temporaryRoot(), 'source');
    await cp(sourceRoot, copiedSource, { recursive: true });
    const options = {
      client: 'codex' as const,
      scope: 'user' as const,
      userRoot,
      sourceRoot: copiedSource,
    };
    const destination = await installGuidance(options);

    await writeFile(join(copiedSource, 'SKILL.md'), 'changed canonical guidance');
    await expect(installGuidance(options)).rejects.toThrow(/overwrite/);

    const manifestPath = join(destination, '.arch-mcp-guidance.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    await writeFile(manifestPath, JSON.stringify({ ...manifest, client: 'claude' }));
    await expect(uninstallGuidance(options)).rejects.toThrow(/ownership does not match/);

    for (const invalidManifest of [
      { schemaVersion: 99, client: 'codex', scope: 'user', files: {} },
      { schemaVersion: 1, client: 'invalid', scope: 'user', files: {} },
      { schemaVersion: 1, client: 'codex', scope: 'invalid', files: {} },
      { schemaVersion: 1, client: 'codex', scope: 'user', files: null },
      { ...manifest, files: { '../outside': '0'.repeat(64), 'SKILL.md': '0'.repeat(64) } },
      { ...manifest, files: { ...manifest.files, 'SKILL.md': 'not-a-hash' } },
    ]) {
      await writeFile(manifestPath, JSON.stringify(invalidManifest));
      await expect(uninstallGuidance(options)).rejects.toThrow(
        /Invalid Arch guidance ownership manifest/,
      );
    }
  });

  it('resolves default and missing roots and preserves unrelated files on uninstall', async () => {
    const previousCodexHome = process.env.CODEX_HOME;
    const previousHome = process.env.HOME;
    const codexHome = join(await temporaryRoot(), 'missing-codex-home');
    process.env.CODEX_HOME = codexHome;
    try {
      expect(await resolveDestination({ client: 'codex', scope: 'user' })).toBe(
        join(codexHome, 'skills', 'arch-platform'),
      );
      expect(await resolveDestination({ client: 'claude', scope: 'project' })).toBe(
        join(process.cwd(), '.claude', 'skills', 'arch-platform'),
      );
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
    }

    delete process.env.CODEX_HOME;
    const fallbackHome = await temporaryRoot();
    process.env.HOME = fallbackHome;
    try {
      expect(await resolveDestination({ client: 'codex', scope: 'user' })).toBe(
        join(fallbackHome, '.codex', 'skills', 'arch-platform'),
      );
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }

    const userRoot = await temporaryRoot();
    const options = { client: 'codex' as const, scope: 'user' as const, userRoot };
    const destination = await installGuidance(options);
    await writeFile(join(destination, 'unrelated.txt'), 'preserve me');
    await uninstallGuidance(options);
    expect(await readFile(join(destination, 'unrelated.txt'), 'utf8')).toBe('preserve me');
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'arch-guidance-')));
  roots.push(root);
  return root;
}
