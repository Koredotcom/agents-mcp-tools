/**
 * Type definitions for the Arch MCP server
 */

// =============================================================================
// TRACE EVENT TYPES
// Inlined from @agent-platform/observatory for standalone publishability.
// Canonical source: packages/observatory/src/schema/trace-events.ts
// =============================================================================

type CoreTraceEventType =
  | 'llm_call'
  | 'tool_call'
  | 'decision'
  | 'constraint_check'
  | 'handoff'
  | 'escalation'
  | 'error';

type SessionTraceEventType =
  | 'session_start'
  | 'session_end'
  | 'session_ended'
  | 'session_created'
  | 'session_updated'
  | 'session_resolution'
  | 'user_message'
  | 'agent_response';

type AgentTraceEventType =
  | 'agent_enter'
  | 'agent_exit'
  | 'agent_lifecycle'
  | 'agent_switch'
  | 'profile_resolution'
  | 'agent_error_handled'
  | 'behavior_profile_applied'
  | 'hook_executed'
  | 'escalation_triggered'
  | 'escalation_resolved'
  | 'itsm_ticket_created';

type FlowTraceEventType =
  | 'flow_step_enter'
  | 'flow_step_exit'
  | 'flow_transition'
  | 'step_thought'
  | 'action_handler_executed';

type DelegationTraceEventType = 'delegate_start' | 'delegate_complete';

type DSLTraceEventType =
  | 'dsl_collect'
  | 'dsl_prompt'
  | 'dsl_respond'
  | 'dsl_set'
  | 'dsl_on_input'
  | 'dsl_call'
  | 'dsl_on_start'
  | 'dsl_await_attachment';

type EngineTraceEventType =
  | 'completion_check'
  | 'engine_decision'
  | 'handoff_condition_check'
  | 'thread_return'
  | 'data_stored'
  | 'digression'
  | 'sub_intent'
  | 'correction'
  | 'correction_invalidation'
  | 'constraint_violation'
  | 'validation_fail_open'
  | 'pipeline_intent_bridge'
  | 'pipeline_tiered_action'
  | 'pipeline_out_of_scope_decline'
  | 'warning';

type ToolTraceEventType =
  | 'tool.resolution.start'
  | 'tool.resolution.complete'
  | 'tool.compilation.per_tool'
  | 'tool.compilation.complete'
  | 'tool.compilation.timeout'
  | 'tool.validation.pass'
  | 'tool.validation.fail'
  | 'tool.stale.detected'
  | 'tool_thought'
  | 'tool_error'
  | 'tool_result'
  | 'tool_call_start'
  | 'tool_call_error'
  | 'tool_call_retry'
  | 'tool_auth_resolved';

type ExtractionTraceEventType =
  | 'entity_extraction'
  | 'gather_extraction'
  | 'extraction_tier_selected'
  | 'extraction_attempt'
  | 'extraction_fallback'
  | 'extraction_strategy_resolved'
  | 'extraction_parse_fallback'
  | 'memory_trigger_evaluated'
  | 'memory_recall_result'
  | 'memory_unavailable'
  | 'preference_detected'
  | 'constraint_backtrack'
  | 'constraint_backtrack_limit'
  | 'constraint_directive'
  | 'constraint_mini_collect'
  | 'gather_field_activation'
  | 'gather_complete_reason'
  | 'inference_requested'
  | 'inference_result'
  | 'inference_confirmation_requested'
  | 'inference_accepted'
  | 'inference_rejected'
  | 'lookup_match'
  | 'lookup_fuzzy_confirmation_requested'
  | 'lookup_fuzzy_accepted'
  | 'lookup_fuzzy_rejected'
  | 'multi_intent_queue_accepted'
  | 'multi_intent_queue_declined'
  | 'multi_intent_queue_surfaced'
  | 'multi_intent_disambiguate_requested'
  | 'multi_intent_disambiguate_choice'
  | 'validation_max_retries';

type FanOutTraceEventType =
  | 'fan_out_start'
  | 'fan_out_task_start'
  | 'fan_out_task_complete'
  | 'fan_out_complete'
  | 'fan_out_child_created'
  | 'fan_out_child_completed';

type GuardrailTraceEventType =
  | 'guardrail_check'
  | 'guardrail_violation'
  | 'guardrail_warning'
  | 'guardrail_fix'
  | 'guardrail_reask'
  | 'guardrail_pipeline_complete'
  | 'guardrail_cost'
  | 'guardrail_circuit_breaker'
  | 'guardrail_cache_hit'
  | 'guardrail_cache_miss'
  | 'guardrail_provider_error'
  | 'guardrail_tool_blocked'
  | 'guardrail_tool_output_blocked'
  | 'guardrail_handoff_blocked'
  | 'guardrail_pipeline_error'
  | 'guardrail_input_blocked'
  | 'guardrail_output_blocked';

type AttachmentTraceEventType =
  | 'attachment_upload'
  | 'attachment_scan'
  | 'attachment_process'
  | 'attachment_index'
  | 'attachment_delete'
  | 'attachment_preprocess'
  | 'attachment_preprocess_start'
  | 'attachment_direct_file_decision';

type SuspensionTraceEventType =
  | 'execution_suspended'
  | 'execution_resumed'
  | 'execution_resume_failed'
  | 'callback_received'
  | 'callback_claimed'
  | 'callback_expired'
  | 'barrier_branch_completed'
  | 'barrier_all_complete';

type VoiceTraceEventType =
  | 'voice_session_start'
  | 'voice_session_end'
  | 'voice_turn'
  | 'voice_turn_start'
  | 'voice_turn_end'
  | 'voice_stt'
  | 'voice_llm'
  | 'voice_tts'
  | 'voice_tts_quality'
  | 'voice_asr_quality'
  | 'voice_asr_cascade'
  | 'voice_external_api'
  | 'voice_barge_in'
  | 'voice_silence_detected'
  | 'voice_realtime_turn_start'
  | 'voice_realtime_turn_end'
  | 'voice_realtime_tool_call'
  | 'voice_realtime_connection'
  | 'voice_realtime_interruption';

type ChannelTraceEventType = 'channel_response_sent';
type A2ATraceEventType = 'handoff_progress';
type AnalyticsTraceEventType = 'output_item_analytics_capture';
type StatusTraceEventType = 'status_update' | 'status_clear';
type SpanTraceEventType = 'span_end';
type MemoryTraceEventType =
  | 'memory_init'
  | 'memory_remember'
  | 'memory_recall'
  | 'memory_error'
  | 'memory_preferences'
  | 'memory_dedup_skipped'
  | 'memory_trigger_evaluated'
  | 'memory_recall_result'
  | 'memory_unavailable'
  | 'preference_detected';
type ErrorHandlerTraceEventType = 'error_handler_resolved' | 'error_handler_response';

export type TraceEventType =
  | CoreTraceEventType
  | SessionTraceEventType
  | AgentTraceEventType
  | FlowTraceEventType
  | DelegationTraceEventType
  | DSLTraceEventType
  | EngineTraceEventType
  | ToolTraceEventType
  | ExtractionTraceEventType
  | FanOutTraceEventType
  | GuardrailTraceEventType
  | AttachmentTraceEventType
  | SuspensionTraceEventType
  | VoiceTraceEventType
  | ChannelTraceEventType
  | A2ATraceEventType
  | AnalyticsTraceEventType
  | StatusTraceEventType
  | SpanTraceEventType
  | MemoryTraceEventType
  | ErrorHandlerTraceEventType;

export interface TraceEvent {
  type: TraceEventType;
  timestamp: Date;
  durationMs?: number;
  data: Record<string, unknown>;
  agentName?: string;
  spanId?: string;
  parentSpanId?: string;
}

export interface TraceEventWithId extends TraceEvent {
  id: string;
  sessionId: string;
}

// =============================================================================
// DECISION LOG
// =============================================================================

export interface DecisionLogEntry {
  turn: number;
  timestamp: number;
  type: string;
  outcome: string;
  condition?: string;
  matched: boolean;
  trigger?: Record<string, unknown>;
  candidates?: string[];
  selectedReason?: string;
  field?: string;
  violation?: string;
  oldValue?: unknown;
  newValue?: unknown;
  source?: string;
}

// =============================================================================
// AGENT STATE
// =============================================================================

export interface AgentState {
  context: Record<string, unknown>;
  conversationPhase: string;
  gatherProgress: Record<string, unknown>;
  constraintResults: Record<string, boolean>;
  lastToolResults: Record<string, unknown>;
  memory: {
    session: Record<string, unknown>;
    persistentCache: Record<string, unknown>;
    pendingRemembers: unknown[];
  };
  flowState?: {
    currentStep: string;
    stepHistory: string[];
    stepResults: Record<string, unknown>;
    isComplete: boolean;
  };
  errorState?: {
    type: string;
    message: string;
    stack?: string;
    retryCount: number;
  };
  decisionLog?: DecisionLogEntry[];
}

// =============================================================================
// AGENT INFO
// =============================================================================

export interface AgentInfo {
  id: string;
  name: string;
  domain: string;
  filePath: string;
  type: 'agent' | 'supervisor';
  mode: 'reasoning' | 'scripted';
  toolCount: number;
  gatherFieldCount: number;
  isSupervisor: boolean;
}

export interface AgentDetails extends AgentInfo {
  dsl: string;
  ir?: unknown;
  errors?: string[];
  suggestedTests?: TestCase[];
}

export interface TestCase {
  id: string;
  name: string;
  description: string;
  category: 'happy_path' | 'edge_case' | 'constraint' | 'handoff' | 'error';
  inputs: string[];
  expectations?: TestExpectation[];
}

export interface TestExpectation {
  type: 'action' | 'response_contains' | 'state_contains' | 'trace_event';
  value: string;
}

// =============================================================================
// CONSTRUCT ACTIONS
// =============================================================================

export type ConstructAction =
  | { type: 'continue'; data?: Record<string, unknown> }
  | { type: 'respond'; message: string; continueProcessing?: boolean }
  | {
      type: 'escalate';
      reason: string;
      priority: 'low' | 'medium' | 'high' | 'critical';
      context?: Record<string, unknown>;
    }
  | {
      type: 'handoff';
      target: string;
      context: Record<string, unknown>;
      returnExpected: boolean;
      summary?: string;
    }
  | { type: 'delegate'; agent: string; input: Record<string, unknown>; useResult: string }
  | { type: 'complete'; message?: string; store?: Record<string, unknown> }
  | { type: 'retry'; delay: number; target?: string }
  | { type: 'block'; reason: string; constraint?: string }
  | { type: 'collect'; fields: string[]; prompts: Record<string, string> };

// =============================================================================
// WEBSOCKET MESSAGES
// =============================================================================

export type ClientMessage =
  | { type: 'load_agent'; agentPath: string; projectId: string }
  | { type: 'send_message'; sessionId: string; text: string }
  | { type: 'run_test'; sessionId: string; testId: string }
  | { type: 'get_state'; sessionId: string }
  // Trace subscription (for external observers)
  | { type: 'subscribe_session'; sessionId: string }
  | { type: 'unsubscribe_session'; sessionId: string }
  | { type: 'list_sessions' };

export type ServerMessage =
  | { type: 'agent_loaded'; sessionId: string; agent: AgentDetails }
  | { type: 'agent_load_error'; error: string }
  | { type: 'response_start'; sessionId: string; messageId: string }
  | { type: 'response_chunk'; sessionId: string; messageId: string; chunk: string }
  | { type: 'response_end'; sessionId: string; messageId: string; fullText: string }
  | { type: 'trace_event'; sessionId: string; event: TraceEventWithId }
  | { type: 'state_update'; sessionId: string; state: AgentState; updates: Partial<AgentState> }
  | { type: 'action_taken'; sessionId: string; action: ConstructAction }
  | { type: 'error'; message: string }
  | { type: 'info'; message: string; configured: boolean }
  // Trace subscription responses
  | { type: 'trace_replay'; sessionId: string; events: TraceEventWithId[]; totalBuffered: number }
  | { type: 'subscribed'; sessionId: string; eventCount: number }
  | { type: 'unsubscribed'; sessionId: string }
  | { type: 'session_list'; sessions: SessionInfo[] }
  | { type: 'session_ended'; sessionId: string }
  | { type: 'session_expired'; sessionId: string; reason: string };

// =============================================================================
// SESSION
// =============================================================================

export interface DebugSession {
  id: string;
  agentId: string;
  agentDetails?: AgentDetails;
  state?: AgentState;
  createdAt: Date;
  lastActivityAt: Date;
}

export interface SessionInfo {
  sessionId: string;
  agentName?: string;
  eventCount: number;
  lastActivity: Date;
}

// =============================================================================
// SPAN TREE
// =============================================================================

export interface SpanNode {
  id: string;
  name: string;
  type: TraceEventType;
  startTime: Date;
  endTime?: Date;
  durationMs?: number;
  data: Record<string, unknown>;
  children: SpanNode[];
  parentId?: string;
}

// =============================================================================
// SEARCH FILTERS
// =============================================================================

export interface TraceSearchFilter {
  types?: TraceEventType[];
  agentName?: string;
  startTime?: Date;
  endTime?: Date;
  text?: string;
  hasError?: boolean;
}

// =============================================================================
// HTTP API RESPONSES
// =============================================================================

export interface AgentsResponse {
  success: boolean;
  total: number;
  domains: string[];
  agents: Record<string, AgentInfo[]>;
}

// =============================================================================
// HISTORICAL SESSION READS
// =============================================================================

export type HistoryListSortField =
  | 'id'
  | 'agentName'
  | 'createdAt'
  | 'lastActivityAt'
  | 'messageCount'
  | 'traceEventCount'
  | 'errorCount'
  | 'tokenCount'
  | 'estimatedCost'
  | 'status'
  | 'environment'
  | 'channel';

export interface HistoryListArgs {
  action: 'list';
  projectId: string;
  limit?: number;
  offset?: number;
  status?: string[];
  channel?: string[];
  agentName?: string[];
  environment?: string[];
  disposition?: string;
  outcome?: string;
  q?: string;
  mine?: boolean;
  from?: string;
  to?: string;
  range?: string;
  sortBy?: HistoryListSortField;
  sortDir?: 'asc' | 'desc';
}

export interface HistoryGetArgs {
  action: 'get';
  projectId: string;
  sessionId: string;
  limit?: number;
  offset?: number;
  types?: string[];
  eventType?: string;
  spanId?: string;
}

export type HistoryArgs = HistoryListArgs | HistoryGetArgs;
export type HistoryRecord = Record<string, unknown>;

export interface HistoryDiagnostic extends HistoryRecord {
  source: string;
  code: string;
  message: string;
}

export interface HistoryTraceMeta extends HistoryRecord {
  source: string;
  event_count: number;
  loaded_count?: number;
  available_count?: number;
  is_truncated: boolean;
  source_chain: string[];
  warnings?: HistoryDiagnostic[];
  errors?: HistoryDiagnostic[];
}

export interface HistoryListResponse extends HistoryRecord {
  success: true;
  total: number;
  offset: number;
  limit: number;
  sessions: HistoryRecord[];
}

export interface HistoryGetResponse extends HistoryRecord {
  success: true;
  total: number;
  offset: number;
  limit: number;
  traces: HistoryRecord[];
  _meta: HistoryTraceMeta;
}

export interface HistoryErrorEnvelope extends HistoryRecord {
  success: false;
  error: {
    status?: number;
    code: string;
    message: string;
  };
}

export interface McpToolResult<T extends object = object> {
  readonly content: readonly [{ readonly type: 'text'; readonly text: string }];
  readonly structuredContent: T;
  readonly isError?: boolean;
}

export type HistorySuccessEnvelope = HistoryListResponse | HistoryGetResponse;
export type HistoryEnvelope = HistorySuccessEnvelope | HistoryErrorEnvelope;
export type HistoryToolResult = McpToolResult<HistoryEnvelope>;
