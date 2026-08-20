import type { DebugContext } from '../tools/index.js';
import {
  requestStudioJson,
  type StudioApiDependencies,
  type StudioApiResult,
} from '../utils/studio-api.js';
import {
  PROJECT_BUILDER_CONTRACT_VERSION,
  createProjectBuilderResult,
  type ProjectBuilderError,
  type ProjectBuilderRouteRequest,
  type ProjectBuilderToolResult,
} from './contracts.js';
import { sanitizeResponseBounded } from '../utils/sanitize.js';

export const ARCH_MCP_CAPABILITIES_MEDIA_TYPE =
  'application/vnd.kore.arch-mcp-capabilities+json;version=1.1' as const;

const CAPABILITY_PATH = '/api/arch-mcp/capabilities';
const CAPABILITY_TIMEOUT_MS = 10_000;

export interface ProjectBuilderStudioTransportDependencies extends StudioApiDependencies {}

export interface ProjectBuilderStudioRequest {
  readonly action: string;
  readonly domain: string | readonly string[];
  readonly route: ProjectBuilderRouteRequest;
  readonly timeoutMs: number;
}

export async function requestProjectBuilderStudio(
  ctx: DebugContext,
  request: ProjectBuilderStudioRequest,
  dependencies?: ProjectBuilderStudioTransportDependencies,
): Promise<ProjectBuilderToolResult> {
  const capability = await negotiateProjectBuilderCapability(ctx, request.domain, dependencies);
  if (capability) return createProjectBuilderResult(request.action, null, capability);

  let response: StudioApiResult;
  try {
    response = await requestStudioJson(
      ctx,
      {
        method: request.route.method,
        path: request.route.path,
        ...(request.route.body !== undefined ? { body: request.route.body } : {}),
        timeoutMs: request.timeoutMs,
      },
      dependencies,
    );
  } catch (error) {
    return createProjectBuilderResult(
      request.action,
      null,
      transportError('PROJECT_BUILDER_TRANSPORT_FAILED', error),
    );
  }
  if (response.ok) return createProjectBuilderResult(request.action, response.body);

  return createProjectBuilderResult(request.action, null, {
    code:
      response.status === 404
        ? 'PROJECT_BUILDER_RESOURCE_NOT_FOUND'
        : 'PROJECT_BUILDER_REQUEST_FAILED',
    message:
      response.status === 404
        ? 'The requested project-builder resource is not visible or does not exist.'
        : `Studio project-builder request failed with HTTP ${response.status}.`,
    retryable: response.status >= 500 || response.status === 429,
    nextActions:
      response.status === 404
        ? [
            {
              action: 'verify_scope',
              description: 'Verify the project, operation, and actor scope.',
            },
          ]
        : [{ action: 'inspect_operation', description: 'Inspect the operation before retrying.' }],
  });
}

export async function negotiateProjectBuilderCapability(
  ctx: DebugContext,
  domain: string | readonly string[],
  dependencies?: ProjectBuilderStudioTransportDependencies,
): Promise<ProjectBuilderError | null> {
  let response: StudioApiResult;
  try {
    response = await requestStudioJson(
      ctx,
      {
        method: 'GET',
        path: CAPABILITY_PATH,
        timeoutMs: CAPABILITY_TIMEOUT_MS,
        headers: { Accept: ARCH_MCP_CAPABILITIES_MEDIA_TYPE },
      },
      dependencies,
    );
  } catch (error) {
    return transportError('STUDIO_CAPABILITY_UNKNOWN', error);
  }

  if (!response.ok) {
    return {
      code:
        response.status === 404 ? 'STUDIO_CAPABILITY_UNKNOWN' : 'STUDIO_CAPABILITY_CHECK_FAILED',
      message:
        response.status === 404
          ? 'The connected Studio did not provide an unambiguous project-builder capability response.'
          : `Studio capability negotiation failed with HTTP ${response.status}.`,
      retryable: response.status >= 500 || response.status === 429,
      nextActions: [
        {
          action: 'verify_studio_version',
          description: 'Connect to a Studio deployment that explicitly advertises contract 1.1.',
        },
      ],
    };
  }

  const advertised = parseCapabilities(response.body);
  if (advertised.explicitLowerVersion) {
    return {
      code: 'STUDIO_UPGRADE_REQUIRED',
      message: 'The connected Studio explicitly advertises an older project-builder contract.',
      retryable: false,
      nextActions: [
        {
          action: 'upgrade_studio',
          description: 'Upgrade Studio before using project-builder tools.',
        },
      ],
    };
  }
  const requestedDomains = typeof domain === 'string' ? [domain] : domain;
  if (
    !mediaTypeMatches(response.contentType) ||
    !advertised.valid ||
    requestedDomains.some((requestedDomain) => !advertised.domains.has(requestedDomain))
  ) {
    return {
      code: 'STUDIO_CAPABILITY_UNKNOWN',
      message:
        'Studio did not unambiguously advertise the requested project-builder domain at contract 1.1.',
      retryable: false,
      nextActions: [
        {
          action: 'verify_studio_version',
          description:
            'Verify Studio capability media type, response body, and domain registration.',
        },
      ],
    };
  }
  return null;
}

function parseCapabilities(body: unknown): {
  valid: boolean;
  explicitLowerVersion: boolean;
  domains: Set<string>;
} {
  if (!isRecord(body)) return { valid: false, explicitLowerVersion: false, domains: new Set() };
  const versions = Array.isArray(body.contractVersions)
    ? body.contractVersions.filter((value): value is string => typeof value === 'string')
    : [];
  const schemaVersion = typeof body.schemaVersion === 'string' ? body.schemaVersion : null;
  const explicitLowerVersion =
    versions.length > 0 && !versions.includes(PROJECT_BUILDER_CONTRACT_VERSION);
  const domains = new Set<string>();
  if (Array.isArray(body.domains)) {
    for (const value of body.domains) {
      if (!isRecord(value) || typeof value.domain !== 'string') continue;
      const domainVersions = Array.isArray(value.contractVersions)
        ? value.contractVersions.filter((version): version is string => typeof version === 'string')
        : [];
      if (domainVersions.includes(PROJECT_BUILDER_CONTRACT_VERSION)) domains.add(value.domain);
    }
  }
  return {
    valid:
      body.service === 'arch-project-builder' &&
      schemaVersion === PROJECT_BUILDER_CONTRACT_VERSION &&
      versions.includes(PROJECT_BUILDER_CONTRACT_VERSION),
    explicitLowerVersion,
    domains,
  };
}

function mediaTypeMatches(contentType: string | null): boolean {
  if (!contentType) return false;
  return contentType
    .split(';')
    .map((part) => part.trim().toLowerCase())
    .join(';')
    .startsWith(ARCH_MCP_CAPABILITIES_MEDIA_TYPE);
}

function transportError(code: string, error: unknown): ProjectBuilderError {
  let message = 'Unknown transport error';
  if (error instanceof Error) {
    try {
      message = String(sanitizeResponseBounded(error.message));
    } catch {
      message = 'Sanitized transport error';
    }
  }
  return {
    code,
    message: `Studio project-builder transport failed: ${message}`,
    retryable: true,
    nextActions: [
      {
        action: 'reconnect',
        description: 'Verify the configured Studio origin and authentication, then retry.',
      },
    ],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
