#!/usr/bin/env node
import { resolve } from 'node:path';
import {
  cleanupSessionHistoryPinnedWorktree,
  createSessionHistoryPinnedWorktree,
  loadSessionHistoryConfig,
  PRIOR_RUNTIME_COMMIT,
  provisionSessionHistoryFixture,
  runBuiltMcpJourney,
  runPreparationCommands,
  startSessionHistoryServices,
  stopOwnedProcesses,
  verifyPriorPin,
} from './session-history-runner-lib.mjs';
let owned = [];
let worktree;
let repositoryRoot;
let config;
try {
  config = await loadSessionHistoryConfig(process.argv.slice(2), 'prior');
  repositoryRoot = resolve(config.configDirectory, config.repositoryRoot);
  await verifyPriorPin(repositoryRoot, config.expectedTag, config.expectedCommit, config);
  worktree = await createSessionHistoryPinnedWorktree(config, repositoryRoot, PRIOR_RUNTIME_COMMIT);
  await runPreparationCommands(config, worktree);
  owned = await startSessionHistoryServices(config, { WORKTREE: worktree });
  const fixture = await provisionSessionHistoryFixture(config);
  const codex = await runBuiltMcpJourney(config, 'codex-prior', fixture);
  const claude = await runBuiltMcpJourney(config, 'claude-prior', fixture);
  if (JSON.stringify(codex) !== JSON.stringify(claude))
    throw new Error('Client metadata changed prior-Runtime protocol behavior.');
  console.log(JSON.stringify({ success: true, lane: 'prior' }));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await stopOwnedProcesses(owned);
  if (config && worktree && repositoryRoot)
    await cleanupSessionHistoryPinnedWorktree(config, repositoryRoot, worktree);
}
