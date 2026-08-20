/**
 * Session Analysis Tool
 *
 * Automated diagnostics for debugging agent sessions.
 */

import { z } from 'zod';
import type { DebugContext } from './index.js';
import type { TraceEventWithId, AgentState } from '../types.js';

// =============================================================================
// SCHEMA
// =============================================================================

export const analyzeSessionSchema = z.object({
  sessionId: z
    .string()
    .optional()
    .describe('Session ID to analyze (uses active session if not specified)'),
});

type AnalyzeSessionArgs = z.infer<typeof analyzeSessionSchema>;

// =============================================================================
// TYPES
// =============================================================================

interface Issue {
  type: 'warning' | 'error' | 'info';
  title: string;
  description: string;
  eventId?: string;
}

interface AnalysisResult {
  summary: {
    totalEvents: number;
    eventCounts: Record<string, number>;
    duration: number | null;
    llmCalls: number;
    toolCalls: number;
    errors: number;
  };
  currentState: {
    step: string | null;
    phase: string;
    collectedFields: string[];
    missingFields: string[];
  };
  issues: Issue[];
  suggestions: string[];
}

// =============================================================================
// HANDLER
// =============================================================================

export async function analyzeSession(args: AnalyzeSessionArgs, ctx: DebugContext): Promise<string> {
  const sessionId = args.sessionId || ctx.sessionStore.getActiveSessionId();

  if (!sessionId) {
    return JSON.stringify(
      {
        error:
          'No session specified and no active session. Load an agent first with debug_load_agent.',
      },
      null,
      2,
    );
  }

  const session = ctx.sessionStore.getSession(sessionId);
  if (!session) {
    return JSON.stringify(
      {
        error: `Session not found: ${sessionId}`,
      },
      null,
      2,
    );
  }

  // Get traces for this session
  const traces = ctx.traceStore.getBySession(sessionId);
  const state = session.state;

  // Perform analysis
  const analysis = analyzeTraces(traces, state);

  return JSON.stringify(
    {
      sessionId,
      agentName: session.agentDetails?.name || 'unknown',
      analysis,
    },
    null,
    2,
  );
}

// =============================================================================
// ANALYSIS LOGIC
// =============================================================================

function analyzeTraces(traces: TraceEventWithId[], state?: AgentState): AnalysisResult {
  const analysis: AnalysisResult = {
    summary: {
      totalEvents: traces.length,
      eventCounts: {},
      duration: null,
      llmCalls: 0,
      toolCalls: 0,
      errors: 0,
    },
    currentState: {
      step: null,
      phase: state?.conversationPhase || 'unknown',
      collectedFields: [],
      missingFields: [],
    },
    issues: [],
    suggestions: [],
  };

  // Count event types
  for (const trace of traces) {
    analysis.summary.eventCounts[trace.type] = (analysis.summary.eventCounts[trace.type] || 0) + 1;

    if (trace.type === 'llm_call') analysis.summary.llmCalls++;
    if (trace.type === 'tool_call') analysis.summary.toolCalls++;
    if (trace.type === 'error') analysis.summary.errors++;
  }

  // Calculate duration
  if (traces.length >= 2) {
    const first = new Date(traces[0].timestamp).getTime();
    const last = new Date(traces[traces.length - 1].timestamp).getTime();
    analysis.summary.duration = last - first;
  }

  // Find current step from flow events
  const flowSteps = traces.filter((t) => t.type === 'flow_step_enter');
  if (flowSteps.length > 0) {
    const lastStep = flowSteps[flowSteps.length - 1];
    analysis.currentState.step = (lastStep.data as { stepName?: string })?.stepName || null;
  }

  // Extract collected fields from dsl_set events
  const setEvents = traces.filter((t) => t.type === 'dsl_set');
  for (const event of setEvents) {
    const field = (event.data as { field?: string })?.field;
    if (field && !analysis.currentState.collectedFields.includes(field)) {
      analysis.currentState.collectedFields.push(field);
    }
  }

  // Find missing fields from collect events
  const collectEvents = traces.filter((t) => t.type === 'dsl_collect');
  for (const event of collectEvents) {
    const field = (event.data as { field?: string })?.field;
    const collected = (event.data as { collected?: boolean })?.collected;
    if (field && !collected && !analysis.currentState.missingFields.includes(field)) {
      analysis.currentState.missingFields.push(field);
    }
  }

  // Also check gather progress from state
  if (state?.gatherProgress) {
    for (const [field, progress] of Object.entries(state.gatherProgress)) {
      if (progress && typeof progress === 'object' && 'collected' in progress) {
        const p = progress as { collected?: boolean };
        if (p.collected && !analysis.currentState.collectedFields.includes(field)) {
          analysis.currentState.collectedFields.push(field);
        } else if (!p.collected && !analysis.currentState.missingFields.includes(field)) {
          analysis.currentState.missingFields.push(field);
        }
      }
    }
  }

  // Detect issues

  // Issue: Repeated step entry (potential loop)
  const stepCounts: Record<string, number> = {};
  for (const step of flowSteps) {
    const stepName = (step.data as { stepName?: string })?.stepName || 'unknown';
    stepCounts[stepName] = (stepCounts[stepName] || 0) + 1;
  }
  for (const [step, count] of Object.entries(stepCounts)) {
    if (count > 3) {
      analysis.issues.push({
        type: 'warning',
        title: 'Potential loop detected',
        description: `Step "${step}" was entered ${count} times. This may indicate a loop condition.`,
      });
      analysis.suggestions.push(
        `Check transition conditions for step "${step}". Ensure required fields are being collected and stored in context.`,
      );
    }
  }

  // Issue: Errors present
  const errorEvents = traces.filter((t) => t.type === 'error');
  for (const error of errorEvents) {
    const errorMsg = (error.data as { message?: string })?.message || 'Unknown error';
    analysis.issues.push({
      type: 'error',
      title: 'Error occurred',
      description: errorMsg,
      eventId: error.id,
    });
  }

  // Issue: Constraint violations
  const constraintFailures = traces.filter(
    (t) => t.type === 'constraint_check' && !(t.data as { passed?: boolean })?.passed,
  );
  for (const failure of constraintFailures) {
    const constraint = (failure.data as { constraint?: string })?.constraint || 'unknown';
    analysis.issues.push({
      type: 'warning',
      title: 'Constraint violation',
      description: `Constraint "${constraint}" was violated.`,
      eventId: failure.id,
    });
    analysis.suggestions.push(
      `Review the "${constraint}" constraint condition and verify context values meet requirements.`,
    );
  }

  // Issue: Tool failures
  const toolFailures = traces.filter(
    (t) => t.type === 'tool_call' && (t.data as { success?: boolean })?.success === false,
  );
  for (const failure of toolFailures) {
    const toolName = (failure.data as { tool?: string })?.tool || 'unknown';
    const errorMsg = (failure.data as { error?: string })?.error || 'Unknown error';
    analysis.issues.push({
      type: 'error',
      title: 'Tool call failed',
      description: `Tool "${toolName}" failed: ${errorMsg}`,
      eventId: failure.id,
    });
    analysis.suggestions.push(
      `Check the "${toolName}" tool implementation and verify input parameters are correct.`,
    );
  }

  // Issue: Missing required fields
  if (analysis.currentState.missingFields.length > 0) {
    analysis.issues.push({
      type: 'info',
      title: 'Missing required fields',
      description: `The following fields are not yet collected: ${analysis.currentState.missingFields.join(', ')}`,
    });
    analysis.suggestions.push(
      'The agent is waiting for the user to provide the missing information.',
    );
  }

  // Issue: Many LLM calls (potential inefficiency)
  if (analysis.summary.llmCalls > 10) {
    analysis.issues.push({
      type: 'info',
      title: 'High LLM call count',
      description: `${analysis.summary.llmCalls} LLM calls made. Consider optimizing prompts or adding caching.`,
    });
  }

  // Issue: Escalation without resolution
  const escalations = traces.filter((t) => t.type === 'escalation');
  if (escalations.length > 1) {
    analysis.issues.push({
      type: 'warning',
      title: 'Multiple escalations',
      description: `${escalations.length} escalations occurred. Ensure agents can handle the request.`,
    });
    analysis.suggestions.push(
      'Review escalation conditions and ensure at least one agent can resolve the request.',
    );
  }

  // Issue: Long-running session
  if (analysis.summary.duration && analysis.summary.duration > 60000) {
    analysis.issues.push({
      type: 'info',
      title: 'Long-running session',
      description: `Session has been active for ${Math.round(analysis.summary.duration / 1000)}s.`,
    });
  }

  // Issue: No LLM calls (agent might be stuck)
  if (traces.length > 5 && analysis.summary.llmCalls === 0) {
    analysis.issues.push({
      type: 'warning',
      title: 'No LLM calls detected',
      description:
        'The agent has not made any LLM calls. It may be stuck in initialization or a non-LLM flow.',
    });
  }

  return analysis;
}
