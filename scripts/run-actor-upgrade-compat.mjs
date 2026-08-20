#!/usr/bin/env node
import { resolve } from 'node:path';
import {
  ACTOR_UPGRADE_BASELINE_COMMIT,
  cleanupPinnedWorktree,
  createPinnedWorktree,
  deleteProjectFixture,
  executeApiSteps,
  loadRunnerConfig,
  loginActors,
  materialize,
  partitionTransitionProcesses,
  printRunnerFailure,
  requestJson,
  RunnerFailure,
  runBootstrapCommands,
  runChecked,
  startOwnedServices,
  stopOwnedProcesses,
  validateBaseConfig,
} from './project-builder-runner-lib.mjs';

let owned = [];
let worktree;
let repositoryRoot;
let cleanupConfig;
let cleanupFixture;
try {
  const config = await loadRunnerConfig(process.argv.slice(2), 'upgrade');
  if (!Array.isArray(config.currentServices) || config.currentServices.length === 0) {
    throw new RunnerFailure(
      'CURRENT_SERVICES_REQUIRED',
      'Upgrade config must declare currentServices.',
    );
  }
  if (!Array.isArray(config.migrationCommands) || config.migrationCommands.length < 3) {
    throw new RunnerFailure(
      'MIGRATION_COMMANDS_REQUIRED',
      'Upgrade config must declare preflight, migrate, and post-migration verification commands.',
    );
  }
  repositoryRoot = resolve(config.configDirectory, config.repositoryRoot ?? '../../..');
  worktree = await createPinnedWorktree(repositoryRoot, ACTOR_UPGRADE_BASELINE_COMMIT);
  const variables = { WORKTREE: worktree };
  await runBootstrapCommands(config, variables, worktree);

  const oldConfig = materialize(config, variables);
  owned = await startOwnedServices(oldConfig, variables);
  let actors = await loginActors(oldConfig.studioBaseUrl, oldConfig.actors);
  const captureActorVariables = () => {
    for (const [name, actor] of Object.entries(actors)) {
      variables[`${name.toUpperCase()}_ACTOR_ID`] = actor.userId;
      variables[`${name.toUpperCase()}_TENANT_ID`] = actor.tenantId;
    }
  };
  captureActorVariables();
  for (const command of config.actorSetupCommands ?? []) {
    await runChecked(materialize(command, variables), {
      cwd: repositoryRoot,
      env: materialize(config.migrationEnv ?? {}, variables),
    });
  }
  if ((config.actorSetupCommands ?? []).length > 0) {
    actors = await loginActors(oldConfig.studioBaseUrl, oldConfig.actors);
    captureActorVariables();
  }
  const owner = actors[oldConfig.ownerActor];
  if (!owner) {
    throw new RunnerFailure('UNKNOWN_OWNER_ACTOR', `Unknown ownerActor: ${oldConfig.ownerActor}`);
  }
  const project = await requestJson(`${oldConfig.studioBaseUrl}/api/projects`, {
    method: 'POST',
    token: owner.accessToken,
    body: { name: `arch-actor-upgrade-${Date.now()}` },
  });
  variables.PROJECT_ID = project.project?.id ?? project.data?.id ?? project.id;
  if (typeof variables.PROJECT_ID !== 'string') {
    throw new RunnerFailure('PROJECT_ID_MISSING', 'Project creation returned no ID.');
  }
  cleanupConfig = oldConfig;
  cleanupFixture = { accessToken: owner.accessToken, projectId: variables.PROJECT_ID };
  const context = { actors, variables };
  await executeApiSteps(oldConfig.studioBaseUrl, oldConfig.oldApiSteps, context);
  const transitionProcesses = partitionTransitionProcesses(owned, config.transitionServiceNames);
  await stopOwnedProcesses(transitionProcesses.phase);
  owned = transitionProcesses.transition;

  for (const command of config.migrationCommands) {
    await runChecked(materialize(command, variables), {
      cwd: repositoryRoot,
      env: materialize(config.migrationEnv ?? {}, variables),
    });
  }

  const currentConfig = materialize(
    {
      ...config,
      services: config.currentServices,
      studioBaseUrl: config.currentStudioBaseUrl,
      runtimeBaseUrl: config.currentRuntimeBaseUrl ?? config.runtimeBaseUrl,
    },
    variables,
  );
  cleanupConfig = currentConfig;
  validateBaseConfig(currentConfig, config.configPath);
  const currentOwned = await startOwnedServices(currentConfig, variables);
  owned.push(...currentOwned);
  await executeApiSteps(currentConfig.studioBaseUrl, currentConfig.verifyApiSteps, context);
  await executeApiSteps(currentConfig.studioBaseUrl, currentConfig.revokeApiSteps, context);
  await executeApiSteps(currentConfig.studioBaseUrl, currentConfig.hiddenApiSteps, context);
  console.log(JSON.stringify({ success: true, lane: 'upgrade', projectId: variables.PROJECT_ID }));
} catch (error) {
  printRunnerFailure(error);
  process.exitCode = 1;
} finally {
  await deleteProjectFixture(cleanupConfig, cleanupFixture);
  await stopOwnedProcesses(owned);
  if (worktree && repositoryRoot) await cleanupPinnedWorktree(repositoryRoot, worktree);
}
