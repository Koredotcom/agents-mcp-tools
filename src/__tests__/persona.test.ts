import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ArchMCPServer, MCPDebugServer } from '../index.js';
import { tools } from '../tools/index.js';
import {
  ARCH_CAPABILITY_ORDER,
  ARCH_MCP_DESCRIPTION,
  ARCH_MCP_ROUTE_KEY_PREFIX,
  ARCH_MCP_SERVER_NAME,
  ARCH_MCP_SERVER_VERSION,
  formatArchToolDescription,
  getArchCapabilityForTool,
  hasArchCapabilityForTool,
} from '../tools/persona.js';

describe('Arch MCP persona', () => {
  it('uses Arch server identity and describes the full capability set', () => {
    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version: string };

    expect(ARCH_MCP_SERVER_NAME).toBe('arch-agent-platform');
    expect(ARCH_MCP_SERVER_VERSION).toBe(packageJson.version);
    expect(ARCH_MCP_ROUTE_KEY_PREFIX).toBe('arch-mcp');
    for (const capability of ARCH_CAPABILITY_ORDER) {
      expect(ARCH_MCP_DESCRIPTION).toContain(capability);
    }
  });

  it('exports ArchMCPServer as a compatibility-safe alias', () => {
    expect(ArchMCPServer).toBe(MCPDebugServer);
  });

  it('assigns every MCP tool to an explicit Arch capability', () => {
    const capabilities = new Set(tools.map((tool) => getArchCapabilityForTool(tool.name)));

    expect([...capabilities].sort()).toEqual([...ARCH_CAPABILITY_ORDER].sort());
    for (const tool of tools) {
      expect(hasArchCapabilityForTool(tool.name)).toBe(true);
    }
  });

  it('presents historical session analysis as an explicit Debug capability', () => {
    expect(getArchCapabilityForTool('debug_session_history')).toBe('Debug');
    expect(hasArchCapabilityForTool('debug_session_history')).toBe(true);
  });

  it('personifies every exposed tool description as Arch', () => {
    for (const tool of tools) {
      const capability = getArchCapabilityForTool(tool.name);
      const description = formatArchToolDescription(tool);

      expect(description).toContain(`[Arch ${capability}]`);
      expect(description).toContain('Arch ');
      expect(description).toContain(tool.description);
    }
  });

  it('keeps README guidance aligned with dynamic Arch metadata', () => {
    const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');

    expect(readme).toContain('## Tools');
    expect(readme).toContain('## `1.5.0` release');
    expect(readme).toContain('knowledge protocol remains schema version `1`');
    expect(readme).not.toMatch(/## Tools \(\d+\)/);
    expect(readme).toContain('Arch Build');
    expect(readme).toContain('Arch Evaluate');
    expect(readme).toContain('Arch Optimize');
    expect(readme).toContain('Arch Debug');
    expect(readme).toContain('Arch Analyze');
    expect(readme).toContain('polls until approval completes in the same `platform_connect` call');
    expect(readme).not.toContain(
      ['then call', '`platform_connect` again', 'with the `deviceCode`'].join(' '),
    );
  });
});
