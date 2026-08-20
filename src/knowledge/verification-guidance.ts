import type { OperationReference, OperationSafety } from './contracts.js';

export interface OperationVerificationGuidance {
  readonly validatesWith: OperationReference;
  readonly requiredContext: readonly string[];
  readonly expectedEvidence: string;
}

type VerificationEntry = readonly [string, OperationVerificationGuidance];

const mutationEntries: VerificationEntry[] = [
  ...verify(
    ['platform_connect:invoke'],
    'platform_workspaces',
    'current',
    ['expected server/workspace identity'],
    'The active target and workspace match the requested environment.',
  ),
  ...verify(
    ['debug_load_agent:invoke'],
    'debug_get_current_state',
    'invoke',
    ['loaded session id'],
    'The current state belongs to the newly loaded debug session.',
  ),
  ...verify(
    ['debug_send_message:invoke'],
    'debug_traces',
    'invoke',
    ['active session id', 'sent message correlation'],
    'A trace records the sent message or its resulting agent turn.',
  ),
  ...verify(
    ['debug_session:subscribe', 'debug_session:unsubscribe'],
    'debug_list_active_sessions',
    'invoke',
    ['target session id'],
    'The active-session list reflects the requested subscription state.',
  ),
  ...verify(
    ['platform_project_builder:plan'],
    'platform_project_builder_operations',
    'read',
    ['operation id returned by plan'],
    'The durable operation exists with the planned goal and current version.',
  ),
  ...verify(
    [
      'platform_project_builder_operations:cancel',
      'platform_project_builder_operations:create_confirmation_grant',
      'platform_project_builder_operations:execute_action',
      'platform_project_builder_operations:resume',
    ],
    'platform_project_builder_operations',
    'read',
    ['operation id', 'operation version returned by the mutation'],
    'The durable operation status/version reflects the requested transition.',
  ),
  ...verify(
    ['platform_projects:create', 'platform_projects:update'],
    'platform_projects',
    'get',
    ['project id returned by the mutation'],
    'The project read reflects the requested persisted fields.',
  ),
  ...verify(
    ['platform_projects:delete'],
    'platform_projects',
    'list',
    ['deleted project id'],
    'The deleted project is absent from the accessible project list.',
  ),
  ...verify(
    ['platform_workflows:create', 'platform_workflows:update', 'platform_workflows:publish'],
    'platform_workflows',
    'get',
    ['workflow id returned by the mutation'],
    'The workflow read reflects the requested definition or published state.',
  ),
  ...verify(
    ['platform_workflows:create_tool'],
    'platform_tools',
    'get',
    ['project tool id returned by create_tool'],
    'The generated project tool exists and references the intended workflow.',
  ),
  ...verify(
    ['platform_workflows:delete'],
    'platform_workflows',
    'list',
    ['deleted workflow id'],
    'The deleted workflow is absent from the project workflow list.',
  ),
  ...verify(
    ['platform_workflows:execute'],
    'platform_workflows',
    'get',
    ['workflow id', 'original execution result'],
    'The workflow remains readable; execution success must come from the original non-replayed result, not this read.',
  ),
  ...verify(
    [
      'platform_arch_sop:cancel',
      'platform_arch_sop:continue',
      'platform_arch_sop:create_project',
      'platform_arch_sop:create_session',
      'platform_arch_sop:recover',
      'platform_arch_sop:send_message',
      'platform_arch_sop:upload_file',
    ],
    'platform_arch_sop',
    'get_session',
    ['Arch session id'],
    'The session phase, messages, files, project link, or terminal state reflects the requested mutation.',
  ),
  ...verify(
    [
      'platform_arch_auto_loop:create',
      'platform_arch_auto_loop:execute_action',
      'platform_arch_auto_loop:record_decision',
    ],
    'platform_arch_auto_loop',
    'get',
    ['auto-loop run id'],
    'The run journal/status reflects the requested creation, action, or decision.',
  ),
  ...verify(
    [
      'platform_auth_profiles:create',
      'platform_auth_profiles:oauth_initiate',
      'platform_auth_profiles:revoke',
      'platform_auth_profiles:update',
    ],
    'platform_auth_profiles',
    'get',
    ['auth profile id returned or supplied'],
    'The profile status and non-secret metadata reflect the requested transition; OAuth initiation also requires the original authorization result.',
  ),
  ...verify(
    ['platform_auth_profiles:delete'],
    'platform_auth_profiles',
    'list',
    ['deleted auth profile id'],
    'The deleted profile is absent from the project profile list.',
  ),
  ...verify(
    ['platform_auth_profiles:validate'],
    'platform_auth_profiles',
    'get',
    ['auth profile id', 'original non-replayed validation result'],
    'The profile remains readable; live credential validation is proven only by the original confirmed validation result.',
  ),
  ...verify(
    ['platform_integrations:create', 'platform_integrations:update'],
    'platform_integrations',
    'get',
    ['integration id returned or supplied'],
    'The integration read reflects the requested connector/profile binding.',
  ),
  ...verify(
    ['platform_integrations:delete'],
    'platform_integrations',
    'list',
    ['deleted integration id'],
    'The deleted integration is absent from the project integration list.',
  ),
  ...verify(
    ['platform_integrations:test'],
    'platform_integrations',
    'get',
    ['integration id', 'original non-replayed connection test result'],
    'The integration remains readable; external connectivity is proven only by the original confirmed test result.',
  ),
  ...verify(
    ['platform_mcp_servers:create', 'platform_mcp_servers:update'],
    'platform_mcp_servers',
    'get',
    ['MCP server id returned or supplied'],
    'The server read reflects the requested transport and opaque auth-profile references.',
  ),
  ...verify(
    ['platform_mcp_servers:authorize', 'platform_mcp_servers:disconnect'],
    'platform_mcp_servers',
    'grant_status',
    ['MCP server id'],
    'The authorization/grant status reflects the requested connection transition.',
  ),
  ...verify(
    ['platform_mcp_servers:discover_import'],
    'platform_mcp_servers',
    'list_tools',
    ['MCP server id'],
    'The imported server-tool list contains the selected discovered tools.',
  ),
  ...verify(
    ['platform_mcp_servers:test_connection'],
    'platform_mcp_servers',
    'get',
    ['MCP server id', 'original non-replayed connection test result'],
    'The server configuration remains readable; live connectivity is proven only by the original confirmed test result.',
  ),
  ...verify(
    ['platform_mcp_servers:discover_preview'],
    'platform_mcp_servers',
    'get',
    ['MCP server id', 'original non-replayed discovery preview'],
    'The server configuration remains readable; discovered tools are proven only by the original confirmed preview response.',
  ),
  ...verify(
    ['platform_mcp_servers:test_tool'],
    'platform_mcp_servers',
    'list_tools',
    ['MCP server id', 'tool name', 'original non-replayed test result'],
    'The server still exposes the selected tool; execution success is proven only by the original governed test result and must not be inferred from this read.',
  ),
  ...verify(
    ['platform_mcp_servers:delete'],
    'platform_mcp_servers',
    'list',
    ['deleted MCP server id'],
    'The deleted MCP server is absent from the project server list.',
  ),
  ...verify(
    ['platform_agents:save_dsl'],
    'platform_agents',
    'get',
    ['agent id or name'],
    'The agent read returns the saved DSL revision or source hash.',
  ),
  ...verify(
    ['platform_versions:create'],
    'platform_versions',
    'get',
    ['version id returned by create'],
    'The immutable version manifest exists with the expected source hash.',
  ),
  ...verify(
    ['platform_versions:promote', 'platform_versions:publish'],
    'platform_versions',
    'audit',
    ['version id'],
    'The version audit records the requested governed lifecycle transition.',
  ),
  ...verify(
    [
      'platform_deployments:create',
      'platform_deployments:promote',
      'platform_deployments:restore',
      'platform_deployments:retire',
      'platform_deployments:rollback',
    ],
    'platform_deployments',
    'get',
    ['deployment id returned or supplied'],
    'The deployment status/environment/version manifest reflects the requested transition.',
  ),
  ...verify(
    ['platform_sdk_channels:create_key'],
    'platform_sdk_channels',
    'list_keys',
    ['public API key id returned by create_key'],
    'The new public key appears in the project key list.',
  ),
  ...verify(
    ['platform_sdk_channels:create_channel'],
    'platform_sdk_channels',
    'list_channels',
    ['SDK channel id returned by create_channel'],
    'The new channel appears with the requested environment and public-key binding.',
  ),
  ...verify(
    ['platform_tools:create', 'platform_tools:update'],
    'platform_tools',
    'get',
    ['project tool id returned or supplied'],
    'The project tool read reflects the requested definition.',
  ),
  ...verify(
    ['platform_tools:delete'],
    'platform_tools',
    'list',
    ['deleted project tool id'],
    'The deleted tool is absent from the project tool list.',
  ),
  ...verify(
    ['platform_tools:test'],
    'platform_tools',
    'get',
    ['project tool id', 'original non-replayed test result'],
    'The project tool still exists; execution success is proven only by the original governed test result and must not be inferred from this read.',
  ),
  ...verify(
    ['agent_tables:create', 'agent_tables:migrate', 'agent_tables:update'],
    'agent_tables',
    'describe',
    ['table name'],
    'The table schema/metadata reflects the requested definition or migration.',
  ),
  ...verify(
    ['agent_tables:delete'],
    'agent_tables',
    'list',
    ['deleted table name'],
    'The deleted table is absent from the project table list.',
  ),
  ...verify(
    ['agent_tables:insert', 'agent_tables:upsert'],
    'agent_tables',
    'query',
    ['table name', 'inserted unique key or returned row id'],
    'A query returns the inserted/upserted row values.',
  ),
  ...verify(
    ['agent_tables:update_row'],
    'agent_tables',
    'get_row',
    ['table name', 'row id'],
    'The row read returns the updated values and version.',
  ),
  ...verify(
    ['agent_tables:delete_row'],
    'agent_tables',
    'get_row',
    ['table name', 'deleted row id'],
    'The row read returns an authoritative not-found result.',
  ),
  ...verify(
    ['platform_import_export:import'],
    'platform_import_export',
    'export_preview',
    ['target project id', 'accepted import preview digest and expected asset/change manifest'],
    'The post-import export projection matches the accepted preview for every imported asset and dependency; project readability alone is insufficient.',
  ),
  ...assetVerification('platform_eval_personas', ['create', 'generate', 'update']),
  ...assetVerification('platform_eval_scenarios', ['create', 'generate', 'update']),
  ...assetVerification('platform_eval_evaluators', ['create', 'update']),
  ...assetVerification('platform_eval_sets', ['create', 'update']),
  ...verify(
    [
      'platform_eval_runs:cancel',
      'platform_eval_runs:create',
      'platform_eval_runs:quick',
      'platform_eval_runs:start',
      'platform_eval_runs:update',
    ],
    'platform_eval_runs',
    'status',
    ['evaluation run id returned or supplied'],
    'The run status reflects the requested lifecycle transition.',
  ),
  ...verify(
    ['platform_config:update_llm_config'],
    'platform_config',
    'get_llm_config',
    ['project id'],
    'The LLM configuration read reflects the requested update.',
  ),
  ...verify(
    ['platform_config:update_settings'],
    'platform_config',
    'get_settings',
    ['project id'],
    'The project settings read reflects the requested update.',
  ),
  ...verify(
    ['platform_workspaces:switch'],
    'platform_workspaces',
    'current',
    ['target workspace id'],
    'The active workspace matches the requested target.',
  ),
];

export const MUTATION_VERIFICATION_GUIDANCE: Readonly<
  Record<string, OperationVerificationGuidance>
> = buildMutationVerification(mutationEntries);

export function verificationGuidanceForOperation(
  operationId: string,
  safety: OperationSafety,
): OperationVerificationGuidance {
  if (safety !== 'read') {
    const guidance = MUTATION_VERIFICATION_GUIDANCE[operationId];
    if (!guidance) throw new Error(`Missing mutation verification guidance for ${operationId}`);
    return guidance;
  }
  const separator = operationId.lastIndexOf(':');
  return {
    validatesWith: {
      tool: operationId.slice(0, separator),
      action: operationId.slice(separator + 1),
    },
    requiredContext: [],
    expectedEvidence:
      'The read returns an authoritative successful response for its requested scope.',
  };
}

function assetVerification(tool: string, writableActions: readonly string[]): VerificationEntry[] {
  return [
    ...verify(
      writableActions.map((action) => `${tool}:${action}`),
      tool,
      'get',
      ['asset id returned or supplied'],
      'The evaluation asset read reflects the created, generated, or updated definition.',
    ),
    ...verify(
      [`${tool}:delete`],
      tool,
      'list',
      ['deleted asset id'],
      'The deleted evaluation asset is absent from the project list.',
    ),
  ];
}

function verify(
  operationIds: readonly string[],
  tool: string,
  action: string,
  requiredContext: readonly string[],
  expectedEvidence: string,
): VerificationEntry[] {
  return operationIds.map((operationId) => [
    operationId,
    { validatesWith: { tool, action }, requiredContext, expectedEvidence },
  ]);
}

export function buildMutationVerification(
  entries: readonly VerificationEntry[],
): Readonly<Record<string, OperationVerificationGuidance>> {
  const result: Record<string, OperationVerificationGuidance> = {};
  for (const [operationId, guidance] of entries) {
    if (result[operationId]) throw new Error(`Duplicate mutation verification ${operationId}`);
    result[operationId] = guidance;
  }
  return Object.freeze(result);
}
