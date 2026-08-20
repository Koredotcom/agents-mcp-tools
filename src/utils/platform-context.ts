export interface ActivePlatformTarget {
  environment: 'local' | 'development' | 'staging' | 'qa' | 'production' | 'custom';
  serverUrl: string;
  wsUrl?: string;
  tenantId: string | null;
  subject: string | null;
  email: string | null;
}

export function describeActiveTarget(
  serverUrl: string,
  authToken: string | null,
  wsUrl?: string,
): ActivePlatformTarget {
  const normalizedServerUrl = normalizeServerOrigin(serverUrl);
  const payload = authToken ? decodeJwtPayload(authToken) : null;
  return {
    environment: classifyEnvironment(normalizedServerUrl),
    serverUrl: normalizedServerUrl,
    ...(wsUrl ? { wsUrl } : {}),
    tenantId: readString(payload?.tenantId),
    subject: readString(payload?.sub ?? payload?.userId),
    email: readString(payload?.email),
  };
}

export function normalizeServerOrigin(value: string): string {
  try {
    return new URL(value).origin.toLowerCase();
  } catch (_error) {
    return value.replace(/\/+$/, '').toLowerCase();
  }
}

function classifyEnvironment(serverUrl: string): ActivePlatformTarget['environment'] {
  let hostname: string;
  try {
    hostname = new URL(serverUrl).hostname.toLowerCase();
  } catch (_error) {
    return 'custom';
  }

  if (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]'
  ) {
    return 'local';
  }
  if (hostname === 'agents-dev.kore.ai') return 'development';
  if (hostname === 'agents-staging.kore.ai') return 'staging';
  if (hostname === 'agents-qa.kore.ai') return 'qa';
  if (hostname === 'agents.kore.ai') return 'production';
  return 'custom';
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown;
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch (_error) {
    return null;
  }
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}
