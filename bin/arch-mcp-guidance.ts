#!/usr/bin/env node
import { installGuidance, uninstallGuidance } from '../src/guidance-installer.js';
import { fileURLToPath } from 'node:url';

export * from '../src/guidance-installer.js';

function parseArgs(args: readonly string[]) {
  const command = args[0];
  if (command !== 'install' && command !== 'uninstall')
    throw new Error('Expected install or uninstall');
  const clientIndex = args.indexOf('--client');
  const scopeIndex = args.indexOf('--scope');
  const client = args[clientIndex + 1];
  const scope = args[scopeIndex + 1];
  if (client !== 'codex' && client !== 'claude') throw new Error('Expected --client codex|claude');
  if (scope !== 'user' && scope !== 'project') throw new Error('Expected --scope user|project');
  return { command, client, scope } as const;
}

export function runGuidanceCli(args: readonly string[] = process.argv.slice(2)): void {
  void main(args).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

async function main(args: readonly string[]): Promise<void> {
  const { command, client, scope } = parseArgs(args);
  const destination =
    command === 'install'
      ? await installGuidance({
          client,
          scope,
          sourceRoot: fileURLToPath(new URL('../../skills/arch-platform/', import.meta.url)),
        })
      : await uninstallGuidance({ client, scope });
  process.stdout.write(`${command === 'install' ? 'Installed' : 'Uninstalled'} ${destination}\n`);
}
