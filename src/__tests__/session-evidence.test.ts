import { beforeEach, describe, expect, test, vi } from "vitest";
import { SessionStore } from "../store/session-store.js";
import { TraceStore } from "../store/trace-store.js";
import type { DebugContext } from "../tools/index.js";
import { loadSessionEvidence } from "../utils/session-evidence.js";
import { requestStudioJson } from "../utils/studio-api.js";

vi.mock("../utils/studio-api.js", async () => {
  const actual = await vi.importActual<typeof import("../utils/studio-api.js")>(
    "../utils/studio-api.js",
  );
  return {
    ...actual,
    requestStudioJson: vi.fn(),
  };
});

const requestStudioJsonMock = vi.mocked(requestStudioJson);

function makeContext(): DebugContext {
  return {
    sessionStore: new SessionStore(),
    traceStore: new TraceStore(),
    wsClient: { isConnected: () => false },
    httpClient: {},
    authenticate: async () => ({ status: "authenticated" }),
  } as unknown as DebugContext;
}

describe("session evidence", () => {
  beforeEach(() => {
    requestStudioJsonMock.mockReset();
  });

  test("preserves persisted runtime trace identifiers and tolerates invalid timestamps", async () => {
    requestStudioJsonMock
      .mockResolvedValueOnce({
        ok: true,
        body: {
          data: { session: { id: "session-1", agentName: "SupportAgent" } },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        body: {
          data: {
            events: [
              {
                event_id: "runtime-event-1",
                event_seq: "42",
                event_cursor: "cursor-42",
                trace_id: "trace-1",
                span_id: "span-1",
                parent_span_id: "parent-span-1",
                event_type: "llm_sdk_error",
                timestamp: "not-a-date",
                payload: JSON.stringify({
                  provider: "openai",
                  agent_name: "SupportAgent",
                  sdkError: { message: "Provider rejected the request" },
                }),
              },
            ],
          },
          meta: { total: "1" },
        },
      });

    const evidenceResult = await loadSessionEvidence(makeContext(), {
      sessionId: "session-1",
      projectId: "project-1",
      preferRuntime: true,
    });

    expect(evidenceResult.ok).toBe(true);
    if (!evidenceResult.ok) return;

    expect(evidenceResult.evidence.source).toBe("runtime_proxy");
    expect(evidenceResult.evidence.events[0]).toMatchObject({
      id: "runtime-event-1",
      eventId: "runtime-event-1",
      eventSeq: 42,
      eventCursor: "cursor-42",
      traceId: "trace-1",
      spanId: "span-1",
      parentSpanId: "parent-span-1",
      type: "llm_sdk_error",
      agentName: "SupportAgent",
    });
    expect(evidenceResult.evidence.traceTotal).toBe(1);
    expect(
      Number.isFinite(evidenceResult.evidence.events[0].timestamp.getTime()),
    ).toBe(true);
  });

  test("loads persisted traces even when session metadata endpoint fails", async () => {
    requestStudioJsonMock
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: "Not Found",
        body: { error: "session missing" },
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: "Not Found",
        body: { error: "session missing" },
      })
      .mockResolvedValueOnce({
        ok: true,
        body: {
          traces: [
            {
              id: "trace-row-1",
              event_type: "llm_request_built",
              session_id: "session-1",
              trace_id: "trace-1",
              span_id: "span-1",
              timestamp: "2026-06-02T07:41:00.000Z",
              data: { provider: "openai" },
            },
          ],
        },
      });

    const evidenceResult = await loadSessionEvidence(makeContext(), {
      sessionId: "session-1",
      projectId: "project-1",
      preferRuntime: true,
    });

    expect(evidenceResult.ok).toBe(true);
    if (!evidenceResult.ok) return;

    expect(evidenceResult.evidence.source).toBe("runtime_proxy");
    expect(evidenceResult.evidence.diagnostics.runtimeSessionFetched).toBe(
      false,
    );
    expect(evidenceResult.evidence.diagnostics.runtimeTraceFetched).toBe(true);
    expect(evidenceResult.evidence.diagnostics.warnings[0]).toContain("404");
    expect(evidenceResult.evidence.events[0]).toMatchObject({
      id: "trace-row-1",
      type: "llm_request_built",
      sessionId: "session-1",
      traceId: "trace-1",
      spanId: "span-1",
    });
  });

  test("falls back to Studio compatibility routes when canonical session APIs are unavailable", async () => {
    requestStudioJsonMock
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: "Not Found",
        body: { error: "route unavailable" },
      })
      .mockResolvedValueOnce({
        ok: true,
        body: { session: { id: "session/1", agentName: "SupportAgent" } },
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: "Not Found",
        body: { error: "route unavailable" },
      })
      .mockResolvedValueOnce({
        ok: true,
        body: {
          traces: [
            {
              id: "trace-1",
              type: "agent_response",
              sessionId: "session/1",
              timestamp: "2026-06-02T07:41:00.000Z",
              data: {},
            },
          ],
        },
      });

    const evidenceResult = await loadSessionEvidence(makeContext(), {
      sessionId: "session/1",
      projectId: "project/1",
      preferRuntime: true,
    });

    expect(evidenceResult.ok).toBe(true);
    expect(
      requestStudioJsonMock.mock.calls.map((call) => call[1].path),
    ).toEqual([
      "/api/projects/project%2F1/sessions/session%2F1?includeTraces=false",
      "/api/runtime/sessions/session%2F1?includeTraces=false&projectId=project%2F1",
      "/api/projects/project%2F1/sessions/session%2F1/traces?limit=250",
      "/api/runtime/sessions/session%2F1/traces?limit=250&projectId=project%2F1",
    ]);
  });

  test("reports memory source when runtime trace fetch fails and memory traces are used", async () => {
    const ctx = makeContext();
    ctx.sessionStore.createSession("session-1", "SupportAgent");
    ctx.traceStore.addEvent({
      id: "memory-event-1",
      sessionId: "session-1",
      type: "llm_request_built",
      timestamp: new Date("2026-06-02T07:41:00.000Z"),
      data: { provider: "openai" },
    });

    requestStudioJsonMock
      .mockResolvedValueOnce({
        ok: true,
        body: {
          data: { session: { id: "session-1", agentName: "SupportAgent" } },
        },
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        body: { error: "trace fetch failed" },
      });

    const evidenceResult = await loadSessionEvidence(ctx, {
      sessionId: "session-1",
      projectId: "project-1",
      preferRuntime: true,
    });

    expect(evidenceResult.ok).toBe(true);
    if (!evidenceResult.ok) return;

    expect(evidenceResult.evidence.source).toBe("memory");
    expect(evidenceResult.evidence.events).toHaveLength(1);
    expect(evidenceResult.evidence.diagnostics.runtimeSessionFetched).toBe(
      true,
    );
    expect(evidenceResult.evidence.diagnostics.runtimeTraceFetched).toBe(false);
    expect(evidenceResult.evidence.diagnostics.warnings[0]).toContain("500");
  });

  test("accepts an authorized historical session with no trace events", async () => {
    requestStudioJsonMock
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: "Not Found",
        body: { error: "detail route unavailable" },
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: "Not Found",
        body: { error: "detail route unavailable" },
      })
      .mockResolvedValueOnce({
        ok: true,
        body: { success: true, total: 0, traces: [] },
      });

    const evidenceResult = await loadSessionEvidence(makeContext(), {
      sessionId: "session-empty",
      projectId: "project-1",
      preferRuntime: true,
    });

    expect(evidenceResult.ok).toBe(true);
    if (!evidenceResult.ok) return;
    expect(evidenceResult.evidence.source).toBe("runtime_proxy");
    expect(evidenceResult.evidence.events).toEqual([]);
    expect(evidenceResult.evidence.diagnostics.runtimeTraceFetched).toBe(true);
  });
});
