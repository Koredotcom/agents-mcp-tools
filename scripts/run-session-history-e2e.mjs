#!/usr/bin/env node
import {
  loadSessionHistoryConfig,
  provisionSessionHistoryFixture,
  runBuiltMcpJourney,
  runPreparationCommands,
  startSessionHistoryServices,
  stopOwnedProcesses,
} from './session-history-runner-lib.mjs';
let owned = [];
try {
  const config = await loadSessionHistoryConfig(process.argv.slice(2), 'current');
  await runPreparationCommands(config);
  owned = await startSessionHistoryServices(config);
  const fixture = await provisionSessionHistoryFixture(config);
  const codex = await runBuiltMcpJourney(config, 'codex', fixture);
  const claude = await runBuiltMcpJourney(config, 'claude', fixture);
  if (JSON.stringify(codex) !== JSON.stringify(claude))
    throw new Error('Client metadata changed protocol behavior.');
  console.log(JSON.stringify({ success: true, lane: 'current' }));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await stopOwnedProcesses(owned);
}
