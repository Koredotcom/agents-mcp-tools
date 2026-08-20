/**
 * Arch MCP Server
 *
 * Model Context Protocol server for Agent Platform build, eval, optimize,
 * debug, and analysis workflows.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { WebSocketClient } from './client/websocket-client.js';
import { HttpClient } from './client/http-client.js';
import { SessionStore } from './store/session-store.js';
import { TraceStore } from './store/trace-store.js';
import {
  authenticate as authCascade,
  type AuthResult,
  type AuthOptions,
} from './client/auth-client.js';
import { deriveUrls } from './utils/url.js';
import { DEFAULT_HTTP_URL, DEFAULT_WS_URL } from './constants.js';
import { sanitizeResponse, sanitizeResponseBounded } from './utils/sanitize.js';
import { effectiveInputSchema, tools, getTool, type DebugContext } from './tools/index.js';
import {
  ARCH_MCP_LOG_PREFIX,
  ARCH_MCP_SERVER_NAME,
  ARCH_MCP_SERVER_VERSION,
  formatArchToolDescription,
} from './tools/persona.js';
import type {
  ProjectBuilderDomainProvider,
  ProjectBuilderDomainRegistry,
} from './project-building/contracts.js';
import { createProjectBuilderResult } from './project-building/contracts.js';
import {
  createProductionProjectBuilderDomainRegistry,
  createProjectBuilderDomainRegistry,
} from './project-building/domain-registry.js';
import {
  getProjectBuilderPrompt,
  listProjectBuilderPrompts,
  listProjectBuilderResources,
  listProjectBuilderResourceTemplates,
  readProjectBuilderResource,
} from './project-building/discovery.js';
import type { ProjectBuilderStudioTransportDependencies } from './project-building/studio-transport.js';
import {
  createKnowledgeCatalogReader,
  getKnowledgePrompt,
  isKnowledgePrompt,
  isKnowledgeResourceUri,
  listKnowledgePrompts,
  listKnowledgeResources,
  listKnowledgeResourceTemplates,
  readKnowledgeResource,
  type KnowledgeCatalogReader,
} from './knowledge/discovery.js';
import type { ArchKnowledgeCatalog } from './knowledge/contracts.js';

const PROJECT_BUILDER_INSTRUCTIONS =
  'Use platform_project_builder to discover registered domains and authoritative dependencies before planning. Continue durable work with platform_project_builder_operations. Workflow is the first provider, not a special client-side convention. Never send raw secrets; use opaque auth-profile and integration references. A consumed action with an unknown outcome must be verified, never retried blindly.';

type SplitPortDebugContext = DebugContext & { readonly studioBaseUrl?: string };

export interface MCPDebugServerOptions {
  /** Single server URL — derives both HTTP and WS URLs automatically */
  serverUrl?: string;
  /** @deprecated Use serverUrl instead */
  wsUrl?: string;
  /** @deprecated Use serverUrl instead */
  httpUrl?: string;
  /** Explicit Studio origin when Studio is not co-hosted with Runtime. */
  studioUrl?: string;
  /** Test/embedding-only provider injection. Production registers workflow only. */
  projectBuilderProviders?: readonly ProjectBuilderDomainProvider[];
  /** Narrow transport injection for embedding and protocol-level compatibility tests. */
  projectBuilderTransportDependencies?: ProjectBuilderStudioTransportDependencies;
  /** Optional catalog source for embedding and failure-isolation verification. */
  knowledgeCatalogFactory?: () => ArchKnowledgeCatalog;
}

export class MCPDebugServer {
  private server: Server;
  private wsClient: WebSocketClient;
  private httpClient: HttpClient;
  private sessionStore: SessionStore;
  private traceStore: TraceStore;
  private context: SplitPortDebugContext;
  private projectBuilderRegistry: ProjectBuilderDomainRegistry;
  private knowledgeCatalogReader: KnowledgeCatalogReader;

  constructor(options: MCPDebugServerOptions = {}) {
    let wsUrl: string | undefined;
    let httpUrl: string | undefined;

    if (options.serverUrl) {
      // Derive both from single URL
      const derived = deriveUrls(options.serverUrl);
      wsUrl = derived.wsUrl;
      httpUrl = derived.httpUrl;
    } else {
      // Use individual URLs (deprecated), env var defaults, or empty (set via platform_connect)
      wsUrl = options.wsUrl || DEFAULT_WS_URL;
      httpUrl = options.httpUrl || DEFAULT_HTTP_URL;
    }

    this.wsClient = new WebSocketClient({
      url: wsUrl,
      reconnect: true,
      maxReconnectAttempts: 3,
    });

    this.httpClient = new HttpClient(httpUrl);

    this.sessionStore = new SessionStore();
    this.traceStore = new TraceStore();
    this.projectBuilderRegistry = options.projectBuilderProviders
      ? createProjectBuilderDomainRegistry(options.projectBuilderProviders)
      : createProductionProjectBuilderDomainRegistry();
    this.knowledgeCatalogReader = createKnowledgeCatalogReader(options.knowledgeCatalogFactory);

    // Create context for tools
    this.context = {
      wsClient: this.wsClient,
      httpClient: this.httpClient,
      sessionStore: this.sessionStore,
      traceStore: this.traceStore,
      authenticate: (options?: AuthOptions) => this.authenticate(options),
      projectBuilderRegistry: this.projectBuilderRegistry,
      studioBaseUrl: options.studioUrl,
      projectBuilderTransportDependencies: options.projectBuilderTransportDependencies,
    };

    // Set up WebSocket event handlers
    this.setupWebSocketHandlers();

    // Create MCP server
    this.server = new Server(
      {
        name: ARCH_MCP_SERVER_NAME,
        version: ARCH_MCP_SERVER_VERSION,
      },
      {
        capabilities: {
          tools: {},
          resources: {},
          prompts: {},
        },
        instructions: PROJECT_BUILDER_INSTRUCTIONS,
      },
    );

    // Register handlers
    this.registerHandlers();
  }

  /**
   * Authenticate using the cascade:
   *   explicit token → stored credentials → device auth
   */
  private async authenticate(options?: AuthOptions): Promise<AuthResult> {
    return authCascade(this.httpClient, this.wsClient, options);
  }

  /**
   * Set up WebSocket event handlers to populate stores
   */
  private setupWebSocketHandlers(): void {
    // Handle trace events
    this.wsClient.onTraceEvent = (sessionId, event) => {
      this.traceStore.addEvent(event);
      this.sessionStore.touchSession(sessionId);
    };

    // Handle state updates
    this.wsClient.onStateUpdate = (sessionId, state) => {
      this.sessionStore.updateState(sessionId, state);
    };

    // Handle agent loaded
    this.wsClient.onAgentLoaded = (sessionId, agent) => {
      // Session is created in the loadAgent tool handler
      this.sessionStore.updateAgentDetails(sessionId, agent);
    };

    // Handle connection status
    this.wsClient.onConnected = () => {
      writeMcpLog('info', 'Connected to server');
    };

    this.wsClient.onDisconnected = () => {
      writeMcpLog('info', 'Disconnected from server');
    };

    this.wsClient.onError = (message) => {
      writeMcpLog('error', 'WebSocket error', { message });
    };

    this.wsClient.onInfo = (message, configured) => {
      writeMcpLog('info', message, { apiConfigured: configured });
    };
  }

  /**
   * Register MCP request handlers
   */
  private registerHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: tools.map((tool) => ({
          name: tool.name,
          description: formatArchToolDescription(tool),
          inputSchema: effectiveInputSchema(tool),
          ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
          ...(tool.annotations ? { annotations: tool.annotations } : {}),
        })),
      };
    });

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      const tool = getTool(name);
      if (!tool) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(sanitizeResponse({ error: `Unknown tool: ${name}` })),
            },
          ],
          isError: true,
        };
      }

      try {
        // Parse and validate arguments
        const parsedArgs = tool.schema.parse(args || {});

        // Execute the tool
        const result = await tool.handler(parsedArgs, this.context);

        if (typeof result === 'string') {
          return { content: [{ type: 'text', text: result }] };
        }
        return {
          content: [...result.content],
          structuredContent: result.structuredContent as unknown as Record<string, unknown>,
          ...(result.isError ? { isError: true } : {}),
        };
      } catch (error) {
        const rawMessage = error instanceof Error ? error.message : 'Unknown error';
        const message = String(sanitizeResponse(rawMessage));
        const errorName = error instanceof Error ? error.name : undefined;
        const errorCode = (error as { code?: string }).code;
        const errorCause = error instanceof Error ? error.cause : undefined;
        const safeDiagnostics = safeSanitizeDiagnostic({
          name: errorName,
          code: errorCode,
          message,
          cause: errorCause instanceof Error ? errorCause.message : errorCause,
        });

        writeMcpLog('error', 'Tool request failed', { tool: name, diagnostics: safeDiagnostics });

        if (name === 'platform_project_builder' || name === 'platform_project_builder_operations') {
          const result = createProjectBuilderResult(name, null, {
            code: 'PROJECT_BUILDER_INVALID_REQUEST',
            message,
            retryable: false,
            nextActions: [
              {
                action: 'inspect_schema',
                description: 'Inspect the tool input schema and registered provider actions.',
              },
            ],
          });
          return {
            content: [...result.content],
            structuredContent: result.structuredContent as unknown as Record<string, unknown>,
            isError: true,
          };
        }

        const errorInfo: Record<string, unknown> = { error: message };
        if (errorName && errorName !== 'Error') errorInfo.errorName = errorName;
        if (errorCode) errorInfo.errorCode = errorCode;

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(sanitizeResponse(errorInfo)),
            },
          ],
          isError: true,
        };
      }
    });

    this.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: [
        ...listProjectBuilderResources(this.projectBuilderRegistry),
        ...listKnowledgeResources(),
      ],
    }));

    this.server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
      resourceTemplates: [
        ...listProjectBuilderResourceTemplates(),
        ...listKnowledgeResourceTemplates(),
      ],
    }));

    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      if (isKnowledgeResourceUri(request.params.uri)) {
        return readKnowledgeResource(request.params.uri, this.knowledgeCatalogReader);
      }
      return readProjectBuilderResource(
        request.params.uri,
        this.projectBuilderRegistry,
        this.context,
      );
    });

    this.server.setRequestHandler(ListPromptsRequestSchema, async () => ({
      prompts: [...listProjectBuilderPrompts(), ...listKnowledgePrompts()],
    }));

    this.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
      if (isKnowledgePrompt(request.params.name)) {
        return getKnowledgePrompt(
          request.params.name,
          request.params.arguments,
          this.knowledgeCatalogReader,
        );
      }
      return getProjectBuilderPrompt(request.params.name, request.params.arguments);
    });
  }

  /** Connect to a caller-owned MCP transport (useful for embedding and compatibility tests). */
  async connect(transport: Transport): Promise<void> {
    await this.server.connect(transport);
  }

  /**
   * Start the MCP server with stdio transport
   */
  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.connect(transport);
    writeMcpLog('info', 'Server started');
  }

  /**
   * Stop the server
   */
  async stop(): Promise<void> {
    this.wsClient.disconnect();
    await this.server.close();
    writeMcpLog('info', 'Server stopped');
  }
}

function safeSanitizeDiagnostic(value: unknown): unknown {
  try {
    return sanitizeResponseBounded(value);
  } catch {
    return '[REDACTED]';
  }
}

function writeMcpLog(
  level: 'info' | 'error',
  message: string,
  diagnostics?: Record<string, unknown>,
): void {
  const payload = safeSanitizeDiagnostic({
    level,
    message,
    ...(diagnostics ? { diagnostics } : {}),
  });
  process.stderr.write(`${ARCH_MCP_LOG_PREFIX} ${JSON.stringify(payload)}\n`);
}
