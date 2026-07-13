/**
 * Auth Client
 *
 * Implements the authentication cascade for Arch MCP tools:
 *   1. Explicit token (if provided)
 *   2. Stored credentials (~/.config/kore-platform/credentials)
 *   3. Device authorization flow (RFC 8628)
 *      - Auto-launches browser
 *      - Polls in a single call (no two-phase handshake)
 *      - Persists credentials on success
 */

import type { HttpClient } from "./http-client.js";
import type { WebSocketClient } from "./websocket-client.js";
import {
  readStoredCredentials,
  hasValidToken,
  hasRefreshToken,
  writeStoredCredentials,
} from "./credentials.js";
import { fetchWithTimeout } from "../utils/fetch.js";
import { execFile } from "node:child_process";
import { ARCH_MCP_LOG_PREFIX } from "../tools/persona.js";

export interface AuthResult {
  token: string;
  method:
    | "explicit_token"
    | "stored_credentials"
    | "device_auth"
    | "device_auth_pending";
  message?: string;
  /** Present when method is 'device_auth_pending' — pass back to complete auth */
  deviceCode?: string;
  /** Verification URL for the user to visit */
  verificationUrl?: string;
  /** User-friendly code to display */
  userCode?: string;
  /** Refresh token returned by device auth; persisted but never exposed by tools. */
  refreshToken?: string;
  /** Access-token lifetime returned by the auth server. */
  expiresIn?: number;
}

export interface AuthOptions {
  /** Explicit token to use directly */
  authToken?: string;
  /** Skip stored credentials check */
  skipStoredCredentials?: boolean;
  /** Device code from a previous initiation — skip straight to polling */
  deviceCode?: string;
  /** Max time to poll for device auth completion (default: 60s) */
  pollTimeoutMs?: number;
}

/** Set token on both HTTP and WS clients. */
function setTokenOnClients(
  httpClient: HttpClient,
  wsClient: WebSocketClient,
  token: string,
): void {
  httpClient.setAuthToken(token);
  wsClient.setAuthToken(token);
}

/**
 * Authenticate using the cascade:
 *   explicit token → stored credentials → device auth
 *
 * Sets the token on both HTTP and WS clients on success.
 */
export async function authenticate(
  httpClient: HttpClient,
  wsClient: WebSocketClient,
  options: AuthOptions = {},
): Promise<AuthResult> {
  const baseUrl = httpClient.getBaseUrl();

  // 1. Explicit token
  if (options.authToken) {
    setTokenOnClients(httpClient, wsClient, options.authToken);
    return { token: options.authToken, method: "explicit_token" };
  }

  // 2. Stored credentials
  if (!options.skipStoredCredentials) {
    const result = await tryStoredCredentials(httpClient, wsClient, baseUrl);
    if (result) return result;
  }

  // 3. Device auth — if deviceCode provided, poll for completion; otherwise full flow
  if (options.deviceCode) {
    const result = await pollDeviceAuth(
      httpClient,
      wsClient,
      baseUrl,
      options.deviceCode,
      options.pollTimeoutMs,
    );
    persistTokenIfPossible(result);
    return result;
  }

  // Full device auth: initiate → open browser → poll → persist
  return await deviceAuthFlow(
    httpClient,
    wsClient,
    baseUrl,
    options.pollTimeoutMs,
  );
}

/**
 * Try to use stored credentials from ~/.kore-platform/credentials.
 */
async function tryStoredCredentials(
  httpClient: HttpClient,
  wsClient: WebSocketClient,
  baseUrl: string,
): Promise<AuthResult | null> {
  try {
    const creds = readStoredCredentials();
    if (!creds) return null;

    // If token is still valid, use it directly
    if (hasValidToken(creds)) {
      setTokenOnClients(httpClient, wsClient, creds.token);
      console.error(`${ARCH_MCP_LOG_PREFIX} Using stored credentials`);
      return { token: creds.token, method: "stored_credentials" };
    }

    // If expired but has refresh token, try to refresh
    if (hasRefreshToken(creds) && creds.refreshToken) {
      try {
        const response = await fetchWithTimeout(
          `${baseUrl}/api/auth/refresh`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              refresh_token: creds.refreshToken,
              refreshToken: creds.refreshToken,
            }),
          },
          15_000,
        );

        if (response.ok) {
          const data = (await response.json()) as {
            accessToken?: string;
            refreshToken?: string;
            refresh_token?: string;
            expiresIn?: number;
            expires_in?: number;
          };
          if (!data.accessToken) {
            throw new Error("Refresh response omitted accessToken");
          }
          setTokenOnClients(httpClient, wsClient, data.accessToken);
          persistTokenIfPossible(
            {
              token: data.accessToken,
              method: "stored_credentials",
              refreshToken:
                data.refreshToken || data.refresh_token || creds.refreshToken,
              expiresIn: data.expiresIn ?? data.expires_in,
            },
            creds.email,
          );
          console.error(`${ARCH_MCP_LOG_PREFIX} Refreshed stored credentials`);
          return { token: data.accessToken, method: "stored_credentials" };
        }
      } catch (err) {
        console.error(
          `${ARCH_MCP_LOG_PREFIX} Token refresh failed:`,
          err instanceof Error ? err.message : String(err),
        );
        // Refresh failed, fall through to device auth
      }
    }
  } catch (err) {
    console.error(
      `${ARCH_MCP_LOG_PREFIX} Credential reading failed:`,
      err instanceof Error ? err.message : String(err),
    );
    // Credential reading failed, fall through to device auth
  }

  return null;
}

/**
 * Open a URL in the user's default browser.
 * Uses execFile (not exec) to avoid shell injection from server-provided URLs.
 * Best-effort — never throws.
 */
function openBrowser(url: string): void {
  // Validate URL before launching to reject non-URL strings
  try {
    new URL(url);
  } catch {
    console.error(
      `${ARCH_MCP_LOG_PREFIX} Invalid verification URL, skipping browser launch: ${url}`,
    );
    return;
  }

  const platform = process.platform;
  let cmd: string;
  let args: string[];

  if (platform === "darwin") {
    cmd = "open";
    args = [url];
  } else if (platform === "win32") {
    cmd = "cmd";
    args = ["/c", "start", "", url];
  } else {
    cmd = "xdg-open";
    args = [url];
  }

  try {
    execFile(cmd, args, (err) => {
      if (err) {
        console.error(
          `${ARCH_MCP_LOG_PREFIX} Could not open browser: ${err.message}`,
        );
      }
    });
  } catch (err) {
    console.error(
      `${ARCH_MCP_LOG_PREFIX} Browser launch failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Full device auth flow: initiate → open browser → poll → persist credentials.
 * Single call — no two-phase handshake needed.
 */
async function deviceAuthFlow(
  httpClient: HttpClient,
  wsClient: WebSocketClient,
  baseUrl: string,
  pollTimeoutMs?: number,
): Promise<AuthResult> {
  // 1. Initiate
  const initResponse = await fetchWithTimeout(
    `${baseUrl}/api/auth/device`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scopes: ["read_traces", "read_state", "subscribe"],
      }),
    },
    15_000,
  );

  if (!initResponse.ok) {
    const errorText = await initResponse.text().catch(() => "Unknown error");
    throw new DeviceAuthError(
      `Failed to initiate device authorization (${initResponse.status}): ${errorText}. ` +
        `The runtime server may not have device auth enabled.`,
    );
  }

  const deviceAuth = (await initResponse.json()) as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete: string;
    expires_in: number;
    interval: number;
  };

  console.error(
    `${ARCH_MCP_LOG_PREFIX} Device auth initiated. Opening browser: ${deviceAuth.verification_uri_complete}`,
  );

  // 2. Auto-open browser
  openBrowser(deviceAuth.verification_uri_complete);

  // 3. Poll for approval (blocks until approved or timeout)
  // Clamp server-provided expires_in to DEFAULT_POLL_TIMEOUT_MS to avoid unbounded waits
  const serverTimeoutMs = deviceAuth.expires_in * 1000;
  const effectiveTimeout =
    pollTimeoutMs ?? Math.min(serverTimeoutMs, DEFAULT_POLL_TIMEOUT_MS);
  const result = await pollDeviceAuth(
    httpClient,
    wsClient,
    baseUrl,
    deviceAuth.device_code,
    effectiveTimeout,
  );

  // 4. Enrich the result message
  result.message =
    "Authenticated via device authorization. Browser login successful.";

  // 5. Persist credentials
  persistTokenIfPossible(result);

  return result;
}

/**
 * Persist auth token to ~/.config/kore-platform/credentials.json.
 * Best-effort — failures are logged but do not break the auth flow.
 */
function persistTokenIfPossible(
  result: AuthResult,
  fallbackEmail?: string,
): void {
  if (!result.token || result.method === "device_auth_pending") return;

  try {
    // Decode JWT to extract expiry (without verifying — we just signed it)
    const payload = JSON.parse(
      Buffer.from(result.token.split(".")[1], "base64url").toString(),
    ) as {
      exp?: number;
      email?: string;
    };
    const expiresAt = payload.exp
      ? new Date(payload.exp * 1000).toISOString()
      : new Date(
          Date.now() + (result.expiresIn ?? 86_400) * 1000,
        ).toISOString();

    writeStoredCredentials({
      token: result.token,
      ...(result.refreshToken ? { refreshToken: result.refreshToken } : {}),
      expiresAt,
      email: payload.email || fallbackEmail,
    });
    console.error(
      `${ARCH_MCP_LOG_PREFIX} Credentials saved to ~/.config/kore-platform/credentials.json`,
    );
  } catch (err) {
    console.error(
      `${ARCH_MCP_LOG_PREFIX} Failed to persist credentials:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

const DEFAULT_POLL_TIMEOUT_MS = 300_000; // 5 minutes — generous for login + approve

/**
 * Poll for device auth completion. Called on the second platform_connect call
 * after the user has (hopefully) approved in the browser.
 */
async function pollDeviceAuth(
  httpClient: HttpClient,
  wsClient: WebSocketClient,
  baseUrl: string,
  deviceCode: string,
  pollTimeoutMs?: number,
): Promise<AuthResult> {
  const timeout = pollTimeoutMs || DEFAULT_POLL_TIMEOUT_MS;
  const pollInterval = 3_000; // 3 seconds between polls
  const expiresAt = Date.now() + timeout;

  while (Date.now() < expiresAt) {
    try {
      const tokenResponse = await fetchWithTimeout(
        `${baseUrl}/api/auth/device/token`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ device_code: deviceCode }),
        },
        15_000,
      );

      if (tokenResponse.ok) {
        const tokenData = (await tokenResponse.json()) as {
          access_token: string;
          refresh_token?: string;
          expires_in: number;
        };

        setTokenOnClients(httpClient, wsClient, tokenData.access_token);
        console.error(
          `${ARCH_MCP_LOG_PREFIX} Authenticated via device authorization`,
        );

        return {
          token: tokenData.access_token,
          method: "device_auth",
          refreshToken: tokenData.refresh_token,
          expiresIn: tokenData.expires_in,
        };
      }

      // Check error type
      const errorData = (await tokenResponse.json().catch(() => ({}))) as {
        error?: string;
      };

      if (errorData.error === "authorization_pending") {
        await sleep(pollInterval);
        continue;
      }

      if (errorData.error === "slow_down") {
        await sleep(pollInterval * 2);
        continue;
      }

      if (errorData.error === "expired_token") {
        throw new DeviceAuthError(
          "Device authorization expired. Please run platform_connect again to start a new flow.",
        );
      }

      throw new DeviceAuthError(
        `Device authorization failed: ${errorData.error || "unknown error"}`,
      );
    } catch (e) {
      if (e instanceof DeviceAuthError) throw e;
      console.error(
        `${ARCH_MCP_LOG_PREFIX} Token polling error:`,
        e instanceof Error ? e.message : String(e),
      );
      await sleep(pollInterval);
      continue;
    }
  }

  throw new DeviceAuthError(
    "Device authorization not yet approved (timed out waiting). " +
      "Please approve in the browser, then call platform_connect again with the same deviceCode.",
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class DeviceAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceAuthError";
  }
}
