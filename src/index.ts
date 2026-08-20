/**
 * Arch MCP Server
 *
 * Build, evaluate, optimize, debug, and analyze Agent Platform projects via MCP.
 */

export {
  MCPDebugServer,
  MCPDebugServer as ArchMCPServer,
  type MCPDebugServerOptions,
} from './server.js';
export {
  ARCH_CAPABILITY_ORDER,
  ARCH_MCP_DESCRIPTION,
  ARCH_MCP_DISPLAY_NAME,
  ARCH_MCP_LOG_PREFIX,
  ARCH_MCP_ROUTE_KEY_PREFIX,
  ARCH_MCP_SERVER_NAME,
  ARCH_MCP_SERVER_VERSION,
  formatArchToolDescription,
  formatArchToolSummary,
  getArchCapabilityForTool,
  hasArchCapabilityForTool,
  type ArchCapability,
} from './tools/persona.js';

// Re-export types
export * from './types.js';

// Re-export clients
export { WebSocketClient } from './client/websocket-client.js';
export { HttpClient } from './client/http-client.js';
export { EventBuffer } from './client/event-buffer.js';

// Re-export stores
export { SessionStore } from './store/session-store.js';
export { TraceStore } from './store/trace-store.js';
export { SpanBuilder } from './store/span-builder.js';

// Public project-builder extension contract for embedding/test providers.
export {
  PROJECT_BUILDER_CONTRACT_VERSION,
  PROJECT_BUILDER_LIMITS,
  type ProjectBuilderActionDescriptor,
  type ProjectBuilderDomainOntology,
  type ProjectBuilderDomainProvider,
  type ProjectBuilderDomainRegistry,
  type ProjectBuilderEnvelope,
  type ProjectBuilderError,
  type ProjectBuilderRouteAdapter,
  type ProjectBuilderToolResult,
} from './project-building/contracts.js';
export {
  createProductionProjectBuilderDomainRegistry,
  createProjectBuilderDomainRegistry,
} from './project-building/domain-registry.js';
export {
  ARCH_KNOWLEDGE_LIMITS,
  ARCH_KNOWLEDGE_MEDIA_TYPE,
  ARCH_KNOWLEDGE_SCHEMA_VERSION,
  type ArchKnowledgeCatalog,
  type FeatureDependency,
  type FeatureKnowledge,
  type OperationKnowledge,
  type ToolKnowledge,
} from './knowledge/contracts.js';
export { createArchKnowledgeCatalog, extractToolActions } from './knowledge/catalog.js';
