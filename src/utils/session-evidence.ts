import type {
  AgentDetails,
  AgentState,
  DebugSession,
  TraceEventType,
  TraceEventWithId,
} from "../types.js";
import type { DebugContext } from "../tools/index.js";
import { requestStudioJson } from "./studio-api.js";
import {
  compareTraceEventsChronologically,
  compareTraceEventsRecentFirst,
  isErrorLikeTraceEvent,
  safeStringify,
} from "./trace-formatting.js";

export type EvidenceSource =
  | "memory"
  | "runtime_proxy"
  | "memory+runtime_proxy";

export interface SessionEvidenceOptions {
  sessionId?: string;
  projectId?: string;
  traceLimit?: number;
  types?: string[];
  preferRuntime?: boolean;
  fetchTraces?: boolean;
}

export interface SessionEvidence {
  sessionId: string;
  projectId?: string;
  source: EvidenceSource;
  session?: DebugSession;
  runtimeSession?: JsonRecord;
  agentId?: string;
  agentName?: string;
  agentDetails?: AgentDetails;
  state?: AgentState;
  messages: JsonRecord[];
  events: TraceEventWithId[];
  traceMeta?: JsonRecord;
  traceTotal?: number;
  diagnostics: {
    memorySessionFound: boolean;
    memoryTraceCount: number;
    runtimeSessionFetched: boolean;
    runtimeTraceFetched: boolean;
    warnings: string[];
  };
}

export type SessionEvidenceResult =
  | { ok: true; evidence: SessionEvidence }
  | {
      ok: false;
      sessionId?: string;
      error: string;
      hint?: string;
      diagnostics: SessionEvidence["diagnostics"];
    };

export type JsonRecord = Record<string, unknown>;

export async function loadSessionEvidence(
  ctx: DebugContext,
  options: SessionEvidenceOptions = {},
): Promise<SessionEvidenceResult> {
  const sessionId =
    options.sessionId || ctx.sessionStore.getActiveSessionId() || undefined;
  const diagnostics: SessionEvidence["diagnostics"] = {
    memorySessionFound: false,
    memoryTraceCount: 0,
    runtimeSessionFetched: false,
    runtimeTraceFetched: false,
    warnings: [],
  };

  if (!sessionId) {
    return {
      ok: false,
      error:
        "No session specified and no active session. Load an agent first or provide sessionId.",
      diagnostics,
    };
  }

  const memorySession = ctx.sessionStore.getSession(sessionId);
  diagnostics.memorySessionFound = Boolean(memorySession);

  const memoryEvents = sortEventsChronologically(
    ctx.traceStore.getBySession(
      sessionId,
      undefined,
      options.types as TraceEventType[] | undefined,
    ),
  );
  diagnostics.memoryTraceCount = memoryEvents.length;

  const shouldFetchRuntime =
    Boolean(options.projectId) &&
    (options.preferRuntime === true ||
      !memorySession ||
      memoryEvents.length === 0);

  let runtimeSession: JsonRecord | undefined;
  let runtimeEvents: TraceEventWithId[] = [];
  let traceMeta: JsonRecord | undefined;
  let traceTotal: number | undefined;

  if (shouldFetchRuntime && options.projectId) {
    const sessionResult = await fetchRuntimeSession(
      ctx,
      sessionId,
      options.projectId,
    );
    if (sessionResult.ok) {
      runtimeSession = sessionResult.session;
      diagnostics.runtimeSessionFetched = true;
    } else {
      diagnostics.warnings.push(sessionResult.warning);
    }

    if (options.fetchTraces !== false) {
      const tracesResult = await fetchRuntimeTraces(ctx, {
        sessionId,
        projectId: options.projectId,
        traceLimit: options.traceLimit,
        types: options.types,
      });

      if (tracesResult.ok) {
        runtimeEvents = tracesResult.events;
        traceMeta = tracesResult.traceMeta;
        traceTotal = tracesResult.traceTotal;
        diagnostics.runtimeTraceFetched = true;
      } else {
        diagnostics.warnings.push(tracesResult.warning);
      }
    }
  }

  if (
    !memorySession &&
    !runtimeSession &&
    runtimeEvents.length === 0 &&
    !diagnostics.runtimeTraceFetched
  ) {
    return {
      ok: false,
      sessionId,
      error: `Session not found: ${sessionId}`,
      hint: options.projectId
        ? "The session was not found in MCP memory or the Studio runtime proxy. Verify workspace, projectId, sessionId, and token scope."
        : "This MCP process only has live in-memory sessions unless projectId is provided. Pass projectId to fetch completed Studio/UI sessions from the runtime proxy.",
      diagnostics,
    };
  }

  const usingRuntimeEvents = runtimeEvents.length > 0;
  const events = usingRuntimeEvents ? runtimeEvents : memoryEvents;
  const limitedEvents = applyLimit(events, options.traceLimit);
  const source = pickSource(
    memorySession,
    runtimeSession,
    usingRuntimeEvents,
    diagnostics.runtimeTraceFetched,
  );
  const agentDetails =
    memorySession?.agentDetails || toAgentDetails(runtimeSession);
  const agentName =
    agentDetails?.name ||
    asString(asRecord(runtimeSession?.agent)?.name) ||
    asString(runtimeSession?.agentName) ||
    memorySession?.agentId;
  const state =
    memorySession?.state ||
    (asRecord(runtimeSession?.state) as AgentState | null) ||
    undefined;

  return {
    ok: true,
    evidence: {
      sessionId,
      projectId: options.projectId,
      source,
      session: memorySession,
      runtimeSession,
      agentId: memorySession?.agentId || agentName,
      agentName,
      agentDetails,
      state,
      messages: extractMessages(runtimeSession),
      events: limitedEvents,
      traceMeta,
      traceTotal,
      diagnostics,
    },
  };
}

async function fetchRuntimeSession(
  ctx: DebugContext,
  sessionId: string,
  projectId: string,
): Promise<{ ok: true; session: JsonRecord } | { ok: false; warning: string }> {
  const paths = buildSessionReadPaths(sessionId, projectId, "detail");
  const { result, attemptedPaths } = await requestFirstAvailablePath(
    ctx,
    paths,
    15_000,
  );

  if (!result.ok) {
    return {
      ok: false,
      warning: formatReadFailure(attemptedPaths, result),
    };
  }

  const session = extractSession(result.body);
  if (!session) {
    return {
      ok: false,
      warning: `GET ${attemptedPaths.at(-1)} returned no recognizable session object`,
    };
  }

  return { ok: true, session };
}

async function fetchRuntimeTraces(
  ctx: DebugContext,
  options: Required<Pick<SessionEvidenceOptions, "sessionId" | "projectId">> &
    Pick<SessionEvidenceOptions, "traceLimit" | "types">,
): Promise<
  | {
      ok: true;
      events: TraceEventWithId[];
      traceMeta?: JsonRecord;
      traceTotal?: number;
    }
  | { ok: false; warning: string }
> {
  const paths = buildSessionReadPaths(
    options.sessionId,
    options.projectId,
    "traces",
    options.traceLimit ?? 250,
  );
  const { result, attemptedPaths } = await requestFirstAvailablePath(
    ctx,
    paths,
    30_000,
  );

  if (!result.ok) {
    return {
      ok: false,
      warning: formatReadFailure(attemptedPaths, result),
    };
  }

  const rawEvents = extractTraces(result.body);
  const normalizedEvents = rawEvents
    .map((event, index) => normalizeTraceEvent(event, options.sessionId, index))
    .filter((event): event is TraceEventWithId => event !== null);
  const filteredEvents = options.types?.length
    ? normalizedEvents.filter((event) => options.types!.includes(event.type))
    : normalizedEvents;

  return {
    ok: true,
    events: sortEventsChronologically(filteredEvents),
    traceMeta: extractTraceMeta(result.body) || undefined,
    traceTotal: extractTraceTotal(result.body) ?? undefined,
  };
}

type StudioJsonResult = Awaited<ReturnType<typeof requestStudioJson>>;

function buildSessionReadPaths(
  sessionId: string,
  projectId: string,
  resource: "detail" | "traces",
  traceLimit = 250,
): [string, string] {
  const safeProjectId = encodeURIComponent(projectId);
  const safeSessionId = encodeURIComponent(sessionId);
  const suffix = resource === "traces" ? "/traces" : "";
  const canonicalParams =
    resource === "traces"
      ? new URLSearchParams({ limit: String(traceLimit) })
      : new URLSearchParams({ includeTraces: "false" });
  const proxyParams = new URLSearchParams(canonicalParams);
  proxyParams.set("projectId", projectId);

  return [
    `/api/projects/${safeProjectId}/sessions/${safeSessionId}${suffix}?${canonicalParams.toString()}`,
    `/api/runtime/sessions/${safeSessionId}${suffix}?${proxyParams.toString()}`,
  ];
}

async function requestFirstAvailablePath(
  ctx: DebugContext,
  paths: readonly [string, ...string[]],
  timeoutMs: number,
): Promise<{ result: StudioJsonResult; attemptedPaths: string[] }> {
  const attemptedPaths: string[] = [];
  let result: StudioJsonResult = await requestStudioJson(ctx, {
    method: "GET",
    path: paths[0],
    timeoutMs,
  });
  attemptedPaths.push(paths[0]);
  if (result.ok || result.status !== 404) {
    return { result, attemptedPaths };
  }

  for (const path of paths.slice(1)) {
    attemptedPaths.push(path);
    result = await requestStudioJson(ctx, { method: "GET", path, timeoutMs });
    if (result.ok || result.status !== 404) {
      return { result, attemptedPaths };
    }
  }

  return { result, attemptedPaths };
}

function formatReadFailure(
  attemptedPaths: string[],
  result: Exclude<StudioJsonResult, { ok: true }>,
): string {
  return `GET ${attemptedPaths.join(" then ")} failed: ${result.status} ${result.statusText}`;
}

function normalizeTraceEvent(
  raw: JsonRecord,
  fallbackSessionId: string,
  index: number,
): TraceEventWithId | null {
  const data =
    asRecord(raw.data) ||
    asRecord(raw.payload) ||
    asRecord(raw.eventData) ||
    asRecord(raw.event_data) ||
    parseJsonRecord(raw.data) ||
    parseJsonRecord(raw.payload) ||
    {};
  const type = pickString(
    raw.type,
    raw.event_type,
    data.type,
    data.eventType,
    data._runtime_trace_type,
  );
  if (!type) return null;

  const timestampValue =
    pickString(
      raw.timestamp,
      raw.eventTime,
      raw.event_time,
      raw.createdAt,
      raw.created_at,
      data.timestamp,
      data.eventTime,
      data.event_time,
    ) || new Date().toISOString();
  const timestamp = parseTraceDate(timestampValue) || new Date();
  const eventTime = pickDate(
    raw.eventTime,
    raw.event_time,
    data.eventTime,
    data.event_time,
  );
  const ingestedAt = pickDate(
    raw.ingestedAt,
    raw.ingested_at,
    data.ingestedAt,
    data.ingested_at,
  );
  const eventId = pickString(
    raw.eventId,
    raw.event_id,
    data.eventId,
    data.event_id,
  );

  return {
    id:
      pickString(raw.id, raw._id, eventId, data.id, data._id) ||
      `${fallbackSessionId}:${timestamp.toISOString()}:${type}:${index}`,
    eventId,
    eventSeq: pickNumber(
      raw.eventSeq,
      raw.event_seq,
      data.eventSeq,
      data.event_seq,
    ),
    eventCursor: pickString(
      raw.eventCursor,
      raw.event_cursor,
      data.eventCursor,
      data.event_cursor,
    ),
    eventTime: eventTime || undefined,
    ingestedAt: ingestedAt || undefined,
    sessionId:
      pickString(
        raw.sessionId,
        raw.session_id,
        data.sessionId,
        data.session_id,
      ) || fallbackSessionId,
    type: type as TraceEventType,
    timestamp,
    traceId: pickString(raw.traceId, raw.trace_id, data.traceId, data.trace_id),
    durationMs: pickNumber(
      raw.durationMs,
      raw.duration_ms,
      raw.latencyMs,
      raw.latency_ms,
      data.durationMs,
      data.duration_ms,
      data.latencyMs,
      data.latency_ms,
    ),
    agentName:
      pickString(
        raw.agentName,
        raw.agent_name,
        data.agentName,
        data.agent_name,
        data.agent,
        data.sourceAgent,
        data.fromAgent,
        data.from,
      ) || undefined,
    spanId:
      pickString(raw.spanId, raw.span_id, data.spanId, data.span_id) ||
      undefined,
    parentSpanId:
      pickString(
        raw.parentSpanId,
        raw.parent_span_id,
        data.parentSpanId,
        data.parent_span_id,
      ) || undefined,
    data,
  };
}

export function filterEvidenceEvents(
  events: TraceEventWithId[],
  filter: {
    text?: string;
    types?: string[];
    agentName?: string;
    hasError?: boolean;
  },
): TraceEventWithId[] {
  let filtered = events;

  if (filter.types?.length) {
    filtered = filtered.filter((event) => filter.types!.includes(event.type));
  }

  if (filter.agentName) {
    filtered = filtered.filter((event) => event.agentName === filter.agentName);
  }

  if (filter.text) {
    const text = filter.text.toLowerCase();
    filtered = filtered.filter((event) =>
      safeStringify(event.data).toLowerCase().includes(text),
    );
  }

  if (filter.hasError !== undefined) {
    filtered = filtered.filter((event) =>
      filter.hasError ? isErrorLikeEvent(event) : !isErrorLikeEvent(event),
    );
  }

  return filtered;
}

export function isErrorLikeEvent(event: TraceEventWithId): boolean {
  return isErrorLikeTraceEvent(event);
}

export function evidenceMessage(evidence: SessionEvidence): string | undefined {
  if (evidence.source !== "memory") {
    return `Loaded ${evidence.events.length} persisted trace events via Studio runtime proxy.`;
  }

  if (evidence.events.length === 0 && !evidence.projectId) {
    return "No in-memory trace events found. If this is a completed Studio/UI session, pass projectId to fetch persisted traces.";
  }

  return undefined;
}

export function formatEvidenceDiagnostics(
  evidence: SessionEvidence,
): JsonRecord {
  return {
    source: evidence.source,
    memorySessionFound: evidence.diagnostics.memorySessionFound,
    memoryTraceCount: evidence.diagnostics.memoryTraceCount,
    runtimeSessionFetched: evidence.diagnostics.runtimeSessionFetched,
    runtimeTraceFetched: evidence.diagnostics.runtimeTraceFetched,
    traceMeta: evidence.traceMeta,
    traceTotal: evidence.traceTotal,
    warnings: evidence.diagnostics.warnings,
  };
}

export function sortEventsChronologically(
  events: TraceEventWithId[],
): TraceEventWithId[] {
  return [...events].sort(compareTraceEventsChronologically);
}

export function sortEventsRecentFirst(
  events: TraceEventWithId[],
): TraceEventWithId[] {
  return [...events].sort(compareTraceEventsRecentFirst);
}

export function applyLimit<T>(items: T[], limit?: number): T[] {
  if (!limit || limit <= 0) return items;
  return items.slice(-limit);
}

function pickSource(
  memorySession: DebugSession | undefined,
  runtimeSession: JsonRecord | undefined,
  usingRuntimeEvents: boolean,
  runtimeTraceFetched: boolean,
): EvidenceSource {
  if (memorySession && usingRuntimeEvents) return "memory+runtime_proxy";
  if (
    usingRuntimeEvents ||
    runtimeTraceFetched ||
    (!memorySession && runtimeSession)
  )
    return "runtime_proxy";
  return "memory";
}

function extractSession(body: unknown): JsonRecord | null {
  const root = asRecord(body);
  if (!root) return null;
  const direct = asRecord(root.session);
  if (direct) return direct;
  const data = asRecord(root.data);
  if (!data) return null;
  return asRecord(data.session) || data;
}

function extractTraces(body: unknown): JsonRecord[] {
  const root = asRecord(body);
  if (!root) return [];
  const direct = asRecordArray(root.traces);
  if (direct) return direct;
  const directTraceEvents = asRecordArray(root.traceEvents);
  if (directTraceEvents) return directTraceEvents;
  const directEvents = asRecordArray(root.events);
  if (directEvents) return directEvents;
  const directRows = asRecordArray(root.rows);
  if (directRows) return directRows;
  const directItems = asRecordArray(root.items);
  if (directItems) return directItems;
  const data = asRecord(root.data);
  if (!data) return [];
  return (
    asRecordArray(data.traces) ||
    asRecordArray(data.traceEvents) ||
    asRecordArray(data.events) ||
    asRecordArray(data.rows) ||
    asRecordArray(data.items) ||
    []
  );
}

function extractTraceMeta(body: unknown): JsonRecord | null {
  const root = asRecord(body);
  if (!root) return null;
  const direct = asRecord(root._meta);
  if (direct) return direct;
  const meta = asRecord(root.meta);
  if (meta) return meta;
  const data = asRecord(root.data);
  return asRecord(data?._meta) || asRecord(data?.meta);
}

function extractTraceTotal(body: unknown): number | null {
  const root = asRecord(body);
  if (!root) return null;
  const data = asRecord(root.data);
  return (
    asNumber(root.total) ??
    asNumber(root.count) ??
    asNumber(asRecord(root._meta)?.total) ??
    asNumber(asRecord(root.meta)?.total) ??
    asNumber(data?.total) ??
    asNumber(data?.count) ??
    asNumber(asRecord(data?._meta)?.total) ??
    asNumber(asRecord(data?.meta)?.total)
  );
}

function extractMessages(runtimeSession?: JsonRecord): JsonRecord[] {
  if (!runtimeSession) return [];
  return (
    asRecordArray(runtimeSession.messages) ||
    asRecordArray(runtimeSession.conversation) ||
    []
  );
}

function toAgentDetails(runtimeSession?: JsonRecord): AgentDetails | undefined {
  const agent = asRecord(runtimeSession?.agent);
  const name = asString(agent?.name) || asString(runtimeSession?.agentName);
  if (!agent || !name) return undefined;

  const type = asString(agent.type) === "supervisor" ? "supervisor" : "agent";
  const mode = asString(agent.mode) === "scripted" ? "scripted" : "reasoning";
  const tools = asRecordArray(asRecord(agent.ir)?.tools) || [];
  const gatherFields =
    asRecordArray(asRecord(asRecord(agent.ir)?.gather)?.fields) || [];

  return {
    id: asString(agent.id) || name,
    name,
    domain: asString(agent.domain) || "platform",
    filePath: asString(agent.filePath) || "runtime-proxy",
    type,
    mode,
    toolCount: tools.length,
    gatherFieldCount: gatherFields.length,
    isSupervisor: type === "supervisor",
    dsl: asString(agent.dsl) || "",
    ir: agent.ir,
  };
}

function asRecord(value: unknown): JsonRecord | null {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as JsonRecord;
  }
  return null;
}

function asRecordArray(value: unknown): JsonRecord[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((item): item is JsonRecord => asRecord(item) !== null);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function parseTraceDate(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function pickString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const stringValue = asString(value);
    if (stringValue) return stringValue;
  }
  return undefined;
}

function pickNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const numberValue = asNumber(value);
    if (numberValue !== null) return numberValue;
  }
  return undefined;
}

function pickDate(...values: unknown[]): Date | undefined {
  for (const value of values) {
    if (value instanceof Date && Number.isFinite(value.getTime())) return value;
    const date = parseTraceDate(asString(value));
    if (date) return date;
  }
  return undefined;
}

function parseJsonRecord(value: unknown): JsonRecord | null {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}
