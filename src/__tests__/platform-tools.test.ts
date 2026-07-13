import { beforeEach, describe, expect, it, vi } from "vitest";
import { platformTools } from "../tools/platform-tools.js";
import type { DebugContext } from "../tools/index.js";
import { fetchWithTimeout } from "../utils/fetch.js";

vi.mock("../utils/fetch.js", () => ({
  fetchWithTimeout: vi.fn(),
}));

const fetchMock = vi.mocked(fetchWithTimeout);

beforeEach(() => {
  fetchMock.mockReset();
});

describe("platformTools", () => {
  it("keeps remote Studio requests on the connected origin", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ tools: [] }));

    const ctx = {
      httpClient: {
        getBaseUrl: () => "https://agents-dev.kore.ai",
        getAuthToken: () => "token-123",
      },
    } as unknown as DebugContext;

    const result = JSON.parse(
      await platformTools({ action: "list", projectId: "proj_123" }, ctx),
    ) as { success: boolean; data: { tools: unknown[] } };

    expect(result).toEqual({ success: true, data: { tools: [] } });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://agents-dev.kore.ai/api/projects/proj_123/tools",
      {
        headers: {
          Authorization: "Bearer token-123",
          "Content-Type": "application/json",
          Origin: "https://agents-dev.kore.ai",
        },
      },
      10_000,
    );
  });

  it("rewrites local runtime requests to the local Studio port", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ tools: [] }));

    const ctx = {
      httpClient: {
        getBaseUrl: () => "http://localhost:3112",
        getAuthToken: () => "token-123",
      },
    } as unknown as DebugContext;

    await platformTools({ action: "list", projectId: "proj_123" }, ctx);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:5173/api/projects/proj_123/tools",
      expect.any(Object),
      10_000,
    );
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    statusText: "OK",
    headers: { "Content-Type": "application/json" },
  });
}
