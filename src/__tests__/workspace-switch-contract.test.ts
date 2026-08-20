import { describe, expect, test } from 'vitest';
import {
  decodeJwtPayload,
  parseWorkspaceSwitchOutcome,
  workspaceSwitchSuccessFromToken,
} from '../tools/workspace-switch-contract.js';

const NOW_MS = 2_000_000_000_000;
const NOW_SECONDS = Math.floor(NOW_MS / 1_000);
const TENANT_ID = 'tenant-target';
const SUBJECT = 'user-1';

function makeJwt(payload: unknown): string {
  return [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'signature',
  ].join('.');
}

function validToken(overrides: Record<string, unknown> = {}): string {
  return makeJwt({
    sub: SUBJECT,
    tenantId: TENANT_ID,
    role: 'ADMIN',
    exp: NOW_SECONDS + 3_600,
    ...overrides,
  });
}

function parseSuccess(
  overrides: Record<string, unknown> = {},
  optionOverrides: Partial<Parameters<typeof parseWorkspaceSwitchOutcome>[0]> = {},
) {
  return parseWorkspaceSwitchOutcome({
    httpStatus: 200,
    requestedTenantId: TENANT_ID,
    expectedSubject: SUBJECT,
    nowMs: NOW_MS,
    value: {
      accessToken: validToken(),
      tenantId: TENANT_ID,
      role: 'ADMIN',
      expiresIn: 3_600,
      ...overrides,
    },
    ...optionOverrides,
  });
}

describe('workspace switch contract', () => {
  test('returns typed MFA and enrollment interactions before accepting success fields', () => {
    expect(
      parseWorkspaceSwitchOutcome({
        httpStatus: 200,
        value: { mfaRequired: true },
        requestedTenantId: TENANT_ID,
        expectedSubject: SUBJECT,
      }),
    ).toEqual({
      kind: 'interaction_required',
      code: 'WORKSPACE_INTERACTION_REQUIRED',
      message: 'Multi-factor authentication is required before switching workspaces.',
      interaction: { type: 'mfa_challenge' },
    });

    expect(
      parseWorkspaceSwitchOutcome({
        httpStatus: 200,
        value: { mfaEnrollmentRequired: true },
        requestedTenantId: TENANT_ID,
        expectedSubject: SUBJECT,
      }),
    ).toMatchObject({
      kind: 'interaction_required',
      interaction: { type: 'mfa_enrollment' },
    });
  });

  test.each([
    [
      401,
      null,
      'AUTHENTICATION_REQUIRED',
      'Authentication expired before the workspace could be switched.',
    ],
    [
      403,
      { error: { message: 'Workspace policy denied the switch.' } },
      'WORKSPACE_SWITCH_FORBIDDEN',
      'Workspace policy denied the switch.',
    ],
    [403, {}, 'WORKSPACE_SWITCH_FORBIDDEN', 'The target workspace policy denied this switch.'],
    [
      404,
      {},
      'WORKSPACE_NOT_FOUND_OR_INACCESSIBLE',
      `Workspace ${TENANT_ID} was not found or is not accessible.`,
    ],
    [
      429,
      {},
      'WORKSPACE_SWITCH_RATE_LIMITED',
      'Workspace switching is temporarily rate limited. Retry later.',
    ],
    [503, {}, 'WORKSPACE_SWITCH_FAILED', 'Workspace switch failed with HTTP 503.'],
  ])('maps HTTP %s to a stable failure', (httpStatus, value, code, message) => {
    expect(
      parseWorkspaceSwitchOutcome({
        httpStatus,
        value,
        requestedTenantId: TENANT_ID,
        expectedSubject: SUBJECT,
      }),
    ).toEqual({ kind: 'failure', code, message, httpStatus });
  });

  test('maps bounded nested and top-level SSO errors to an interaction', () => {
    expect(
      parseWorkspaceSwitchOutcome({
        httpStatus: 403,
        value: {
          error: {
            code: 'SSO_REAUTH_REQUIRED',
            message: 'Use the workspace identity provider.',
          },
        },
        requestedTenantId: TENANT_ID,
        expectedSubject: SUBJECT,
      }),
    ).toEqual({
      kind: 'interaction_required',
      code: 'SSO_REAUTH_REQUIRED',
      message: 'Use the workspace identity provider.',
      interaction: { type: 'sso_reauthentication' },
    });

    expect(
      parseWorkspaceSwitchOutcome({
        httpStatus: 403,
        value: { code: 'SSO_REAUTH_REQUIRED' },
        requestedTenantId: TENANT_ID,
        expectedSubject: SUBJECT,
      }),
    ).toMatchObject({
      kind: 'interaction_required',
      message: 'SSO re-authentication is required for this workspace.',
    });
  });

  test.each([
    [null, 'Workspace switch returned an invalid response.'],
    [{}, 'Workspace switch response omitted required authentication fields.'],
    [
      { accessToken: validToken(), tenantId: 'tenant-other', role: 'ADMIN' },
      `Workspace switch returned tenant tenant-other, not requested tenant ${TENANT_ID}.`,
    ],
    [
      { accessToken: 'invalid', tenantId: TENANT_ID, role: 'ADMIN' },
      'Workspace switch returned an access token without verifiable tenant, subject, and role claims.',
    ],
    [
      {
        accessToken: validToken({ tenantId: 'tenant-other' }),
        tenantId: TENANT_ID,
        role: 'ADMIN',
      },
      `Workspace token is scoped to tenant tenant-other, not requested tenant ${TENANT_ID}.`,
    ],
    [
      {
        accessToken: validToken({ sub: 'user-other' }),
        tenantId: TENANT_ID,
        role: 'ADMIN',
      },
      'Workspace token subject does not match the authenticated user.',
    ],
    [
      {
        accessToken: validToken({ role: 'VIEWER' }),
        tenantId: TENANT_ID,
        role: 'ADMIN',
      },
      'Workspace switch response role does not match the access token role.',
    ],
    [
      {
        accessToken: validToken({ exp: NOW_SECONDS }),
        tenantId: TENANT_ID,
        role: 'ADMIN',
      },
      'Workspace switch returned an access token without a finite future expiry.',
    ],
    [
      {
        accessToken: validToken({ exp: 'later' }),
        tenantId: TENANT_ID,
        role: 'ADMIN',
      },
      'Workspace switch returned an access token without a finite future expiry.',
    ],
  ])('rejects an invalid successful response: %#', (value, message) => {
    expect(
      parseWorkspaceSwitchOutcome({
        httpStatus: 200,
        value,
        requestedTenantId: TENANT_ID,
        expectedSubject: SUBJECT,
        nowMs: NOW_MS,
      }),
    ).toEqual({
      kind: 'failure',
      code: 'INVALID_WORKSPACE_RESPONSE',
      message,
      httpStatus: 200,
    });
  });

  test.each([0, -1, 2.5, 31 * 24 * 60 * 60 + 1, '3600'])(
    'rejects invalid expiresIn value %s',
    (expiresIn) => {
      expect(parseSuccess({ expiresIn })).toMatchObject({
        kind: 'failure',
        code: 'INVALID_WORKSPACE_RESPONSE',
        message: 'Workspace switch response contains an invalid token expiry.',
      });
    },
  );

  test('validates organization identifiers against the token', () => {
    expect(parseSuccess({ orgId: ' org-1 ' })).toMatchObject({
      kind: 'failure',
      message: 'Workspace switch response contains an invalid organization identifier.',
    });
    expect(
      parseSuccess({
        accessToken: validToken({ orgId: 'org-token' }),
        orgId: 'org-response',
      }),
    ).toMatchObject({
      kind: 'failure',
      message: 'Workspace switch response organization does not match the access token.',
    });
    expect(
      parseSuccess({
        accessToken: validToken({ orgId: 'org-token' }),
        orgId: null,
      }),
    ).toMatchObject({
      kind: 'failure',
      message: 'Workspace switch response organization does not match the access token.',
    });
  });

  test('accepts valid responses with token organization, explicit null, or no organization', () => {
    expect(
      parseSuccess({
        accessToken: validToken({ orgId: 'org-1' }),
        orgId: 'org-1',
      }),
    ).toEqual({
      kind: 'success',
      accessToken: validToken({ orgId: 'org-1' }),
      tenantId: TENANT_ID,
      role: 'ADMIN',
      expiresIn: 3_600,
      orgId: 'org-1',
    });
    expect(
      parseSuccess({
        accessToken: validToken({ userId: SUBJECT, sub: undefined }),
        orgId: null,
        expiresIn: undefined,
      }),
    ).toMatchObject({
      kind: 'success',
      tenantId: TENANT_ID,
      role: 'ADMIN',
      orgId: null,
    });
    expect(parseSuccess({ expiresIn: undefined })).toEqual({
      kind: 'success',
      accessToken: validToken(),
      tenantId: TENANT_ID,
      role: 'ADMIN',
    });
  });

  test('builds and validates a switch response directly from an acquired device token', () => {
    expect(
      workspaceSwitchSuccessFromToken({
        accessToken: validToken({ orgId: 'org-1' }),
        requestedTenantId: TENANT_ID,
        expectedSubject: SUBJECT,
        expiresIn: 600,
      }),
    ).toMatchObject({
      kind: 'success',
      tenantId: TENANT_ID,
      role: 'ADMIN',
      orgId: 'org-1',
      expiresIn: 600,
    });

    expect(
      workspaceSwitchSuccessFromToken({
        accessToken: 'not-a-jwt',
        requestedTenantId: TENANT_ID,
        expectedSubject: SUBJECT,
      }),
    ).toMatchObject({
      kind: 'failure',
      code: 'INVALID_WORKSPACE_RESPONSE',
    });
  });

  test('decodes only bounded three-part JWT object payloads', () => {
    expect(decodeJwtPayload(validToken())).toMatchObject({
      sub: SUBJECT,
      tenantId: TENANT_ID,
    });
    expect(decodeJwtPayload('')).toBeNull();
    expect(decodeJwtPayload('one.two')).toBeNull();
    expect(decodeJwtPayload('one..three')).toBeNull();
    expect(decodeJwtPayload(makeJwt([]))).toBeNull();
    expect(decodeJwtPayload('one.***.three')).toBeNull();
    expect(decodeJwtPayload('x'.repeat(128 * 1024 + 1))).toBeNull();
  });
});
