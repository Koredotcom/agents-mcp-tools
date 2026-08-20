#!/usr/bin/env node
/**
 * Arch MCP Server CLI
 *
 * Usage: mcp-debug [options]
 *
 * Options:
 *   --server-url <url>   Runtime server URL (or set AGENTS_URL env var)
 *   --studio-url <url>   Studio URL when it is not co-hosted with Runtime
 *   --ws-url <url>       (Deprecated) WebSocket URL
 *   --http-url <url>     (Deprecated) HTTP API URL
 *   --help               Show help
 */

import { MCPDebugServer } from '../src/server.js';
import { tools } from '../src/tools/index.js';
import {
  ARCH_CAPABILITY_ORDER,
  ARCH_MCP_DESCRIPTION,
  ARCH_MCP_SERVER_NAME,
  formatArchToolSummary,
  getArchCapabilityForTool,
} from '../src/tools/persona.js';

function parseArgs(args: string[]): {
  serverUrl?: string;
  studioUrl?: string;
  wsUrl?: string;
  httpUrl?: string;
  help?: boolean;
} {
  const result: {
    serverUrl?: string;
    studioUrl?: string;
    wsUrl?: string;
    httpUrl?: string;
    help?: boolean;
  } = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--help' || arg === '-h') {
      result.help = true;
    } else if (arg === '--server-url' && args[i + 1]) {
      result.serverUrl = args[++i];
    } else if (arg === '--studio-url' && args[i + 1]) {
      result.studioUrl = args[++i];
    } else if (arg === '--ws-url' && args[i + 1]) {
      result.wsUrl = args[++i];
    } else if (arg === '--http-url' && args[i + 1]) {
      result.httpUrl = args[++i];
    }
  }

  return result;
}

function showHelp(): void {
  const toolNameWidth = Math.max(...tools.map((tool) => tool.name.length));
  const groupedTools = ARCH_CAPABILITY_ORDER.map((capability) => {
    const capabilityTools = tools.filter(
      (tool) => getArchCapabilityForTool(tool.name) === capability,
    );
    const lines = capabilityTools.map(
      (tool) => `  ${tool.name.padEnd(toolNameWidth)}  ${formatArchToolSummary(tool)}`,
    );
    return `  Arch ${capability}:\n${lines.join('\n')}`;
  }).join('\n\n');

  console.log(`
Arch - MCP Tools for Agent Platform

${ARCH_MCP_DESCRIPTION}

Usage: arch-mcp-tools [options]

Options:
  --server-url <url>   Runtime server URL (or set AGENTS_URL env var)
  --studio-url <url>   Explicit Studio origin for split-port deployments
  --help, -h           Show this help message

Environment Variables:
  AGENTS_URL           Default server URL when --server-url is not passed to platform_connect.
                       If unset, the tools ask which environment to connect to on first use.
                       Examples: https://agents.kore.ai        (production)
                                 https://agents-dev.kore.ai     (dev)
                                 https://agents-staging.kore.ai (staging)
                                 https://agents-qa.kore.ai       (qa)

Available MCP Tools (${tools.length}):

${groupedTools}

Claude Code Configuration:
  Add to your project's .mcp.json or ~/.claude/settings.json:
  {
    "mcpServers": {
      "${ARCH_MCP_SERVER_NAME}": {
        "command": "npx",
        "args": ["@koreai/arch-mcp-tools"]
      }
    }
  }
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    showHelp();
    process.exit(0);
  }

  const server = new MCPDebugServer({
    serverUrl: args.serverUrl,
    studioUrl: args.studioUrl,
    wsUrl: args.wsUrl,
    httpUrl: args.httpUrl,
  });

  // Handle shutdown
  process.on('SIGINT', async () => {
    await server.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await server.stop();
    process.exit(0);
  });

  // Start the server
  await server.start();
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
