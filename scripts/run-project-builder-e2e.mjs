#!/usr/bin/env node
import {
  deleteProjectFixture,
  devLoginAndCreateProject,
  loadRunnerConfig,
  printRunnerFailure,
  runMcpProtocolLane,
  startOwnedServices,
  stopOwnedProcesses,
} from './project-builder-runner-lib.mjs';

let owned = [];
let config;
let fixture;
try {
  config = await loadRunnerConfig(process.argv.slice(2), 'current');
  owned = await startOwnedServices(config);
  fixture = await devLoginAndCreateProject(config);
  await runMcpProtocolLane(config, fixture, 'current');
  console.log(JSON.stringify({ success: true, lane: 'current', projectId: fixture.projectId }));
} catch (error) {
  printRunnerFailure(error);
  process.exitCode = 1;
} finally {
  await deleteProjectFixture(config, fixture);
  await stopOwnedProcesses(owned);
}
