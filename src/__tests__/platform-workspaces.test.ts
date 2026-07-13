import { afterEach, describe, expect, test, vi } from "vitest";
import type { HttpClient } from "../client/http-client.js";
import type { WebSocketClient } from "../client/websocket-client.js";
import { platformWorkspaces } from "../tools/platform-workspaces.js";
import type { DebugContext } from "../tools/index.js";
import {
  readStoredCredentials,
  writeStoredCredentials,
} from "../client/credentials.js";

vi.mock("../client/credentials.js", () => ({
  readStoredCredentials: vi.fn(),
  writeStoredCredentials: vi.fn(),
}));

function createMockContext(connected = true): DebugContext {
  return {
    wsClient: {
      isConnected: vi.fn().mockReturnValue(connected),
      setAuthToken: vi.fn(),
      disconnect: vi.fn(),
      connect: vi.fn().mockResolvedValue(undefined),
    } as unknown as WebSocketClient,
    httpClient: {
      getBaseUrl: vi.fn().mockReturnValue("https://agents-dev.kore.ai"),
      getAuthToken: vi.fn().mockReturnValue("source-token"),
      setAuthToken: vi.fn(),
    } as unknown as HttpClient,
    sessionStore: {} as DebugContext["sessionStore"],
    traceStore: {} as DebugContext["traceStore"],
    authenticate: vi.fn(),
  };
}

describe("platform_workspaces", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  test("reconnects an open debug WebSocket with the selected workspace token", async () => {
    const ctx = createMockContext();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          accessToken: "target-tenant-token",
          tenantId: "target-tenant",
          role: "OWNER",
          expiresIn: 3600,
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = JSON.parse(
      await platformWorkspaces(
        { action: "switch", tenantId: "target-tenant" },
        ctx,
      ),
    ) as Record<string, unknown>;

    expect(result).toMatchObject({ success: true, websocketReconnected: true });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://agents-dev.kore.ai/api/auth/tenants/switch",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ tenantId: "target-tenant" }),
        headers: expect.objectContaining({
          Origin: "https://agents-dev.kore.ai",
        }),
      }),
    );
    expect(ctx.httpClient.setAuthToken).toHaveBeenCalledWith(
      "target-tenant-token",
    );
    expect(ctx.wsClient.setAuthToken).toHaveBeenCalledWith(
      "target-tenant-token",
    );
    expect(ctx.wsClient.disconnect).toHaveBeenCalledOnce();
    expect(ctx.wsClient.connect).toHaveBeenCalledOnce();
    expect(writeStoredCredentials).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "target-tenant-token",
        expiresAt: expect.any(String),
      }),
    );
  });

  test("updates both clients without reconnecting an inactive WebSocket", async () => {
    const ctx = createMockContext(false);
    vi.mocked(readStoredCredentials).mockReturnValue({
      token: "source-token",
      refreshToken: "refresh-token",
      expiresAt: "2099-01-01T00:00:00.000Z",
      email: "developer@example.com",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            accessToken: "target-tenant-token",
            tenantId: "target-tenant",
            role: "ADMIN",
          }),
          { status: 200 },
        ),
      ),
    );

    const result = JSON.parse(
      await platformWorkspaces(
        { action: "switch", tenantId: "target-tenant" },
        ctx,
      ),
    ) as Record<string, unknown>;

    expect(result).toMatchObject({
      success: true,
      websocketReconnected: false,
    });
    expect(ctx.wsClient.disconnect).not.toHaveBeenCalled();
    expect(ctx.wsClient.connect).not.toHaveBeenCalled();
    expect(writeStoredCredentials).toHaveBeenCalledWith({
      token: "target-tenant-token",
      refreshToken: "refresh-token",
      expiresAt: "2099-01-01T00:00:00.000Z",
      email: "developer@example.com",
    });
  });

  test("rejects a successful response scoped to a different workspace", async () => {
    const ctx = createMockContext();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            accessToken: makeJwt({ tenantId: "other-tenant" }),
            tenantId: "target-tenant",
            role: "OWNER",
          }),
          { status: 200 },
        ),
      ),
    );

    const result = JSON.parse(
      await platformWorkspaces(
        { action: "switch", tenantId: "target-tenant" },
        ctx,
      ),
    ) as Record<string, unknown>;

    expect(result).toMatchObject({ success: false });
    expect(String(result.error)).toContain("other-tenant");
    expect(ctx.httpClient.setAuthToken).not.toHaveBeenCalled();
    expect(ctx.wsClient.setAuthToken).not.toHaveBeenCalled();
  });

  test("keeps the switched workspace active when credential persistence fails", async () => {
    const ctx = createMockContext();
    vi.mocked(writeStoredCredentials).mockImplementation(() => {
      throw new Error("credential file is read-only");
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            accessToken: "target-tenant-token",
            tenantId: "target-tenant",
            role: "OWNER",
            expiresIn: 3600,
          }),
          { status: 200 },
        ),
      ),
    );

    const result = JSON.parse(
      await platformWorkspaces(
        { action: "switch", tenantId: "target-tenant" },
        ctx,
      ),
    ) as Record<string, unknown>;

    expect(result).toMatchObject({
      success: true,
      credentialPersisted: false,
      websocketReconnected: true,
    });
    expect(String(result.warning)).toContain("credential file is read-only");
    expect(ctx.wsClient.connect).toHaveBeenCalledOnce();
  });
});

function makeJwt(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString(
      "base64url",
    ),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "signature",
  ].join(".");
}
