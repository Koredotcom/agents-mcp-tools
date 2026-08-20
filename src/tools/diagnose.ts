/**
 * debug_diagnose Tool
 *
 * Run full diagnostic analysis on an agent or session via the runtime diagnostics API.
 * Formats the DiagnosticReport as human-readable text for Claude.
 */

import { z } from 'zod';
import type { DebugContext } from './index.js';

// =============================================================================
// SCHEMA
// =============================================================================

export const diagnoseSchema = z.object({
  sessionId: z.string().optional().describe('Diagnose a specific session'),
  agentName: z.string().optional().describe("Diagnose an agent's config"),
  projectId: z
    .string()
    .optional()
    .describe('Project ID (required for API calls, defaults to "default")'),
  depth: z
    .enum(['quick', 'standard', 'deep'])
    .optional()
    .describe('Diagnostic depth (default: standard)'),
  configOnly: z
    .boolean()
    .optional()
    .describe(
      'When true, return only the config section (model chain, credentials, tools) — equivalent to the old debug_inspect behavior',
    ),
});

type DiagnoseArgs = z.infer<typeof diagnoseSchema>;

// =============================================================================
// TYPES (mirrors runtime DiagnosticReport shape)
// =============================================================================

interface DiagnosticFinding {
  analyzer: string;
  severity: 'error' | 'warning' | 'info';
  code: string;
  title: string;
  detail: string;
  suggestion: string;
}

interface DiagnosticReport {
  status: 'healthy' | 'degraded' | 'broken';
  target: {
    type: 'agent' | 'session' | 'execution';
    id: string;
    agentName: string;
  };
  findings: DiagnosticFinding[];
  summary: {
    errors: number;
    warnings: number;
    infos: number;
    analyzersRun: string[];
  };
  config: {
    model?: {
      chain: Array<{
        level: number;
        name: string;
        checked: boolean;
        matched: boolean;
        value?: string;
        reason: string;
      }>;
      resolved?: { modelId: string; provider: string; source: string };
    };
    credentials?: {
      provider: string;
      available: boolean;
      scope?: string;
      isActive?: boolean;
    };
    tools?: {
      total: number;
      bound: number;
      failed: string[];
    };
  };
  timestamp: string;
}

interface ApiResponse {
  success: boolean;
  data: DiagnosticReport;
}

// =============================================================================
// SEVERITY ICONS
// =============================================================================

const SEVERITY_ICON: Record<string, string> = {
  error: '[ERROR]',
  warning: '[WARN]',
  info: '[INFO]',
};

const STATUS_ICON: Record<string, string> = {
  healthy: '[OK]',
  degraded: '[DEGRADED]',
  broken: '[BROKEN]',
};

// =============================================================================
// HANDLER
// =============================================================================

export async function diagnose(args: DiagnoseArgs, ctx: DebugContext): Promise<string> {
  const { sessionId, agentName, depth = 'standard', configOnly = false } = args;
  const projectId = args.projectId;
  if (!projectId) {
    return JSON.stringify({
      success: false,
      error: 'projectId is required. Provide the project ID to run diagnostics.',
    });
  }

  if (!sessionId && !agentName) {
    return JSON.stringify({
      success: false,
      error: 'Either sessionId or agentName is required. Provide one to run diagnostics.',
    });
  }

  try {
    let report: DiagnosticReport;

    if (sessionId) {
      const resp = await ctx.httpClient.get<ApiResponse>(
        `/api/projects/${projectId}/diagnostics/sessions/${sessionId}?depth=${depth}`,
      );
      report = resp.data;
    } else {
      const resp = await ctx.httpClient.get<ApiResponse>(
        `/api/projects/${projectId}/diagnostics/agents/${agentName}`,
      );
      report = resp.data;
    }

    if (configOnly) {
      return formatConfigOnlyReport(report);
    }

    return formatDiagnosticReport(report);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return JSON.stringify({
      success: false,
      error: `Diagnostic request failed: ${message}`,
      hint: 'Ensure the runtime is running and you are connected (platform_connect).',
    });
  }
}

// =============================================================================
// FORMATTING
// =============================================================================

function formatDiagnosticReport(report: DiagnosticReport): string {
  const lines: string[] = [];

  // Status line
  const statusIcon = STATUS_ICON[report.status] || report.status;
  lines.push(
    `DIAGNOSIS: ${report.target.agentName} (${report.target.type}:${report.target.id}) -- ${statusIcon} ${report.status.toUpperCase()}`,
  );
  lines.push(
    `Timestamp: ${report.timestamp} | Analyzers: ${report.summary.analyzersRun.join(', ')}`,
  );
  lines.push(
    `Totals: ${report.summary.errors} errors, ${report.summary.warnings} warnings, ${report.summary.infos} info`,
  );
  lines.push('');

  // Findings grouped by severity
  const grouped: Record<string, DiagnosticFinding[]> = {
    error: [],
    warning: [],
    info: [],
  };
  for (const f of report.findings) {
    (grouped[f.severity] || grouped.info).push(f);
  }

  const severityOrder: Array<'error' | 'warning' | 'info'> = ['error', 'warning', 'info'];
  for (const sev of severityOrder) {
    const findings = grouped[sev];
    if (findings.length === 0) continue;

    lines.push(`--- ${sev.toUpperCase()}S (${findings.length}) ---`);
    for (const f of findings) {
      lines.push(`${SEVERITY_ICON[f.severity]} ${f.title} [${f.code}]`);
      lines.push(`  Detail: ${f.detail}`);
      lines.push(`  Suggestion: ${f.suggestion}`);
      lines.push(`  Analyzer: ${f.analyzer}`);
      lines.push('');
    }
  }

  // Config summary
  if (report.config) {
    lines.push('--- CONFIG SUMMARY ---');
    formatConfigSection(report.config, lines);
  }

  return lines.join('\n');
}

function formatConfigOnlyReport(report: DiagnosticReport): string {
  const lines: string[] = [];

  lines.push(`INSPECT: ${report.target.agentName} -- ${report.status.toUpperCase()}`);
  lines.push('');

  const { config } = report;

  // Model resolution chain
  if (config.model) {
    lines.push('=== Model Resolution Chain ===');
    if (config.model.chain) {
      for (const step of config.model.chain) {
        const icon = step.matched ? '[v]' : step.checked ? '[x]' : '[ ]';
        const value = step.value ? ` = ${step.value}` : '';
        lines.push(`  ${icon} L${step.level} ${step.name}${value}`);
        lines.push(`       ${step.reason}`);
      }
    }
    if (config.model.resolved) {
      const r = config.model.resolved;
      lines.push('');
      lines.push(`  Resolved Model: ${r.modelId}`);
      lines.push(`  Provider: ${r.provider}`);
      lines.push(`  Source: ${r.source}`);
    } else {
      lines.push('');
      lines.push('  Resolved Model: NONE -- model resolution failed');
    }
    lines.push('');
  }

  // Credential status
  if (config.credentials) {
    lines.push('=== Credential Status ===');
    const c = config.credentials;
    const status = c.available ? 'AVAILABLE' : 'MISSING';
    lines.push(`  Provider: ${c.provider}`);
    lines.push(`  Status: ${status}`);
    if (c.scope) lines.push(`  Scope: ${c.scope}`);
    if (c.isActive !== undefined) lines.push(`  Active: ${c.isActive ? 'yes' : 'no'}`);
    lines.push('');
  }

  // Tool binding status
  if (config.tools) {
    lines.push('=== Tool Binding ===');
    const t = config.tools;
    lines.push(`  Total: ${t.total}`);
    lines.push(`  Bound: ${t.bound}`);
    if (t.failed.length > 0) {
      lines.push(`  Failed (${t.failed.length}):`);
      for (const name of t.failed) {
        lines.push(`    - ${name}`);
      }
    } else {
      lines.push('  Failed: none');
    }
    lines.push('');
  }

  if (!config.model && !config.credentials && !config.tools) {
    lines.push('No configuration data returned by the diagnostic engine.');
  }

  return lines.join('\n');
}

function formatConfigSection(config: DiagnosticReport['config'], lines: string[]): void {
  // Model resolution chain
  if (config.model) {
    lines.push('Model Resolution:');
    if (config.model.chain) {
      for (const step of config.model.chain) {
        const icon = step.matched ? '[v]' : step.checked ? '[x]' : '[ ]';
        const value = step.value ? ` = ${step.value}` : '';
        lines.push(`  ${icon} L${step.level} ${step.name}${value} (${step.reason})`);
      }
    }
    if (config.model.resolved) {
      const r = config.model.resolved;
      lines.push(`  Resolved: ${r.modelId} via ${r.provider} (${r.source})`);
    }
    lines.push('');
  }

  // Credentials
  if (config.credentials) {
    const c = config.credentials;
    const status = c.available ? 'available' : 'MISSING';
    const active = c.isActive !== undefined ? (c.isActive ? ', active' : ', inactive') : '';
    const scope = c.scope ? ` (${c.scope})` : '';
    lines.push(`Credentials: ${c.provider} -- ${status}${active}${scope}`);
    lines.push('');
  }

  // Tools
  if (config.tools) {
    const t = config.tools;
    lines.push(`Tools: ${t.bound}/${t.total} bound`);
    if (t.failed.length > 0) {
      lines.push(`  Failed: ${t.failed.join(', ')}`);
    }
    lines.push('');
  }
}
