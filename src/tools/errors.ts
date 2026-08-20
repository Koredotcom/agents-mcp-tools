/**
 * debug_get_errors Tool
 *
 * Get all errors and warnings from the session.
 */

import { z } from 'zod';
import type { DebugContext } from './index.js';

export const getErrorsSchema = z.object({
  sessionId: z.string().optional().describe('Session ID (uses active session if not specified)'),
  includeWarnings: z.boolean().optional().default(true).describe('Include warning-level events'),
});

export type GetErrorsArgs = z.infer<typeof getErrorsSchema>;

export async function getErrors(args: GetErrorsArgs, ctx: DebugContext): Promise<string> {
  // Use active session if not specified
  const sessionId = args.sessionId || ctx.sessionStore.getActiveSessionId();

  // Get errors from trace store
  const events = ctx.traceStore.getErrors(sessionId || undefined);

  // Categorize events
  const errors: unknown[] = [];
  const warnings: unknown[] = [];
  const escalations: unknown[] = [];

  for (const event of events) {
    const formatted = {
      id: event.id,
      type: event.type,
      timestamp: event.timestamp,
      agentName: event.agentName,
      message: event.data.message || event.data.errorMessage || event.data.reason,
      errorType: event.data.errorType,
      stack: event.data.stack,
      context: event.data.context,
    };

    if (event.type === 'error') {
      errors.push(formatted);
    } else if (event.type === 'escalation') {
      escalations.push({
        ...formatted,
        priority: event.data.priority,
        reason: event.data.reason,
      });
    } else if (event.data.warning) {
      if (args.includeWarnings) {
        warnings.push(formatted);
      }
    } else {
      // Other error-like events
      errors.push(formatted);
    }
  }

  return JSON.stringify({
    success: true,
    sessionId: sessionId || 'all',
    summary: {
      totalIssues: errors.length + warnings.length + escalations.length,
      errorCount: errors.length,
      warningCount: warnings.length,
      escalationCount: escalations.length,
    },
    errors,
    warnings: args.includeWarnings ? warnings : undefined,
    escalations,
  });
}
