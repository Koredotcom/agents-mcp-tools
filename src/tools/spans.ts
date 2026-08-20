/**
 * debug_get_span_tree Tool
 *
 * Get hierarchical span tree for execution flow visualization.
 */

import { z } from 'zod';
import type { DebugContext } from './index.js';
import { SpanBuilder } from '../store/span-builder.js';

export const getSpanTreeSchema = z.object({
  sessionId: z.string().optional().describe('Session ID (uses active session if not specified)'),
  flat: z
    .boolean()
    .optional()
    .default(false)
    .describe('Return as flat list with depth info instead of tree'),
});

export type GetSpanTreeArgs = z.infer<typeof getSpanTreeSchema>;

export async function getSpanTree(args: GetSpanTreeArgs, ctx: DebugContext): Promise<string> {
  // Use active session if not specified
  const sessionId = args.sessionId || ctx.sessionStore.getActiveSessionId();

  if (!sessionId) {
    return JSON.stringify({
      success: false,
      error: 'No session specified and no active session. Load an agent first.',
    });
  }

  // Get events for the session
  const events = ctx.traceStore.getBySession(sessionId);

  if (events.length === 0) {
    return JSON.stringify({
      success: true,
      sessionId,
      tree: [],
      stats: {
        totalSpans: 0,
        maxDepth: 0,
        totalDurationMs: 0,
        byType: {},
      },
      message: 'No trace events yet. Send a message to the agent to generate traces.',
    });
  }

  // Build the span tree
  const builder = new SpanBuilder();
  const tree = builder.buildTree(events);
  const stats = builder.getTreeStats(tree);

  if (args.flat) {
    // Return flat list with depth info
    const flatList = builder.flatten(tree);
    return JSON.stringify({
      success: true,
      sessionId,
      format: 'flat',
      spans: flatList.map((node) => ({
        id: node.id,
        name: node.name,
        type: node.type,
        depth: node.data._depth,
        startTime: node.startTime,
        endTime: node.endTime,
        durationMs: node.durationMs,
        parentId: node.parentId,
      })),
      stats,
    });
  }

  // Return tree format
  const formatTree = (nodes: typeof tree): unknown[] =>
    nodes.map((node) => ({
      id: node.id,
      name: node.name,
      type: node.type,
      startTime: node.startTime,
      endTime: node.endTime,
      durationMs: node.durationMs,
      children: formatTree(node.children),
    }));

  return JSON.stringify({
    success: true,
    sessionId,
    format: 'tree',
    tree: formatTree(tree),
    stats,
  });
}
