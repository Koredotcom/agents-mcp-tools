/**
 * debug_get_flow_graph Tool
 *
 * Get state machine graph for all agent types (scripted, reasoning, supervisors).
 * Uses app-graph-extractor patterns for comprehensive visualization.
 */

import { z } from 'zod';
import type { DebugContext } from './index.js';

export const getFlowGraphSchema = z.object({
  sessionId: z.string().optional().describe('Session ID (uses active session if not specified)'),
  format: z.enum(['json', 'mermaid']).optional().default('json').describe('Output format'),
  includeAppGraph: z
    .boolean()
    .optional()
    .default(false)
    .describe('Include full app/domain graph with all agents'),
});

export type GetFlowGraphArgs = z.infer<typeof getFlowGraphSchema>;

/**
 * Graph node types
 */
interface GraphNode {
  id: string;
  type: 'entry' | 'exit' | 'step' | 'llm_decision' | 'tool' | 'handoff' | 'constraint';
  label: string;
  deterministic: boolean;
  metadata?: Record<string, unknown>;
}

interface GraphEdge {
  id: string;
  from: string;
  to: string;
  type: 'sequential' | 'conditional' | 'handoff' | 'error' | 'return';
  label?: string;
  condition?: string;
}

interface AgentGraph {
  agentName: string;
  agentType: 'agent' | 'supervisor';
  mode: 'scripted' | 'reasoning';
  nodes: GraphNode[];
  edges: GraphEdge[];
  entryPoint: string;
}

interface AppGraph {
  domain: string;
  agents: AgentGraph[];
  interAgentEdges: GraphEdge[];
}

export async function getFlowGraph(args: GetFlowGraphArgs, ctx: DebugContext): Promise<string> {
  const sessionId = args.sessionId || ctx.sessionStore.getActiveSessionId();

  if (!sessionId) {
    return JSON.stringify({
      success: false,
      error: 'No session specified and no active session. Load an agent first.',
    });
  }

  const session = ctx.sessionStore.getSession(sessionId);
  if (!session) {
    return JSON.stringify({
      success: false,
      error: `Session not found: ${sessionId}`,
    });
  }

  // Try to get agent details from session or fetch from API
  let agentDetails = session.agentDetails;
  const agentId = session.agentId;
  const agentName = agentDetails?.name || agentId;

  if (!agentDetails && agentId) {
    // For subscribed sessions, try to fetch agent details from API
    const parts = agentId.includes('/') ? agentId.split('/') : null;
    if (parts && parts.length === 2) {
      try {
        const fetched = await ctx.httpClient.getAgent(parts[0], parts[1]);
        if (fetched) {
          agentDetails = fetched;
        }
      } catch {
        // Ignore fetch errors
      }
    }
  }

  if (!agentDetails) {
    // Generate a basic graph from trace events
    const graph = generateGraphFromTraces(sessionId, agentName || 'Unknown', ctx);

    if (args.format === 'mermaid') {
      return JSON.stringify({
        success: true,
        sessionId,
        agentName: agentName || 'Unknown',
        format: 'mermaid',
        message: 'Generated from trace events (agent details not available)',
        mermaid: generateMermaidFromGraph(graph),
      });
    }

    return JSON.stringify({
      success: true,
      sessionId,
      agentName: agentName || 'Unknown',
      format: 'json',
      message: 'Generated from trace events (agent details not available)',
      graph,
    });
  }

  // Get the agent's IR
  const ir = agentDetails.ir as Record<string, unknown> | undefined;

  // Generate graph based on agent type/mode
  const graph = generateAgentGraph(agentDetails, ir);

  // Get current flow state if available
  const currentState = session.state?.flowState;

  if (args.format === 'mermaid') {
    return JSON.stringify({
      success: true,
      sessionId,
      agentName: agentDetails.name,
      agentType: agentDetails.type,
      mode: agentDetails.mode,
      format: 'mermaid',
      currentStep: currentState?.currentStep,
      mermaid: generateMermaidFromGraph(graph, currentState?.currentStep),
    });
  }

  return JSON.stringify({
    success: true,
    sessionId,
    agentName: agentDetails.name,
    agentType: agentDetails.type,
    mode: agentDetails.mode,
    format: 'json',
    currentStep: currentState?.currentStep,
    graph,
  });
}

/**
 * Generate graph from agent details and IR
 */
function generateAgentGraph(
  agentDetails: { name: string; type?: string; mode?: string },
  ir: Record<string, unknown> | undefined,
): AgentGraph {
  const agentName = agentDetails.name;
  const agentType = (agentDetails.type as 'agent' | 'supervisor') || 'agent';
  const hasFlow = !!(ir as Record<string, unknown> | undefined)?.flow;

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  // Entry node
  nodes.push({
    id: '__entry__',
    type: 'entry',
    label: 'Start',
    deterministic: true,
  });

  if (hasFlow && ir?.flow) {
    // Scripted agent with FLOW - extract from flow definition
    extractScriptedFlowGraph(ir.flow as Record<string, unknown>, nodes, edges);
  } else if (agentType === 'supervisor' && ir?.coordination) {
    // Supervisor - extract handoff routing
    extractSupervisorGraph(ir, nodes, edges);
  } else {
    // Reasoning agent - extract tools and handoffs
    extractReasoningGraph(ir, nodes, edges);
  }

  // Exit node (if not already added)
  if (!nodes.find((n) => n.id === '__exit__')) {
    nodes.push({
      id: '__exit__',
      type: 'exit',
      label: 'End',
      deterministic: true,
    });
  }

  return {
    agentName,
    agentType,
    mode: hasFlow ? 'scripted' : 'reasoning',
    nodes,
    edges,
    entryPoint: '__entry__',
  };
}

/**
 * Extract graph from scripted agent FLOW
 */
function extractScriptedFlowGraph(
  flow: Record<string, unknown>,
  nodes: GraphNode[],
  edges: GraphEdge[],
): void {
  const steps = flow.steps as string[] | undefined;
  const definitions = flow.definitions as Record<string, Record<string, unknown>> | undefined;
  const entryPoint = flow.entry_point as string | undefined;

  if (!steps || !definitions) return;

  const startStep = entryPoint || steps[0];

  // Edge from entry to first step
  edges.push({
    id: `__entry__->${startStep}`,
    from: '__entry__',
    to: startStep,
    type: 'sequential',
  });

  // Add nodes for each step
  for (const stepName of steps) {
    const step = definitions[stepName];
    if (!step) continue;

    const constructs: string[] = [];
    if (step.gather) constructs.push('GATHER');
    if (step.call) constructs.push('CALL');
    if (step.respond) constructs.push('RESPOND');

    nodes.push({
      id: stepName,
      type: 'step',
      label: stepName,
      deterministic: true,
      metadata: { constructs },
    });

    // Handle transitions
    const then = step.then as string | undefined;
    const onInput = step.on_input as Array<{ condition?: string; then: string }> | undefined;

    if (onInput && onInput.length > 0) {
      // Decision node for ON_INPUT
      const decisionId = `${stepName}__decision`;
      nodes.push({
        id: decisionId,
        type: 'llm_decision',
        label: 'ON_INPUT',
        deterministic: false,
        metadata: { conditions: onInput.map((b) => b.condition || 'ELSE') },
      });

      edges.push({
        id: `${stepName}->${decisionId}`,
        from: stepName,
        to: decisionId,
        type: 'sequential',
      });

      for (const branch of onInput) {
        if (branch.then) {
          edges.push({
            id: `${decisionId}->${branch.then}`,
            from: decisionId,
            to: branch.then === 'COMPLETE' ? '__exit__' : branch.then,
            type: 'conditional',
            label: branch.condition || 'ELSE',
          });
        }
      }
    } else if (then) {
      edges.push({
        id: `${stepName}->${then}`,
        from: stepName,
        to: then === 'COMPLETE' ? '__exit__' : then,
        type: 'sequential',
      });
    }
  }
}

/**
 * Extract graph from supervisor handoff rules
 */
function extractSupervisorGraph(
  ir: Record<string, unknown>,
  nodes: GraphNode[],
  edges: GraphEdge[],
): void {
  const coordination = ir.coordination as Record<string, unknown> | undefined;
  const handoffs = coordination?.handoffs as
    | Array<{
        to: string;
        when: string;
        return?: boolean;
        context?: { summary?: string };
      }>
    | undefined;

  // Intent classification node
  const intentNodeId = '__intent_classifier__';
  nodes.push({
    id: intentNodeId,
    type: 'llm_decision',
    label: 'Intent Classification',
    deterministic: false,
    metadata: {
      conditions: handoffs?.map((h) => h.when) || [],
    },
  });

  edges.push({
    id: '__entry__->intent',
    from: '__entry__',
    to: intentNodeId,
    type: 'sequential',
  });

  // Add handoff nodes for each target
  if (handoffs) {
    const targets = new Set(handoffs.map((h) => h.to));

    for (const target of targets) {
      const handoffNodeId = `__handoff_${target}__`;
      const handoff = handoffs.find((h) => h.to === target);

      nodes.push({
        id: handoffNodeId,
        type: 'handoff',
        label: `→ ${target}`,
        deterministic: true,
        metadata: {
          target,
          returnExpected: handoff?.return,
        },
      });

      edges.push({
        id: `${intentNodeId}->${handoffNodeId}`,
        from: intentNodeId,
        to: handoffNodeId,
        type: 'handoff',
        label: handoff?.context?.summary || handoff?.when || target,
        condition: handoff?.when,
      });

      // If return expected, add return edge
      if (handoff?.return) {
        edges.push({
          id: `${handoffNodeId}->intent_return`,
          from: handoffNodeId,
          to: intentNodeId,
          type: 'return',
          label: 'return',
        });
      }
    }
  }

  // Add escalation paths if present
  const escalate = ir.escalation as
    | { triggers?: Array<{ when: string; reason: string }> }
    | undefined;
  if (escalate?.triggers) {
    const escalateNodeId = '__escalate__';
    nodes.push({
      id: escalateNodeId,
      type: 'handoff',
      label: '⚠️ ESCALATE',
      deterministic: true,
      metadata: {
        triggers: escalate.triggers,
      },
    });

    edges.push({
      id: `${intentNodeId}->escalate`,
      from: intentNodeId,
      to: escalateNodeId,
      type: 'error',
      label: 'escalation trigger',
    });
  }
}

/**
 * Extract graph from reasoning agent (tools + optional handoffs)
 */
function extractReasoningGraph(
  ir: Record<string, unknown> | undefined,
  nodes: GraphNode[],
  edges: GraphEdge[],
): void {
  // Main reasoning loop node
  const reasoningId = '__reasoning__';
  nodes.push({
    id: reasoningId,
    type: 'llm_decision',
    label: 'LLM Reasoning',
    deterministic: false,
  });

  edges.push({
    id: '__entry__->reasoning',
    from: '__entry__',
    to: reasoningId,
    type: 'sequential',
  });

  // Add tool nodes
  const tools = ir?.tools as Array<{ name: string; description?: string }> | undefined;
  if (tools) {
    for (const tool of tools) {
      const toolNodeId = `__tool_${tool.name}__`;
      nodes.push({
        id: toolNodeId,
        type: 'tool',
        label: tool.name,
        deterministic: true,
        metadata: { description: tool.description },
      });

      // Bidirectional edges for tool usage
      edges.push({
        id: `${reasoningId}->${toolNodeId}`,
        from: reasoningId,
        to: toolNodeId,
        type: 'conditional',
        label: tool.name,
      });

      edges.push({
        id: `${toolNodeId}->${reasoningId}`,
        from: toolNodeId,
        to: reasoningId,
        type: 'sequential',
        label: 'result',
      });
    }
  }

  // Add handoff nodes if coordination exists
  const coordination = ir?.coordination as Record<string, unknown> | undefined;
  const handoffs = coordination?.handoffs as Array<{ to: string; when: string }> | undefined;

  if (handoffs) {
    for (const handoff of handoffs) {
      const handoffNodeId = `__handoff_${handoff.to}__`;
      if (!nodes.find((n) => n.id === handoffNodeId)) {
        nodes.push({
          id: handoffNodeId,
          type: 'handoff',
          label: `→ ${handoff.to}`,
          deterministic: true,
        });

        edges.push({
          id: `${reasoningId}->${handoffNodeId}`,
          from: reasoningId,
          to: handoffNodeId,
          type: 'handoff',
          label: handoff.when,
        });
      }
    }
  }

  // Completion edge
  edges.push({
    id: `${reasoningId}->exit`,
    from: reasoningId,
    to: '__exit__',
    type: 'sequential',
    label: 'complete',
  });
}

/**
 * Generate a graph from trace events (fallback when no IR available)
 */
function generateGraphFromTraces(
  sessionId: string,
  agentName: string,
  ctx: DebugContext,
): AgentGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const seenNodes = new Set<string>();

  nodes.push({
    id: '__entry__',
    type: 'entry',
    label: 'Start',
    deterministic: true,
  });
  seenNodes.add('__entry__');

  // Get trace events and build graph from them
  const events = ctx.traceStore.getBySession(sessionId, 100);

  let lastNodeId = '__entry__';

  for (const event of events) {
    let nodeId: string | null = null;
    let nodeType: GraphNode['type'] = 'step';
    let label = '';

    switch (event.type) {
      case 'llm_call':
        nodeId = `llm_${event.id.substring(0, 8)}`;
        nodeType = 'llm_decision';
        label = `LLM: ${(event.data.model as string) || 'call'}`;
        break;
      case 'tool_call':
        nodeId = `tool_${event.data.tool || event.data.toolName}`;
        nodeType = 'tool';
        label = `${event.data.tool || event.data.toolName}`;
        break;
      case 'handoff':
        nodeId = `handoff_${event.data.to || event.data.target}`;
        nodeType = 'handoff';
        label = `→ ${event.data.to || event.data.target}`;
        break;
      case 'flow_step_enter':
        nodeId = `step_${event.data.step || event.data.stepName}`;
        nodeType = 'step';
        label = `${event.data.step || event.data.stepName}`;
        break;
    }

    if (nodeId && !seenNodes.has(nodeId)) {
      seenNodes.add(nodeId);
      nodes.push({
        id: nodeId,
        type: nodeType,
        label,
        deterministic: nodeType !== 'llm_decision',
      });

      edges.push({
        id: `${lastNodeId}->${nodeId}`,
        from: lastNodeId,
        to: nodeId,
        type: 'sequential',
      });

      lastNodeId = nodeId;
    }
  }

  nodes.push({
    id: '__exit__',
    type: 'exit',
    label: 'End',
    deterministic: true,
  });

  if (lastNodeId !== '__entry__') {
    edges.push({
      id: `${lastNodeId}->__exit__`,
      from: lastNodeId,
      to: '__exit__',
      type: 'sequential',
    });
  }

  return {
    agentName,
    agentType: 'agent',
    mode: 'reasoning',
    nodes,
    edges,
    entryPoint: '__entry__',
  };
}

/**
 * Generate Mermaid diagram from agent graph
 */
function generateMermaidFromGraph(graph: AgentGraph, currentStep?: string): string {
  const lines: string[] = ['stateDiagram-v2'];
  lines.push(`  direction LR`);
  lines.push('');

  // Define state shapes based on type
  for (const node of graph.nodes) {
    if (node.type === 'entry') {
      // Start state is automatic in stateDiagram
      continue;
    } else if (node.type === 'exit') {
      // End state is automatic
      continue;
    } else if (node.type === 'llm_decision') {
      lines.push(`  state "${node.label}" as ${node.id}`);
      lines.push(`  note right of ${node.id} : LLM Decision`);
    } else if (node.type === 'handoff') {
      lines.push(`  state "${node.label}" as ${node.id}`);
    } else if (node.type === 'tool') {
      lines.push(`  state "${node.label}" as ${node.id}`);
    } else {
      lines.push(`  state "${node.label}" as ${node.id}`);
    }

    // Highlight current step
    if (currentStep && node.id === currentStep) {
      lines.push(`  ${node.id}:::current`);
    }
  }

  lines.push('');

  // Add edges
  for (const edge of graph.edges) {
    const from = edge.from === '__entry__' ? '[*]' : edge.from;
    const to = edge.to === '__exit__' ? '[*]' : edge.to;

    if (edge.label) {
      lines.push(`  ${from} --> ${to} : ${edge.label}`);
    } else {
      lines.push(`  ${from} --> ${to}`);
    }
  }

  lines.push('');
  lines.push('  classDef current fill:#f96,stroke:#333,stroke-width:2px');

  return lines.join('\n');
}
