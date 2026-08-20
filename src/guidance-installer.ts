import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARCH_MCP_SERVER_VERSION } from './tools/persona.js';

const MANIFEST_NAME = '.arch-mcp-guidance.json';
const MANIFEST_SCHEMA_VERSION = 1;
const FILE_MODE = 0o644;
const OWNED_FILES = ['SKILL.md', 'agents/openai.yaml'] as const;
const SHA256 = /^[a-f0-9]{64}$/;

export type GuidanceClient = 'codex' | 'claude';
export type GuidanceScope = 'user' | 'project';

interface GuidanceManifest {
  readonly schemaVersion: typeof MANIFEST_SCHEMA_VERSION;
  readonly packageVersion: string;
  readonly knowledgeSchemaVersion: '1';
  readonly client: GuidanceClient;
  readonly scope: GuidanceScope;
  readonly files: Readonly<Record<string, string>>;
}

export interface GuidanceInstallOptions {
  readonly client: GuidanceClient;
  readonly scope: GuidanceScope;
  readonly userRoot?: string;
  readonly projectRoot?: string;
  readonly sourceRoot?: string;
}

export async function installGuidance(options: GuidanceInstallOptions): Promise<string> {
  const sourceRoot = options.sourceRoot ?? defaultSourceRoot();
  const destination = await resolveDestination(options);
  await assertNoSymlink(destination);
  const files = await loadSourceFiles(sourceRoot);
  const desiredManifest = manifest(options, files);

  if (await pathExists(destination)) {
    const current = await readOwnedManifest(destination);
    if (JSON.stringify(current) === JSON.stringify(desiredManifest)) {
      await assertOwnedFilesMatch(destination, current);
      return destination;
    }
    throw new Error(`Refusing to overwrite existing guidance at ${destination}`);
  }

  const parent = dirname(destination);
  await mkdir(parent, { recursive: true });
  const safeParent = await realpath(parent);
  const temporary = await mkdtemp(join(safeParent, '.arch-platform.tmp-'));
  try {
    for (const [relativePath, content] of Object.entries(files)) {
      const target = join(temporary, relativePath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, { encoding: 'utf8', mode: FILE_MODE, flag: 'wx' });
    }
    await writeFile(
      join(temporary, MANIFEST_NAME),
      `${JSON.stringify(desiredManifest, null, 2)}\n`,
      {
        encoding: 'utf8',
        mode: FILE_MODE,
        flag: 'wx',
      },
    );
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
  return destination;
}

export async function uninstallGuidance(options: GuidanceInstallOptions): Promise<string> {
  const destination = await resolveDestination(options);
  await assertNoSymlink(destination);
  const current = await readOwnedManifest(destination);
  if (current.client !== options.client || current.scope !== options.scope) {
    throw new Error(`Guidance ownership does not match ${options.client}/${options.scope}`);
  }
  await assertOwnedFilesMatch(destination, current);
  for (const relativePath of Object.keys(current.files).sort().reverse()) {
    const target = ownedTarget(destination, relativePath);
    await assertNoOwnedPathSymlink(destination, relativePath);
    await rm(target);
    const parent = dirname(target);
    if (parent !== destination) await rmdir(parent).catch(handleNonEmptyDirectory);
  }
  await rm(join(destination, MANIFEST_NAME));
  await rmdir(destination).catch(handleNonEmptyDirectory);
  return destination;
}

export async function resolveDestination(options: GuidanceInstallOptions): Promise<string> {
  const base =
    options.scope === 'project'
      ? resolve(options.projectRoot ?? process.cwd())
      : resolve(options.userRoot ?? defaultUserRoot(options.client));
  const root = await realpath(base).catch(async (error: unknown) => {
    if (!isMissing(error)) throw error;
    await mkdir(base, { recursive: true });
    return realpath(base);
  });
  const clientDirectory = options.client === 'codex' ? '.codex' : '.claude';
  return options.scope === 'project'
    ? join(root, clientDirectory, 'skills', 'arch-platform')
    : join(root, 'skills', 'arch-platform');
}

function defaultUserRoot(client: GuidanceClient): string {
  if (client === 'codex') return process.env.CODEX_HOME ?? join(homedir(), '.codex');
  return join(homedir(), '.claude');
}

function defaultSourceRoot(): string {
  return fileURLToPath(new URL('../skills/arch-platform/', import.meta.url));
}

async function loadSourceFiles(sourceRoot: string): Promise<Record<string, string>> {
  return {
    'SKILL.md': await readFile(join(sourceRoot, 'SKILL.md'), 'utf8'),
    'agents/openai.yaml': await readFile(join(sourceRoot, 'agents/openai.yaml'), 'utf8'),
  };
}

function manifest(
  options: GuidanceInstallOptions,
  files: Readonly<Record<string, string>>,
): GuidanceManifest {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    packageVersion: ARCH_MCP_SERVER_VERSION,
    knowledgeSchemaVersion: '1',
    client: options.client,
    scope: options.scope,
    files: Object.fromEntries(
      Object.entries(files).map(([path, content]) => [path, hash(content)]),
    ),
  };
}

async function readOwnedManifest(destination: string): Promise<GuidanceManifest> {
  await assertNoOwnedPathSymlink(destination, MANIFEST_NAME);
  const raw = await readFile(join(destination, MANIFEST_NAME), 'utf8').catch((error: unknown) => {
    if (isMissing(error)) throw new Error(`Existing guidance is not owned by Arch: ${destination}`);
    throw error;
  });
  const parsed = JSON.parse(raw) as Partial<GuidanceManifest>;
  const fileEntries =
    parsed.files && typeof parsed.files === 'object' ? Object.entries(parsed.files) : [];
  if (
    parsed.schemaVersion !== MANIFEST_SCHEMA_VERSION ||
    typeof parsed.packageVersion !== 'string' ||
    parsed.knowledgeSchemaVersion !== '1' ||
    (parsed.client !== 'codex' && parsed.client !== 'claude') ||
    (parsed.scope !== 'user' && parsed.scope !== 'project') ||
    fileEntries.length !== OWNED_FILES.length ||
    !OWNED_FILES.every((path) => SHA256.test(String(parsed.files?.[path]))) ||
    fileEntries.some(([path]) => !OWNED_FILES.includes(path as (typeof OWNED_FILES)[number]))
  )
    throw new Error(`Invalid Arch guidance ownership manifest at ${destination}`);
  return parsed as GuidanceManifest;
}

async function assertOwnedFilesMatch(
  destination: string,
  manifest: GuidanceManifest,
): Promise<void> {
  for (const [relativePath, expectedHash] of Object.entries(manifest.files)) {
    const target = ownedTarget(destination, relativePath);
    await assertNoOwnedPathSymlink(destination, relativePath);
    const content = await readFile(target);
    if (hash(content) !== expectedHash) {
      throw new Error(`Refusing modified guidance file ${target}`);
    }
  }
}

function ownedTarget(destination: string, relativePath: string): string {
  const root = resolve(destination);
  const target = resolve(root, relativePath);
  const child = relative(root, target);
  if (!child || child.startsWith(`..${sep}`) || child === '..') {
    throw new Error(`Invalid Arch guidance ownership path: ${relativePath}`);
  }
  return target;
}

async function assertNoSymlink(destination: string): Promise<void> {
  let current = destination;
  while (current !== dirname(current)) {
    const stat = await lstat(current).catch((error: unknown) => {
      if (isMissing(error)) return undefined;
      throw error;
    });
    if (stat?.isSymbolicLink())
      throw new Error(`Refusing guidance path through symlink: ${current}`);
    current = dirname(current);
  }
}

async function assertNoOwnedPathSymlink(destination: string, relativePath: string): Promise<void> {
  ownedTarget(destination, relativePath);
  let current = resolve(destination);
  for (const segment of relativePath.split('/')) {
    current = join(current, segment);
    const stat = await lstat(current).catch((error: unknown) => {
      if (isMissing(error)) return undefined;
      throw error;
    });
    if (stat?.isSymbolicLink()) {
      throw new Error(`Refusing guidance path through symlink: ${current}`);
    }
  }
}

async function pathExists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    (error: unknown) => {
      if (isMissing(error)) return false;
      throw error;
    },
  );
}

function hash(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function isMissing(error: unknown): boolean {
  return (error as { code?: string }).code === 'ENOENT';
}

function handleNonEmptyDirectory(error: unknown): void {
  const code = (error as { code?: string }).code;
  if (code !== 'ENOTEMPTY' && code !== 'ENOENT') throw error;
}
