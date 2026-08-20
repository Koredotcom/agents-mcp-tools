/**
 * Trace Tools
 *
 * debug_traces - Get and search trace events with optional filters
 */

import { z } from 'zod';
import type { DebugContext } from './index.js';
import type { TraceEventType } from '../types.js';

// =============================================================================
// debug_traces — unified get + search
// =============================================================================

export const tracesSchema = z.object({
  text: z.string().optional().describe('Text to search for in event data'),
  // Accept any string to be forward-compatible with new runtime event types
  types: z.array(z.string()).optional().describe('Filter by event types'),
  agentName: z.string().optional().describe('Filter by agent name'),
  hasError: z.boolean().optional().describe('Filter for error events only'),
  sessionId: z.string().optional().describe('Filter by or search within a specific session'),
  limit: z
    .number()
    .optional()
    .default(50)
    .describe('Maximum number of events to return (default: 50)'),
});

export type TracesArgs = z.infer<typeof tracesSchema>;

export async function traces(args: TracesArgs, ctx: DebugContext): Promise<string> {
  try {
    const { text, types, agentName, hasError, sessionId, limit = 50 } = args;

    // Use active session if not specified
    const effectiveSessionId = sessionId || ctx.sessionStore.getActiveSessionId();

    const hasSearchFilters =
      text !== undefined || agentName !== undefined || hasError !== undefined;

    if (hasSearchFilters) {
      // Search mode — use traceStore.search
      const events = ctx.traceStore.search(
        {
          text,
          types: types as TraceEventType[] | undefined,
          agentName,
          hasError,
        },
        effectiveSessionId || undefined,
      );

      const limitedEvents = events.slice(0, limit);

      const formattedEvents = limitedEvents.map((e) => ({
        id: e.id,
        type: e.type,
        timestamp: e.timestamp,
        agentName: e.agentName,
        durationMs: e.durationMs,
        spanId: e.spanId,
        data: summarizeData(e.data),
      }));

      return JSON.stringify({
        success: true,
        count: formattedEvents.length,
        totalMatches: events.length,
        sessionId: effectiveSessionId,
        filters: { text, types, agentName, hasError },
        events: formattedEvents,
      });
    }

    // Simple get mode — fetch recent traces
    let events;
    if (effectiveSessionId) {
      events = ctx.traceStore.getBySession(
        effectiveSessionId,
        limit,
        types as TraceEventType[] | undefined,
      );
    } else {
      events = ctx.traceStore.getRecent(limit, types as TraceEventType[] | undefined);
    }

    const formattedEvents = events.map((e) => ({
      id: e.id,
      type: e.type,
      timestamp: e.timestamp,
      agentName: e.agentName,
      durationMs: e.durationMs,
      spanId: e.spanId,
      data: summarizeData(e.data),
    }));

    return JSON.stringify({
      success: true,
      count: formattedEvents.length,
      sessionId: effectiveSessionId,
      events: formattedEvents,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return JSON.stringify({
      success: false,
      error: `debug_traces failed: ${message}`,
    });
  }
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Summarize event data, truncating long strings
 */
function summarizeData(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'string' && value.length > 200) {
      result[key] = value.substring(0, 200) + '...';
    } else if (Array.isArray(value) && value.length > 10) {
      result[key] = [...value.slice(0, 10), `... (${value.length} total)`];
    } else if (typeof value === 'object' && value !== null) {
      const str = JSON.stringify(value);
      if (str.length > 200) {
        // Don't try to parse truncated JSON - just indicate it was truncated
        result[key] = { _truncated: true, _preview: str.substring(0, 200) + '...' };
      } else {
        result[key] = value;
      }
    } else {
      result[key] = value;
    }
  }

  return result;
}
