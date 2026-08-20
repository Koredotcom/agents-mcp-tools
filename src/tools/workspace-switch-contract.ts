export type WorkspaceRole = 'OWNER' | 'ADMIN' | 'OPERATOR' | 'MEMBER' | 'VIEWER' | 'CUSTOM';

export interface WorkspaceSwitchSuccess {
  kind: 'success';
  accessToken: string;
  tenantId: string;
  role: WorkspaceRole;
  expiresIn?: number;
  orgId?: string | null;
}

export interface WorkspaceSwitchInteraction {
  kind: 'interaction_required';
  code: 'WORKSPACE_INTERACTION_REQUIRED' | 'SSO_REAUTH_REQUIRED';
  message: string;
  interaction: {
    type: 'mfa_challenge' | 'mfa_enrollment' | 'sso_reauthentication';
  };
}

export interface WorkspaceSwitchFailure {
  kind: 'failure';
  code:
    | 'AUTHENTICATION_REQUIRED'
    | 'WORKSPACE_NOT_FOUND_OR_INACCESSIBLE'
    | 'WORKSPACE_SWITCH_FORBIDDEN'
    | 'WORKSPACE_SWITCH_RATE_LIMITED'
    | 'INVALID_WORKSPACE_RESPONSE'
    | 'WORKSPACE_SWITCH_FAILED';
  message: string;
  httpStatus: number;
}

export type WorkspaceSwitchOutcome =
  | WorkspaceSwitchSuccess
  | WorkspaceSwitchInteraction
  | WorkspaceSwitchFailure;

interface ParseWorkspaceSwitchOptions {
  httpStatus: number;
  value: unknown;
  requestedTenantId: string;
  expectedSubject: string;
  nowMs?: number;
}

interface WorkspaceTokenOptions {
  accessToken: string;
  requestedTenantId: string;
  expectedSubject: string;
  expiresIn?: number;
}

const WORKSPACE_ROLES = new Set<WorkspaceRole>([
  'OWNER',
  'ADMIN',
  'OPERATOR',
  'MEMBER',
  'VIEWER',
  'CUSTOM',
]);
const MAX_SWITCH_EXPIRES_IN_SECONDS = 31 * 24 * 60 * 60;
const MAX_ACCESS_TOKEN_LENGTH = 128 * 1024;
const MAX_TENANT_ID_LENGTH = 256;
const MAX_SUBJECT_LENGTH = 256;
const MAX_ORGANIZATION_ID_LENGTH = 256;
const MAX_ERROR_CODE_LENGTH = 128;
const MAX_ERROR_MESSAGE_LENGTH = 2_048;

export function parseWorkspaceSwitchOutcome(
  options: ParseWorkspaceSwitchOptions,
): WorkspaceSwitchOutcome {
  const record = toRecord(options.value);

  if (options.httpStatus >= 200 && options.httpStatus < 300) {
    if (record?.mfaRequired === true) {
      return {
        kind: 'interaction_required',
        code: 'WORKSPACE_INTERACTION_REQUIRED',
        message: 'Multi-factor authentication is required before switching workspaces.',
        interaction: {
          type: 'mfa_challenge',
        },
      };
    }

    if (record?.mfaEnrollmentRequired === true) {
      return {
        kind: 'interaction_required',
        code: 'WORKSPACE_INTERACTION_REQUIRED',
        message: 'Multi-factor authentication enrollment is required before switching workspaces.',
        interaction: {
          type: 'mfa_enrollment',
        },
      };
    }

    return parseSuccessfulSwitch(record, options);
  }

  const details = readErrorDetails(record);
  if (details.code === 'SSO_REAUTH_REQUIRED') {
    return {
      kind: 'interaction_required',
      code: 'SSO_REAUTH_REQUIRED',
      message: details.message ?? 'SSO re-authentication is required for this workspace.',
      interaction: {
        type: 'sso_reauthentication',
      },
    };
  }

  switch (options.httpStatus) {
    case 401:
      return failure(
        'AUTHENTICATION_REQUIRED',
        'Authentication expired before the workspace could be switched.',
        options.httpStatus,
      );
    case 403:
      return failure(
        'WORKSPACE_SWITCH_FORBIDDEN',
        details.message ?? 'The target workspace policy denied this switch.',
        options.httpStatus,
      );
    case 404:
      return failure(
        'WORKSPACE_NOT_FOUND_OR_INACCESSIBLE',
        `Workspace ${options.requestedTenantId} was not found or is not accessible.`,
        options.httpStatus,
      );
    case 429:
      return failure(
        'WORKSPACE_SWITCH_RATE_LIMITED',
        'Workspace switching is temporarily rate limited. Retry later.',
        options.httpStatus,
      );
    default:
      return failure(
        'WORKSPACE_SWITCH_FAILED',
        `Workspace switch failed with HTTP ${options.httpStatus}.`,
        options.httpStatus,
      );
  }
}

export function workspaceSwitchSuccessFromToken(
  options: WorkspaceTokenOptions,
): WorkspaceSwitchOutcome {
  const payload = decodeJwtPayload(options.accessToken);
  return parseSuccessfulSwitch(
    payload
      ? {
          accessToken: options.accessToken,
          tenantId: payload.tenantId,
          role: payload.role,
          orgId: payload.orgId,
          expiresIn: options.expiresIn,
        }
      : null,
    {
      httpStatus: 200,
      value: payload,
      requestedTenantId: options.requestedTenantId,
      expectedSubject: options.expectedSubject,
    },
  );
}

function parseSuccessfulSwitch(
  record: Record<string, unknown> | null,
  options: ParseWorkspaceSwitchOptions,
): WorkspaceSwitchOutcome {
  if (!record) {
    return invalidResponse('Workspace switch returned an invalid response.', options.httpStatus);
  }

  const accessToken = readBoundedString(record.accessToken, MAX_ACCESS_TOKEN_LENGTH);
  const returnedTenantId = readBoundedString(record.tenantId, MAX_TENANT_ID_LENGTH);
  const role = readWorkspaceRole(record.role);
  if (!accessToken || !returnedTenantId || !role) {
    return invalidResponse(
      'Workspace switch response omitted required authentication fields.',
      options.httpStatus,
    );
  }

  if (returnedTenantId !== options.requestedTenantId) {
    return invalidResponse(
      `Workspace switch returned tenant ${returnedTenantId}, not requested tenant ${options.requestedTenantId}.`,
      options.httpStatus,
    );
  }

  const tokenPayload = decodeJwtPayload(accessToken);
  const tokenTenantId = readBoundedString(tokenPayload?.tenantId, MAX_TENANT_ID_LENGTH);
  const tokenSubject = readBoundedString(
    tokenPayload?.sub ?? tokenPayload?.userId,
    MAX_SUBJECT_LENGTH,
  );
  const tokenRole = readWorkspaceRole(tokenPayload?.role);
  if (!tokenPayload || !tokenTenantId || !tokenSubject || !tokenRole) {
    return invalidResponse(
      'Workspace switch returned an access token without verifiable tenant, subject, and role claims.',
      options.httpStatus,
    );
  }
  if (tokenTenantId !== options.requestedTenantId) {
    return invalidResponse(
      `Workspace token is scoped to tenant ${tokenTenantId}, not requested tenant ${options.requestedTenantId}.`,
      options.httpStatus,
    );
  }
  if (tokenSubject !== options.expectedSubject) {
    return invalidResponse(
      'Workspace token subject does not match the authenticated user.',
      options.httpStatus,
    );
  }
  if (tokenRole !== role) {
    return invalidResponse(
      'Workspace switch response role does not match the access token role.',
      options.httpStatus,
    );
  }

  const tokenExpiry = tokenPayload.exp;
  const nowSeconds = Math.floor((options.nowMs ?? Date.now()) / 1_000);
  if (
    typeof tokenExpiry !== 'number' ||
    !Number.isSafeInteger(tokenExpiry) ||
    tokenExpiry <= nowSeconds
  ) {
    return invalidResponse(
      'Workspace switch returned an access token without a finite future expiry.',
      options.httpStatus,
    );
  }

  const expiresIn = record.expiresIn;
  if (
    expiresIn !== undefined &&
    (typeof expiresIn !== 'number' ||
      !Number.isInteger(expiresIn) ||
      expiresIn <= 0 ||
      expiresIn > MAX_SWITCH_EXPIRES_IN_SECONDS)
  ) {
    return invalidResponse(
      'Workspace switch response contains an invalid token expiry.',
      options.httpStatus,
    );
  }

  const returnedOrgId = record.orgId;
  const tokenOrgId = readBoundedString(tokenPayload.orgId, MAX_ORGANIZATION_ID_LENGTH);
  if (
    returnedOrgId !== undefined &&
    returnedOrgId !== null &&
    !readBoundedString(returnedOrgId, MAX_ORGANIZATION_ID_LENGTH)
  ) {
    return invalidResponse(
      'Workspace switch response contains an invalid organization identifier.',
      options.httpStatus,
    );
  }
  if (
    (typeof returnedOrgId === 'string' && returnedOrgId !== tokenOrgId) ||
    (returnedOrgId === null && tokenOrgId !== undefined)
  ) {
    return invalidResponse(
      'Workspace switch response organization does not match the access token.',
      options.httpStatus,
    );
  }

  return {
    kind: 'success',
    accessToken,
    tenantId: returnedTenantId,
    role,
    ...(typeof expiresIn === 'number' ? { expiresIn } : {}),
    ...(tokenOrgId ? { orgId: tokenOrgId } : returnedOrgId === null ? { orgId: null } : {}),
  };
}

export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    if (token.length === 0 || token.length > MAX_ACCESS_TOKEN_LENGTH) return null;
    const parts = token.split('.');
    if (parts.length !== 3 || !parts[1]) return null;
    const decoded = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as unknown;
    return toRecord(decoded);
  } catch (_error) {
    return null;
  }
}

function readErrorDetails(record: Record<string, unknown> | null): {
  code?: string;
  message?: string;
} {
  if (!record) return {};
  const nested = toRecord(record.error);
  return {
    code:
      readBoundedString(nested?.code, MAX_ERROR_CODE_LENGTH) ??
      readBoundedString(record.code, MAX_ERROR_CODE_LENGTH),
    message:
      readBoundedString(nested?.message, MAX_ERROR_MESSAGE_LENGTH) ??
      readBoundedString(record.message, MAX_ERROR_MESSAGE_LENGTH) ??
      readBoundedString(record.error, MAX_ERROR_MESSAGE_LENGTH),
  };
}

function readWorkspaceRole(value: unknown): WorkspaceRole | null {
  return typeof value === 'string' && WORKSPACE_ROLES.has(value as WorkspaceRole)
    ? (value as WorkspaceRole)
    : null;
}

function readBoundedString(value: unknown, maxLength: number): string | undefined {
  return typeof value === 'string' &&
    value === value.trim() &&
    value.length > 0 &&
    value.length <= maxLength
    ? value
    : undefined;
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function invalidResponse(message: string, httpStatus: number): WorkspaceSwitchFailure {
  return failure('INVALID_WORKSPACE_RESPONSE', message, httpStatus);
}

function failure(
  code: WorkspaceSwitchFailure['code'],
  message: string,
  httpStatus: number,
): WorkspaceSwitchFailure {
  return { kind: 'failure', code, message, httpStatus };
}
