#!/usr/bin/env node
import { resolve } from 'node:path';
import {
  cleanupPinnedWorktree,
  createPinnedWorktree,
  deleteProjectFixture,
  devLoginAndCreateProject,
  loadRunnerConfig,
  materialize,
  printRunnerFailure,
  runBootstrapCommands,
  runMcpProtocolLane,
  startOwnedServices,
  stopOwnedProcesses,
} from './project-builder-runner-lib.mjs';

let owned = [];
let worktree;
let repositoryRoot;
let materialized;
let fixture;
try {
  const config = await loadRunnerConfig(process.argv.slice(2), 'prior');
  repositoryRoot = resolve(config.configDirectory, config.repositoryRoot ?? '../../..');
  worktree = await createPinnedWorktree(repositoryRoot);
  const substitutions = { WORKTREE: worktree };
  await runBootstrapCommands(config, substitutions, worktree);
  materialized = materialize(config, substitutions);
  owned = await startOwnedServices(materialized, substitutions);
  fixture = await devLoginAndCreateProject(materialized);
  await runMcpProtocolLane(materialized, fixture, 'prior');
  console.log(JSON.stringify({ success: true, lane: 'prior' }));
} catch (error) {
  printRunnerFailure(error);
  process.exitCode = 1;
} finally {
  await deleteProjectFixture(materialized, fixture);
  await stopOwnedProcesses(owned);
  if (worktree && repositoryRoot) await cleanupPinnedWorktree(repositoryRoot, worktree);
}
