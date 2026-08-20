/**
 * debug_explain_decision Tool
 *
 * Get explanation of a decision with surrounding context.
 * Prefers richer decisionLog data when available, falls back to trace events.
 */

import { z } from 'zod';
import type { DebugContext } from './index.js';
import type { TraceEventWithId, DecisionLogEntry } from '../types.js';

export const explainDecisionSchema = z.object({
  eventId: z.string().optional().describe('Specific event ID to explain'),
  sessionId: z.string().optional().describe('Session ID (uses active session if not specified)'),
  lastN: z.number().optional().default(5).describe('Number of recent decision entries to return'),
  turn: z.number().optional().describe('Get all decisions for a specific conversation turn'),
  type: z
    .string()
    .optional()
    .describe('Filter by decision type (handoff, completion, gather_extraction, etc.)'),
});

export type ExplainDecisionArgs = z.infer<typeof explainDecisionSchema>;

export async function explainDecision(
  args: ExplainDecisionArgs,
  ctx: DebugContext,
): Promise<string> {
  const { eventId, lastN = 5 } = args;

  // Use active session if not specified
  const sessionId = args.sessionId || ctx.sessionStore.getActiveSessionId();

  if (!sessionId && !eventId) {
    return JSON.stringify({
      success: false,
      error:
        'No session specified and no active session. Load an agent first, or provide an eventId.',
    });
  }

  // If specific event ID provided, get that event (always use trace path)
  if (eventId) {
    const event = ctx.traceStore.getById(eventId);
    if (!event) {
      return JSON.stringify({
        success: false,
        error: `Event not found: ${eventId}`,
      });
    }
    return JSON.stringify({
      success: true,
      explanation: explainEvent(event, ctx),
    });
  }

  // Check for decision log (richer data from runtime)
  const decisionLog = sessionId ? ctx.sessionStore.getDecisionLog(sessionId) : [];

  if (decisionLog.length > 0) {
    return explainFromDecisionLog(decisionLog, args, sessionId!);
  }

  // Fall back to trace events
  return explainFromTraceEvents(ctx, sessionId!, lastN);
}

// =============================================================================
// DECISION LOG PATH (preferred when available)
// =============================================================================

function explainFromDecisionLog(
  decisionLog: DecisionLogEntry[],
  args: ExplainDecisionArgs,
  sessionId: string,
): string {
  const { lastN = 5, turn, type } = args;

  // Filter by turn
  if (turn !== undefined) {
    const turnEntries = decisionLog.filter((e) => e.turn === turn);
    if (turnEntries.length === 0) {
      return JSON.stringify({
        success: true,
        sessionId,
        turn,
        entries: [],
        message: `No decisions found for turn ${turn}.`,
      });
    }
    return JSON.stringify({
      success: true,
      sessionId,
      turn,
      count: turnEntries.length,
      entries: turnEntries.map(formatDecisionEntry),
      causalChain: buildCausalChain(turnEntries),
    });
  }

  // Filter by type
  if (type) {
    const typeEntries = decisionLog.filter((e) => e.type === type);
    return JSON.stringify({
      success: true,
      sessionId,
      type,
      count: typeEntries.length,
      entries: typeEntries.slice(-lastN).map(formatDecisionEntry),
    });
  }

  // Default: return last N entries grouped by turn
  const recentEntries = decisionLog.slice(-lastN);
  const grouped = groupByTurn(recentEntries);

  return JSON.stringify({
    success: true,
    sessionId,
    count: recentEntries.length,
    totalDecisions: decisionLog.length,
    byTurn: grouped,
  });
}

/**
 * Format a single decision log entry, picking relevant fields
 */
function formatDecisionEntry(entry: DecisionLogEntry): Record<string, unknown> {
  const result: Record<string, unknown> = {
    turn: entry.turn,
    timestamp: entry.timestamp,
    type: entry.type,
    outcome: entry.outcome,
    matched: entry.matched,
  };

  if (entry.condition !== undefined) result.condition = entry.condition;
  if (entry.trigger !== undefined) result.trigger = entry.trigger;
  if (entry.candidates !== undefined) result.candidates = entry.candidates;
  if (entry.selectedReason !== undefined) result.selectedReason = entry.selectedReason;
  if (entry.field !== undefined) result.field = entry.field;
  if (entry.violation !== undefined) result.violation = entry.violation;
  if (entry.oldValue !== undefined) result.oldValue = entry.oldValue;
  if (entry.newValue !== undefined) result.newValue = entry.newValue;
  if (entry.source !== undefined) result.source = entry.source;

  return result;
}

/**
 * Group decision entries by turn number
 */
function groupByTurn(entries: DecisionLogEntry[]): Record<number, Record<string, unknown>[]> {
  const groups: Record<number, Record<string, unknown>[]> = {};
  for (const entry of entries) {
    if (!groups[entry.turn]) {
      groups[entry.turn] = [];
    }
    groups[entry.turn].push(formatDecisionEntry(entry));
  }
  return groups;
}

/**
 * Build a human-readable causal chain from entries in a turn
 */
function buildCausalChain(entries: DecisionLogEntry[]): string[] {
  const sorted = [...entries].sort((a, b) => a.timestamp - b.timestamp);
  return sorted.map((entry, i) => {
    const prefix = i === 0 ? 'START' : `STEP ${i}`;
    const matchStr = entry.matched ? 'MATCHED' : 'NOT MATCHED';
    return `${prefix}: [${entry.type}] ${entry.outcome} (${matchStr})`;
  });
}

// =============================================================================
// TRACE EVENT PATH (fallback)
// =============================================================================

function explainFromTraceEvents(ctx: DebugContext, sessionId: string, lastN: number): string {
  const decisionTypes = [
    'decision',
    'constraint_check',
    'flow_transition',
    'handoff',
    'escalation',
    'delegate_start',
  ];
  const events = ctx.traceStore.getBySession(sessionId, undefined, decisionTypes as any);

  if (events.length === 0) {
    return JSON.stringify({
      success: true,
      sessionId,
      explanations: [],
      message: 'No decision events found. Send messages to the agent to generate decisions.',
    });
  }

  // Get the most recent N decisions
  const recentDecisions = events.slice(0, lastN);
  const explanations = recentDecisions.map((event) => explainEvent(event, ctx));

  return JSON.stringify({
    success: true,
    sessionId,
    count: explanations.length,
    explanations,
  });
}

// =============================================================================
// TRACE EVENT EXPLANATION HELPERS
// =============================================================================

/**
 * Generate explanation for a single event
 */
function explainEvent(event: TraceEventWithId, ctx: DebugContext): Record<string, unknown> {
  const base = {
    eventId: event.id,
    eventType: event.type,
    timestamp: event.timestamp,
    agentName: event.agentName,
  };

  switch (event.type) {
    case 'decision':
      return {
        ...base,
        summary: `Decision made: ${event.data.decision || 'unknown'}`,
        decision: event.data.decision,
        reason: event.data.reason,
        options: event.data.options,
        selectedOption: event.data.selectedOption,
        confidence: event.data.confidence,
        context: getContextForEvent(event, ctx),
      };

    case 'constraint_check': {
      const passed = event.data.passed ?? event.data.result;
      return {
        ...base,
        summary: `Constraint "${event.data.constraint || event.data.condition}" ${passed ? 'passed' : 'FAILED'}`,
        constraint: event.data.constraint || event.data.condition,
        passed,
        expression: event.data.expression,
        actualValue: event.data.actualValue,
        expectedValue: event.data.expectedValue,
        message: event.data.message,
        context: getContextForEvent(event, ctx),
      };
    }

    case 'flow_transition':
      return {
        ...base,
        summary: `Flow transition: ${event.data.from || 'start'} -> ${event.data.to}`,
        fromStep: event.data.from,
        toStep: event.data.to,
        trigger: event.data.trigger,
        condition: event.data.condition,
        context: getContextForEvent(event, ctx),
      };

    case 'handoff': {
      const handoffTarget = event.data.to || event.data.target;
      return {
        ...base,
        summary: `Handoff to: ${handoffTarget}`,
        target: handoffTarget,
        reason: event.data.reason,
        returnExpected: event.data.returnExpected,
        context: event.data.context,
        precedingEvents: getContextForEvent(event, ctx),
      };
    }

    case 'escalation':
      return {
        ...base,
        summary: `Escalation (${event.data.priority}): ${event.data.reason}`,
        reason: event.data.reason,
        priority: event.data.priority,
        context: event.data.context,
        precedingEvents: getContextForEvent(event, ctx),
      };

    case 'delegate_start':
      return {
        ...base,
        summary: `Delegating to agent: ${event.data.agent}`,
        targetAgent: event.data.agent,
        input: event.data.input,
        useResult: event.data.useResult,
        context: getContextForEvent(event, ctx),
      };

    default:
      return {
        ...base,
        summary: `Event: ${event.type}`,
        data: event.data,
        context: getContextForEvent(event, ctx),
      };
  }
}

/**
 * Get preceding events for context
 */
function getContextForEvent(event: TraceEventWithId, ctx: DebugContext): unknown[] {
  // Get events from the same span or parent span
  const spanEvents = event.spanId ? ctx.traceStore.getBySpan(event.spanId) : [];

  // Filter to events before this one
  const eventTime = new Date(event.timestamp).getTime();
  const precedingEvents = spanEvents
    .filter((e) => new Date(e.timestamp).getTime() < eventTime)
    .slice(-5) // Last 5 preceding events
    .map((e) => ({
      type: e.type,
      timestamp: e.timestamp,
      summary: getEventSummary(e),
    }));

  return precedingEvents;
}

/**
 * Get a brief summary of an event
 */
function getEventSummary(event: TraceEventWithId): string {
  switch (event.type) {
    case 'llm_call':
      return `LLM call (${event.data.model || 'unknown'})`;
    case 'tool_call':
      return `Tool: ${event.data.tool || event.data.toolName}`;
    case 'agent_enter':
      return `Entered agent: ${event.agentName || event.data.agentName}`;
    case 'flow_step_enter':
      return `Entered step: ${event.data.step || event.data.stepName}`;
    case 'dsl_collect':
      return `Collecting: ${(event.data.fields as string[])?.join(', ') || 'fields'}`;
    case 'dsl_prompt':
      return `Prompt: ${(event.data.prompt as string)?.substring(0, 50) || 'sent'}...`;
    case 'dsl_respond':
      return `Response: ${(event.data.message as string)?.substring(0, 50) || 'sent'}...`;
    default:
      return event.type;
  }
}
