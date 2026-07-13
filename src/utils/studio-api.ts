import type { DebugContext } from "../tools/index.js";
import { sanitizeResponse } from "./sanitize.js";
import { fetchWithTimeout } from "./fetch.js";
import { isRemoteUrl } from "./url.js";

const DEFAULT_STUDIO_PORT = 5173;

export function deriveStudioUrl(runtimeBaseUrl: string): string {
  try {
    const url = new URL(runtimeBaseUrl);
    if (
      !isRemoteUrl(runtimeBaseUrl) &&
      url.port &&
      url.port !== "443" &&
      url.port !== "80"
    ) {
      url.port = String(DEFAULT_STUDIO_PORT);
    }
    return url.origin;
  } catch {
    return runtimeBaseUrl;
  }
}

export function buildStudioHeaders(
  ctx: DebugContext,
  studioBase?: string,
): Record<string, string> {
  const resolvedStudioBase =
    studioBase ?? deriveStudioUrl(ctx.httpClient.getBaseUrl());
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Origin: resolvedStudioBase,
  };
  const token = ctx.httpClient.getAuthToken();
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return headers;
}

export async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => "");
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export async function postStudioJson(
  ctx: DebugContext,
  path: string,
  body: unknown,
  timeoutMs = 30_000,
): Promise<
  | { ok: true; body: unknown }
  | { ok: false; status: number; statusText: string; body: unknown }
> {
  return requestStudioJson(ctx, { method: "POST", path, body, timeoutMs });
}

export async function requestStudioJson(
  ctx: DebugContext,
  input: {
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
    path: string;
    body?: unknown;
    timeoutMs?: number;
  },
): Promise<
  | { ok: true; body: unknown }
  | { ok: false; status: number; statusText: string; body: unknown }
> {
  const studioBase = deriveStudioUrl(ctx.httpClient.getBaseUrl());
  const headers = buildStudioHeaders(ctx, studioBase);
  const init: RequestInit = {
    method: input.method,
    headers,
  };
  if (input.body !== undefined) {
    init.body = JSON.stringify(input.body);
  }

  const response = await fetchWithTimeout(
    `${studioBase}${input.path}`,
    init,
    input.timeoutMs ?? 30_000,
  );
  const responseBody = sanitizeResponse(await readResponseBody(response));

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      statusText: response.statusText,
      body: responseBody,
    };
  }

  return { ok: true, body: responseBody };
}

export function formatStudioFailure(
  path: string,
  result: { status: number; statusText: string; body: unknown },
  method = "POST",
): string {
  return JSON.stringify(
    {
      success: false,
      error: `${method} ${path} failed: ${result.status} ${result.statusText}`,
      status: result.status,
      statusText: result.statusText,
      body: result.body,
      hint:
        result.status === 404
          ? "The connected Studio API may be older than this MCP tool. Update the platform or use debug_docs for the server-owned import contract."
          : undefined,
    },
    null,
    2,
  );
}
