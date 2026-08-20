import {
  PROJECT_BUILDER_CONTRACT_VERSION,
  type JsonSchema,
  type ProjectBuilderDomainProvider,
  type ProjectBuilderRouteRequest,
} from '../contracts.js';
import { findSensitiveFieldPathBounded } from '../../utils/sanitize.js';

const objectSchema: JsonSchema = Object.freeze({ type: 'object', additionalProperties: false });
const actionNames = [
  'describe',
  'inspect',
  'plan',
  'list',
  'read',
  'dependency_report',
  'readiness_report',
  'resume',
  'cancel',
  'create_confirmation_grant',
  'execute_action',
] as const;

export function createWorkflowDomainProvider(): ProjectBuilderDomainProvider {
  const schemas = Object.fromEntries(
    actionNames.map((action) => [`workflow:${action}`, objectSchema]),
  );
  return {
    domain: 'workflow',
    contractVersion: PROJECT_BUILDER_CONTRACT_VERSION,
    ontology: {
      kinds: [
        { id: 'workflow:agent', label: 'Agent' },
        { id: 'workflow:auth-profile', label: 'Authentication profile' },
        { id: 'workflow:integration', label: 'Integration connection' },
        { id: 'workflow:mcp-server', label: 'MCP server' },
        { id: 'workflow:project-tool', label: 'Project tool' },
        { id: 'workflow:workflow', label: 'Workflow' },
      ],
      edges: [
        { id: 'workflow:authenticates', from: 'workflow:auth-profile', to: 'workflow:integration' },
        { id: 'workflow:backs-tool', from: 'workflow:workflow', to: 'workflow:project-tool' },
        { id: 'workflow:exposes-tools', from: 'workflow:mcp-server', to: 'workflow:project-tool' },
        { id: 'workflow:linked-to-agent', from: 'workflow:project-tool', to: 'workflow:agent' },
        { id: 'workflow:used-by', from: 'workflow:integration', to: 'workflow:workflow' },
      ],
      lifecycle: [
        { from: 'workflow:auth-profile', to: 'workflow:integration' },
        { from: 'workflow:integration', to: 'workflow:workflow' },
        { from: 'workflow:mcp-server', to: 'workflow:project-tool' },
        { from: 'workflow:workflow', to: 'workflow:project-tool' },
        { from: 'workflow:project-tool', to: 'workflow:agent' },
      ],
    },
    actions: actionNames.map((action) => ({
      id: `workflow:${action}`,
      mode: actionMode(action),
      inputSchema: `workflow:${action}`,
      outputSchema: `workflow:${action}`,
      ...(action === 'plan' || action === 'execute_action' ? { longRunning: true } : {}),
    })),
    inputSchemas: schemas,
    outputSchemas: schemas,
    imports: [],
    exports: [
      { id: 'workflow:agent', kind: 'workflow:agent' },
      { id: 'workflow:project-tool', kind: 'workflow:project-tool' },
      { id: 'workflow:workflow', kind: 'workflow:workflow' },
    ],
    readinessOwner: {
      kind: 'authoritative_service',
      service: 'studio-workflow-builder',
      supportsDependencyOnly: true,
      assertions: ['workflow:control-plane-ready', 'workflow:runtime-ready'],
    },
    routeAdapter: {
      supportedActions: actionNames,
      buildRequest: buildWorkflowRequest,
    },
  };
}

function buildWorkflowRequest(
  action: string,
  request: { readonly projectId: string; readonly operationId?: string; readonly input?: unknown },
): ProjectBuilderRouteRequest {
  const sensitivePath = findSensitiveFieldPathBounded(request.input);
  if (sensitivePath) {
    throw new Error(
      `Raw credentials are not accepted by the project builder (${sensitivePath}); use an opaque auth-profile reference`,
    );
  }
  const projectId = encodeURIComponent(request.projectId);
  const operationId = request.operationId ? encodeURIComponent(request.operationId) : undefined;
  const root = `/api/projects/${projectId}/arch-workflow-builds`;
  switch (action) {
    case 'describe':
      throw new Error('Describe is static and has no Studio route');
    case 'plan':
      return { method: 'POST', path: root, body: request.input ?? {} };
    case 'list':
      return { method: 'GET', path: operationListPath(root, request.input) };
    case 'inspect':
    case 'dependency_report':
      return operationRoute(
        operationId,
        `${root}/${operationId}/dependency-report?includeReadiness=false`,
      );
    case 'readiness_report':
      return operationRoute(
        operationId,
        `${root}/${operationId}/dependency-report?includeReadiness=true`,
      );
    case 'read':
      return operationRoute(operationId, `${root}/${operationId}`);
    case 'resume':
      return operationRoute(operationId, `${root}/${operationId}/resume`, 'POST', request.input);
    case 'cancel':
      return operationRoute(operationId, `${root}/${operationId}/cancel`, 'POST', request.input);
    case 'create_confirmation_grant':
      return operationRoute(
        operationId,
        `${root}/${operationId}/confirmation-grants`,
        'POST',
        request.input,
      );
    case 'execute_action':
      return operationRoute(operationId, `${root}/${operationId}/actions`, 'POST', request.input);
    default:
      throw new Error(`Unsupported workflow project-builder action: ${action}`);
  }
}

function operationListPath(root: string, input: unknown): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return root;
  const values = input as Record<string, unknown>;
  const query = new URLSearchParams();
  for (const key of ['cursor', 'status', 'stage'] as const) {
    if (typeof values[key] === 'string' && values[key]) query.set(key, values[key]);
  }
  if (typeof values.limit === 'number') query.set('limit', String(values.limit));
  return query.size > 0 ? `${root}?${query}` : root;
}

function operationRoute(
  operationId: string | undefined,
  path: string,
  method: 'GET' | 'POST' = 'GET',
  body?: unknown,
): ProjectBuilderRouteRequest {
  if (!operationId) throw new Error('operationId is required for this action');
  return { method, path, ...(method === 'POST' ? { body: body ?? {} } : {}) };
}

function actionMode(action: (typeof actionNames)[number]) {
  if (action === 'cancel') return 'destructive_write' as const;
  if (action === 'execute_action') return 'grant_gated_write' as const;
  if (['plan', 'resume', 'create_confirmation_grant'].includes(action)) {
    return 'idempotent_write' as const;
  }
  return 'read' as const;
}
