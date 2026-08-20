/**
 * WebSocket Client for Test Server
 *
 * Connects to the test server WebSocket and handles message routing.
 */

import WebSocket from 'ws';
import type {
  ClientMessage,
  ServerMessage,
  TraceEventWithId,
  AgentState,
  AgentDetails,
  ConstructAction,
  SessionInfo,
} from '../types.js';
import { DEFAULT_WS_URL } from '../constants.js';
import { buildWebDebugWSProtocols } from '../utils/websocket-auth.js';
import { ARCH_MCP_LOG_PREFIX } from '../tools/persona.js';

export type MessageHandler = (message: ServerMessage) => void;

/** Default connection timeout (10 seconds) */
const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;
const MAX_CANDIDATE_BUFFERED_MESSAGES = 100;
const MAX_CANDIDATE_BUFFERED_BYTES = 256 * 1024;

export interface ConnectionOptions {
  url?: string;
  reconnect?: boolean;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
  connectionTimeoutMs?: number;
}

export interface ReconnectOptions {
  url?: string;
  authToken?: string;
}

export interface DisconnectOptions {
  /** Keep the configured automatic reconnect policy for a later explicit connect. */
  preserveReconnectPolicy?: boolean;
}

export interface PreparedWebSocketReplacement {
  /** True only while the authenticated candidate remains safe to promote. */
  isReady(): boolean;
  /** Promote the already-authenticated candidate and retire the old socket; throws if promotion is unsafe. */
  commit(): void;
  /** Close the candidate without changing any published client state. */
  abort(): void;
}

interface CandidateSocket {
  socket: WebSocket;
  bufferedMessages: string[];
  isReady(): boolean;
  stopPreparing(): void;
}

function rawDataByteLength(data: WebSocket.RawData): number {
  if (Array.isArray(data)) {
    return data.reduce((total, chunk) => total + chunk.byteLength, 0);
  }
  return data.byteLength;
}

export class WebSocketClient {
  private ws: WebSocket | null = null;
  private url: string;
  private messageHandlers: Set<MessageHandler> = new Set();
  private autoReconnect: boolean;
  private reconnectInterval: number;
  private maxReconnectAttempts: number;
  private connectionTimeoutMs: number;
  private reconnectAttempts = 0;
  private isConnecting = false;
  private connectionPromise: Promise<void> | null = null;
  private connectionGeneration = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionallyClosedSockets = new WeakSet<WebSocket>();
  private candidateSockets = new Set<WebSocket>();

  // Event-specific callbacks
  public onTraceEvent?: (sessionId: string, event: TraceEventWithId) => void;
  public onStateUpdate?: (sessionId: string, state: AgentState) => void;
  public onAgentLoaded?: (sessionId: string, agent: AgentDetails) => void;
  public onAgentLoadError?: (error: string) => void;
  public onResponseStart?: (sessionId: string, messageId: string) => void;
  public onResponseChunk?: (sessionId: string, messageId: string, chunk: string) => void;
  public onResponseEnd?: (sessionId: string, messageId: string, fullText: string) => void;
  public onActionTaken?: (sessionId: string, action: ConstructAction) => void;
  public onError?: (message: string) => void;
  public onInfo?: (message: string, configured: boolean) => void;
  public onConnected?: () => void;
  public onDisconnected?: () => void;

  // Subscription-specific callbacks
  public onTraceReplay?: (
    sessionId: string,
    events: TraceEventWithId[],
    totalBuffered: number,
  ) => void;
  public onSubscribed?: (sessionId: string, eventCount: number) => void;
  public onUnsubscribed?: (sessionId: string) => void;
  public onSessionList?: (sessions: SessionInfo[]) => void;
  public onSessionEnded?: (sessionId: string) => void;
  public onSessionExpired?: (sessionId: string, reason: string) => void;

  private authToken: string | null = null;

  constructor(options: ConnectionOptions = {}) {
    this.url = options.url || DEFAULT_WS_URL || '';
    this.autoReconnect = options.reconnect ?? false;
    this.reconnectInterval = options.reconnectInterval ?? 3000;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 5;
    this.connectionTimeoutMs = options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS;
  }

  /**
   * Set auth token for authenticated connections
   */
  setAuthToken(token: string | null): void {
    this.authToken = token;
  }

  /** Get the token that will be used for the next authenticated handshake. */
  getAuthToken(): string | null {
    return this.authToken;
  }

  /**
   * Connect to the WebSocket server
   */
  async connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return; // Already connected
    }

    if (this.isConnecting && this.connectionPromise) {
      return this.connectionPromise; // Already connecting
    }

    this.cancelReconnectTimer();
    const generation = ++this.connectionGeneration;
    this.isConnecting = true;
    this.connectionPromise = new Promise((resolve, reject) => {
      let settled = false;
      let connectionTimer: ReturnType<typeof setTimeout> | undefined;

      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        if (connectionTimer) clearTimeout(connectionTimer);
        fn();
      };

      try {
        if (!this.authToken?.trim()) {
          const error = new Error(
            'Internal runtime WebSocket connections require setAuthToken() before connect().',
          );
          this.isConnecting = false;
          this.onError?.(error.message);
          reject(error);
          return;
        }

        const socket = new WebSocket(this.url, buildWebDebugWSProtocols(this.authToken));
        this.ws = socket;

        // Connection timeout — rejects + closes socket if open/error never fires
        connectionTimer = setTimeout(() => {
          if (!this.isCurrentConnection(socket, generation)) {
            settle(() => reject(new Error('WebSocket connection was superseded.')));
            return;
          }

          settle(() => {
            this.isConnecting = false;
            this.connectionPromise = null;
            const timeoutSec = Math.round(this.connectionTimeoutMs / 1000);
            const error = new Error(
              `WebSocket connection timed out after ${timeoutSec}s connecting to ${this.url}`,
            );
            error.name = 'ConnectionTimeoutError';
            if (this.ws === socket) {
              this.ws = null;
            }
            this.intentionallyClosedSockets.add(socket);
            socket.close();
            this.onError?.(error.message);
            reject(error);
          });
        }, this.connectionTimeoutMs);

        socket.on('open', () => {
          if (!this.isCurrentConnection(socket, generation)) {
            this.intentionallyClosedSockets.add(socket);
            socket.close();
            settle(() => reject(new Error('WebSocket connection was superseded.')));
            return;
          }

          settle(() => {
            this.isConnecting = false;
            this.connectionPromise = null;
            this.reconnectAttempts = 0;
            this.onConnected?.();
            resolve();
          });
        });

        socket.on('message', (data) => {
          if (!this.isCurrentConnection(socket, generation)) return;
          this.handleMessage(data.toString());
        });

        socket.on('close', () => {
          const intentionallyClosed = this.intentionallyClosedSockets.delete(socket);
          if (!this.isCurrentConnection(socket, generation)) {
            settle(() => reject(new Error('WebSocket connection was superseded.')));
            return;
          }

          this.ws = null;
          this.isConnecting = false;
          this.connectionPromise = null;
          this.onDisconnected?.();
          settle(() => reject(new Error(`WebSocket connection closed before opening ${this.url}`)));
          if (
            !intentionallyClosed &&
            this.autoReconnect &&
            this.reconnectAttempts < this.maxReconnectAttempts
          ) {
            this.reconnectAttempts++;
            const reconnectGeneration = generation;
            this.reconnectTimer = setTimeout(() => {
              this.reconnectTimer = null;
              if (
                !this.autoReconnect ||
                this.connectionGeneration !== reconnectGeneration ||
                this.ws !== null ||
                this.isConnecting
              ) {
                return;
              }

              this.connect().catch((err) => {
                console.error(
                  `${ARCH_MCP_LOG_PREFIX} Reconnect failed:`,
                  err instanceof Error ? err.message : err,
                );
              });
            }, this.reconnectInterval);
          }
        });

        socket.on('error', (error) => {
          if (!this.isCurrentConnection(socket, generation)) {
            settle(() => reject(new Error('WebSocket connection was superseded.')));
            return;
          }

          if (settled) {
            this.onError?.(error.message);
            return;
          }

          settle(() => {
            this.isConnecting = false;
            this.connectionPromise = null;
            this.onError?.(error.message);
            reject(error);
          });
        });
      } catch (error) {
        settle(() => {
          this.isConnecting = false;
          reject(error);
        });
      }
    });

    return this.connectionPromise;
  }

  /**
   * Disconnect from the WebSocket server
   */
  disconnect(options: DisconnectOptions = {}): void {
    if (!options.preserveReconnectPolicy) {
      this.autoReconnect = false;
    }
    this.closeCurrentSocket();
  }

  /**
   * Authenticate a candidate socket without changing the active connection,
   * URL, or token. The caller can perform other transactional work before a
   * synchronous, non-throwing promotion.
   */
  async prepareReplacement(options: ReconnectOptions = {}): Promise<PreparedWebSocketReplacement> {
    const candidateUrl = options.url ?? this.url;
    const candidateToken = options.authToken ?? this.authToken;
    if (!candidateToken?.trim()) {
      throw new Error(
        'Internal runtime WebSocket connections require an auth token before replacement.',
      );
    }

    const candidate = await this.openCandidateSocket(candidateUrl, candidateToken);
    let finalized = false;
    return {
      isReady: () => !finalized && candidate.isReady(),
      commit: () => {
        if (finalized) {
          throw new Error('Prepared WebSocket replacement has already been finalized.');
        }
        if (!candidate.isReady()) {
          finalized = true;
          this.candidateSockets.delete(candidate.socket);
          candidate.stopPreparing();
          this.discardSocket(candidate.socket);
          throw new Error('Replacement WebSocket closed before it could be promoted.');
        }
        finalized = true;
        this.candidateSockets.delete(candidate.socket);
        this.promoteCandidateSocket(candidate, candidateUrl, candidateToken);
      },
      abort: () => {
        if (finalized) return;
        finalized = true;
        this.candidateSockets.delete(candidate.socket);
        candidate.stopPreparing();
        this.discardSocket(candidate.socket);
      },
    };
  }

  /** Atomically replace the active authenticated connection. */
  async reconnect(options: ReconnectOptions = {}): Promise<void> {
    const replacement = await this.prepareReplacement(options);
    if (!replacement.isReady()) {
      replacement.abort();
      throw new Error('Replacement WebSocket closed before it could be promoted.');
    }
    replacement.commit();
  }

  private closeCurrentSocket(): void {
    this.cancelReconnectTimer();
    for (const candidate of this.candidateSockets) {
      this.discardSocket(candidate);
    }
    this.candidateSockets.clear();
    this.connectionGeneration++;
    const socket = this.ws;
    this.ws = null;
    this.isConnecting = false;
    this.connectionPromise = null;

    if (socket) {
      this.intentionallyClosedSockets.add(socket);
      this.onDisconnected?.();
      socket.close();
    }
  }

  private openCandidateSocket(url: string, authToken: string): Promise<CandidateSocket> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, buildWebDebugWSProtocols(authToken), {
        maxPayload: MAX_CANDIDATE_BUFFERED_BYTES,
      });
      const bufferedMessages: string[] = [];
      let bufferedBytes = 0;
      let closed = false;
      let invalid = false;
      let candidateLeaseTimer: ReturnType<typeof setTimeout> | null = null;
      const clearCandidateLease = () => {
        if (!candidateLeaseTimer) return;
        clearTimeout(candidateLeaseTimer);
        candidateLeaseTimer = null;
      };
      const bufferMessage = (data: WebSocket.RawData) => {
        const messageBytes = rawDataByteLength(data);
        if (
          messageBytes > MAX_CANDIDATE_BUFFERED_BYTES ||
          bufferedMessages.length >= MAX_CANDIDATE_BUFFERED_MESSAGES ||
          bufferedBytes + messageBytes > MAX_CANDIDATE_BUFFERED_BYTES
        ) {
          invalid = true;
          clearCandidateLease();
          this.candidateSockets.delete(socket);
          this.discardSocket(socket);
          return;
        }
        const message = data.toString();
        bufferedMessages.push(message);
        bufferedBytes += messageBytes;
      };
      const trackCandidateClose = () => {
        closed = true;
        clearCandidateLease();
        this.candidateSockets.delete(socket);
      };
      const trackCandidateError = () => {
        invalid = true;
        clearCandidateLease();
        this.candidateSockets.delete(socket);
        this.discardSocket(socket);
      };
      socket.on('message', bufferMessage);
      this.candidateSockets.add(socket);
      let settled = false;
      const timer = setTimeout(() => {
        finish(() => {
          this.candidateSockets.delete(socket);
          this.discardSocket(socket);
          const timeoutSec = Math.round(this.connectionTimeoutMs / 1000);
          const error = new Error(
            `WebSocket connection timed out after ${timeoutSec}s connecting to ${url}`,
          );
          error.name = 'ConnectionTimeoutError';
          reject(error);
        });
      }, this.connectionTimeoutMs);

      const finish = (operation: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.off('open', handleOpen);
        socket.off('error', handleError);
        socket.off('close', handleClose);
        operation();
      };
      const handleOpen = () =>
        finish(() => {
          socket.on('error', trackCandidateError);
          socket.once('close', trackCandidateClose);
          candidateLeaseTimer = setTimeout(() => {
            invalid = true;
            candidateLeaseTimer = null;
            this.candidateSockets.delete(socket);
            this.discardSocket(socket);
          }, this.connectionTimeoutMs);
          resolve({
            socket,
            bufferedMessages,
            isReady: () =>
              !closed &&
              !invalid &&
              socket.readyState === WebSocket.OPEN &&
              this.candidateSockets.has(socket),
            stopPreparing: () => {
              clearCandidateLease();
              socket.off('message', bufferMessage);
              socket.off('error', trackCandidateError);
              socket.off('close', trackCandidateClose);
            },
          });
        });
      const handleError = (error: Error) =>
        finish(() => {
          this.candidateSockets.delete(socket);
          this.discardSocket(socket);
          reject(error);
        });
      const handleClose = () =>
        finish(() => {
          this.candidateSockets.delete(socket);
          reject(new Error(`WebSocket connection closed before opening ${url}`));
        });

      socket.once('open', handleOpen);
      socket.once('error', handleError);
      socket.once('close', handleClose);
    });
  }

  private promoteCandidateSocket(candidate: CandidateSocket, url: string, authToken: string): void {
    const { socket, bufferedMessages } = candidate;
    candidate.stopPreparing();
    const previousSocket = this.ws;
    this.cancelReconnectTimer();
    const generation = ++this.connectionGeneration;
    this.url = url;
    this.authToken = authToken;
    this.ws = socket;
    this.isConnecting = false;
    this.connectionPromise = null;
    this.reconnectAttempts = 0;
    socket.on('message', (data) => {
      if (!this.isCurrentConnection(socket, generation)) return;
      this.handleMessage(data.toString());
    });
    socket.on('error', (error) => {
      if (!this.isCurrentConnection(socket, generation)) return;
      this.onError?.(error.message);
    });
    socket.on('close', () => {
      const intentionallyClosed = this.intentionallyClosedSockets.delete(socket);
      if (!this.isCurrentConnection(socket, generation)) return;
      this.ws = null;
      this.onDisconnected?.();
      if (
        !intentionallyClosed &&
        this.autoReconnect &&
        this.reconnectAttempts < this.maxReconnectAttempts
      ) {
        this.reconnectAttempts++;
        const reconnectGeneration = generation;
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          if (
            !this.autoReconnect ||
            this.connectionGeneration !== reconnectGeneration ||
            this.ws !== null ||
            this.isConnecting
          ) {
            return;
          }
          this.connect().catch((error) => {
            console.error(
              `${ARCH_MCP_LOG_PREFIX} Reconnect failed:`,
              error instanceof Error ? error.message : error,
            );
          });
        }, this.reconnectInterval);
      }
    });

    if (previousSocket && previousSocket !== socket) {
      this.intentionallyClosedSockets.add(previousSocket);
      this.onDisconnected?.();
      try {
        previousSocket.close();
      } catch (_error) {
        // The candidate is already authoritative; stale socket callbacks are fenced.
      }
    }
    this.onConnected?.();
    queueMicrotask(() => {
      if (!this.isCurrentConnection(socket, generation)) return;
      for (const message of bufferedMessages) {
        this.handleMessage(message);
      }
    });
  }

  private discardSocket(socket: WebSocket): void {
    socket.removeAllListeners();
    socket.once('error', () => undefined);
    try {
      socket.close();
    } catch (_error) {
      // Best-effort candidate cleanup; it was never published as active.
    }
  }

  private isCurrentConnection(socket: WebSocket, generation: number): boolean {
    return this.ws === socket && this.connectionGeneration === generation;
  }

  private cancelReconnectTimer(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Send a message to the server
   */
  send(message: ClientMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket is not connected');
    }
    this.ws.send(JSON.stringify(message));
  }

  /**
   * Load an agent
   */
  loadAgent(agentPath: string, projectId: string): void {
    this.send({ type: 'load_agent', agentPath, projectId });
  }

  /**
   * Send a message to the agent
   */
  sendMessage(sessionId: string, text: string): void {
    this.send({ type: 'send_message', sessionId, text });
  }

  /**
   * Get current state
   */
  getState(sessionId: string): void {
    this.send({ type: 'get_state', sessionId });
  }

  /**
   * Run a test
   */
  runTest(sessionId: string, testId: string): void {
    this.send({ type: 'run_test', sessionId, testId });
  }

  /**
   * Subscribe to a session's traces (for external observation)
   * Will receive trace_replay with buffered events, then live trace_event messages
   */
  subscribeSession(sessionId: string): void {
    this.send({ type: 'subscribe_session', sessionId });
  }

  /**
   * Unsubscribe from a session
   */
  unsubscribeSession(sessionId: string): void {
    this.send({ type: 'unsubscribe_session', sessionId });
  }

  /**
   * List all active sessions available for subscription
   */
  listSessions(): void {
    this.send({ type: 'list_sessions' });
  }

  /**
   * Add a generic message handler
   */
  addMessageHandler(handler: MessageHandler): void {
    this.messageHandlers.add(handler);
  }

  /**
   * Remove a message handler
   */
  removeMessageHandler(handler: MessageHandler): void {
    this.messageHandlers.delete(handler);
  }

  /**
   * Handle incoming message
   */
  private handleMessage(data: string): void {
    try {
      const message = JSON.parse(data) as ServerMessage;

      // Call generic handlers
      for (const handler of this.messageHandlers) {
        handler(message);
      }

      // Call specific handlers
      switch (message.type) {
        case 'trace_event':
          this.onTraceEvent?.(message.sessionId, message.event);
          break;
        case 'state_update':
          this.onStateUpdate?.(message.sessionId, message.state);
          break;
        case 'agent_loaded':
          this.onAgentLoaded?.(message.sessionId, message.agent);
          break;
        case 'agent_load_error':
          this.onAgentLoadError?.(message.error);
          break;
        case 'response_start':
          this.onResponseStart?.(message.sessionId, message.messageId);
          break;
        case 'response_chunk':
          this.onResponseChunk?.(message.sessionId, message.messageId, message.chunk);
          break;
        case 'response_end':
          this.onResponseEnd?.(message.sessionId, message.messageId, message.fullText);
          break;
        case 'action_taken':
          this.onActionTaken?.(message.sessionId, message.action);
          break;
        case 'error':
          this.onError?.(message.message);
          break;
        case 'info':
          this.onInfo?.(message.message, message.configured);
          break;
        // Subscription-related messages
        case 'trace_replay':
          this.onTraceReplay?.(message.sessionId, message.events, message.totalBuffered);
          break;
        case 'subscribed':
          this.onSubscribed?.(message.sessionId, message.eventCount);
          break;
        case 'unsubscribed':
          this.onUnsubscribed?.(message.sessionId);
          break;
        case 'session_list':
          this.onSessionList?.(message.sessions);
          break;
        case 'session_ended':
          this.onSessionEnded?.(message.sessionId);
          break;
        case 'session_expired':
          this.onSessionExpired?.(message.sessionId, message.reason);
          break;
      }
    } catch (error) {
      const message = `Failed to parse WebSocket message: ${error instanceof Error ? error.message : error}`;
      console.error(`${ARCH_MCP_LOG_PREFIX} ${message}`);
      this.onError?.(message);
    }
  }

  /**
   * Set WebSocket URL
   */
  setUrl(url: string): void {
    this.url = url;
  }

  /**
   * Get WebSocket URL
   */
  getUrl(): string {
    return this.url;
  }
}
