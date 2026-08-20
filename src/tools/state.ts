/**
 * debug_get_current_state Tool
 *
 * Get the current session state including context, flow state, etc.
 */

import { z } from 'zod';
import type { DebugContext } from './index.js';

export const getCurrentStateSchema = z.object({
  sessionId: z.string().optional().describe('Session ID (uses active session if not specified)'),
});

export type GetCurrentStateArgs = z.infer<typeof getCurrentStateSchema>;

export async function getCurrentState(
  args: GetCurrentStateArgs,
  ctx: DebugContext,
): Promise<string> {
  // Use active session if not specified
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

  // If we have state in the session store, return it
  if (session.state) {
    return JSON.stringify({
      success: true,
      sessionId,
      agentId: session.agentId,
      state: session.state,
      lastActivityAt: session.lastActivityAt,
    });
  }

  // If connected, request fresh state from server
  if (ctx.wsClient.isConnected()) {
    return new Promise((resolve) => {
      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve(
            JSON.stringify({
              success: false,
              error: 'Timeout waiting for state update',
            }),
          );
        }
      }, 5000);

      // Set up one-time handler
      const originalOnStateUpdate = ctx.wsClient.onStateUpdate;

      ctx.wsClient.onStateUpdate = (msgSessionId, state) => {
        if (msgSessionId === sessionId) {
          // Restore original handler
          ctx.wsClient.onStateUpdate = originalOnStateUpdate;

          // Update store
          ctx.sessionStore.updateState(sessionId, state);

          clearTimeout(timeout);
          if (!resolved) {
            resolved = true;
            resolve(
              JSON.stringify({
                success: true,
                sessionId,
                agentId: session.agentId,
                state,
                source: 'fresh',
              }),
            );
          }
        }

        // Call original handler
        originalOnStateUpdate?.(msgSessionId, state);
      };

      // Request state
      ctx.wsClient.getState(sessionId);
    });
  }

  // No state available
  return JSON.stringify({
    success: true,
    sessionId,
    agentId: session.agentId,
    state: null,
    message: 'No state available yet. Send a message to the agent first.',
  });
}
