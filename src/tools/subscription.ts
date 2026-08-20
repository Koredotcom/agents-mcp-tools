/**
 * Session Subscription Tools
 *
 * Tools for subscribing to trace events from UI-created sessions.
 * Enables external observation of agent sessions without loading them directly.
 */

import { z } from 'zod';
import type { DebugContext } from './index.js';
import type { TraceEventWithId, SessionInfo } from '../types.js';
import { ARCH_MCP_LOG_PREFIX } from './persona.js';

// =============================================================================
// SCHEMAS
// =============================================================================

export const listActiveSessionsSchema = z.object({});

export const sessionSchema = z.object({
  action: z
    .enum(['subscribe', 'unsubscribe'])
    .describe("Action to perform: 'subscribe' to start receiving traces, 'unsubscribe' to stop"),
  sessionId: z
    .string()
    .describe(
      'The session ID to subscribe to or unsubscribe from (get from debug_list_active_sessions)',
    ),
});

// =============================================================================
// TYPES
// =============================================================================

export type ListActiveSessionsArgs = z.infer<typeof listActiveSessionsSchema>;
export type SessionArgs = z.infer<typeof sessionSchema>;

// =============================================================================
// HANDLERS
// =============================================================================

/**
 * List all active sessions available for subscription
 */
export async function listActiveSessions(
  _args: ListActiveSessionsArgs,
  ctx: DebugContext,
): Promise<string> {
  if (!ctx.wsClient.isConnected()) {
    return JSON.stringify({
      success: false,
      error: 'Not connected to server. Call platform_connect first.',
    });
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      ctx.wsClient.onSessionList = undefined;
      resolve(
        JSON.stringify({
          success: false,
          error: 'Timeout waiting for session list',
        }),
      );
    }, 5000);

    ctx.wsClient.onSessionList = (sessions: SessionInfo[]) => {
      clearTimeout(timeout);
      ctx.wsClient.onSessionList = undefined;

      resolve(
        JSON.stringify({
          success: true,
          count: sessions.length,
          sessions: sessions.map((s) => ({
            sessionId: s.sessionId,
            agentName: s.agentName || 'unknown',
            eventCount: s.eventCount,
            lastActivity: s.lastActivity,
          })),
        }),
      );
    };

    ctx.wsClient.listSessions();
  });
}

/**
 * Unified session subscribe/unsubscribe handler
 */
export async function session(args: SessionArgs, ctx: DebugContext): Promise<string> {
  if (args.action === 'subscribe') {
    return subscribeSession(args.sessionId, ctx);
  }
  return unsubscribeSession(args.sessionId, ctx);
}

/**
 * Subscribe to a session's traces
 * Receives buffered events immediately, then live events as they occur
 */
async function subscribeSession(sessionId: string, ctx: DebugContext): Promise<string> {
  if (!ctx.wsClient.isConnected()) {
    return JSON.stringify({
      success: false,
      error: 'Not connected to server. Call platform_connect first.',
    });
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve(
        JSON.stringify({
          success: false,
          error: 'Timeout waiting for subscription confirmation',
        }),
      );
    }, 5000);

    const cleanup = () => {
      clearTimeout(timeout);
      ctx.wsClient.onSubscribed = undefined;
      ctx.wsClient.onTraceReplay = undefined;
      ctx.wsClient.onError = originalOnError;
    };

    const originalOnError = ctx.wsClient.onError;
    let replayEvents: TraceEventWithId[] = [];
    let eventCount = 0;

    // Handle trace replay (buffered events)
    ctx.wsClient.onTraceReplay = (
      sid: string,
      events: TraceEventWithId[],
      totalBuffered: number,
    ) => {
      if (sid === sessionId) {
        replayEvents = events;
        // Store replayed events in trace store
        for (const event of events) {
          ctx.traceStore.addEvent(event);
        }
        console.error(
          `${ARCH_MCP_LOG_PREFIX} Received ${events.length} buffered events for session ${sessionId}`,
        );
      }
    };

    // Handle subscription confirmation
    ctx.wsClient.onSubscribed = (sid: string, count: number) => {
      if (sid === sessionId) {
        cleanup();
        eventCount = count;

        // Set up the session in the session store for tracking
        ctx.sessionStore.createSession(sessionId, 'subscribed');
        ctx.sessionStore.setActiveSession(sessionId);

        resolve(
          JSON.stringify({
            success: true,
            sessionId,
            message: `Subscribed to session. Received ${replayEvents.length} buffered events.`,
            bufferedEventCount: replayEvents.length,
            replayedEvents: replayEvents.slice(0, 10).map((e) => ({
              id: e.id,
              type: e.type,
              agentName: e.agentName,
              timestamp: e.timestamp,
            })),
            hasMore: replayEvents.length > 10,
          }),
        );
      }
    };

    // Handle errors
    ctx.wsClient.onError = (message: string) => {
      cleanup();
      resolve(
        JSON.stringify({
          success: false,
          error: message,
        }),
      );
    };

    // Subscribe
    ctx.wsClient.subscribeSession(sessionId);
  });
}

/**
 * Unsubscribe from a session
 */
async function unsubscribeSession(sessionId: string, ctx: DebugContext): Promise<string> {
  if (!ctx.wsClient.isConnected()) {
    return JSON.stringify({
      success: false,
      error: 'Not connected to server. Call platform_connect first.',
    });
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      ctx.wsClient.onUnsubscribed = undefined;
      resolve(
        JSON.stringify({
          success: false,
          sessionId,
          error: 'Timeout waiting for unsubscribe confirmation',
        }),
      );
    }, 2000);

    ctx.wsClient.onUnsubscribed = (sid: string) => {
      if (sid === sessionId) {
        clearTimeout(timeout);
        ctx.wsClient.onUnsubscribed = undefined;

        resolve(
          JSON.stringify({
            success: true,
            sessionId,
            message: 'Successfully unsubscribed from session',
          }),
        );
      }
    };

    ctx.wsClient.unsubscribeSession(sessionId);
  });
}
