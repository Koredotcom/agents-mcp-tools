/**
 * Tests for credentials reader
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { StoredCredentials } from '../client/credentials.js';
import type * as CredentialsModule from '../client/credentials.js';

const ENCRYPTION_KEY = 'kore-platform-cli-v1';
const GCM_IV_BYTES = 12;
const GCM_AUTH_TAG_BYTES = 16;
const CONF_PBKDF2_ITERATIONS = 10_000;
const CONF_KEY_BYTES = 32;
const AUTHENTICATED_CREDENTIALS_PREFIX = 'kore-platform-credentials-v2:';

let tempRoot = '';
let originalHome: string | undefined;
let originalXdgConfigHome: string | undefined;
let primaryCredentialsPathValue = '';
let cliCredentialsPathValue = '';
let mcpSecretPathValue = '';
let readStoredCredentials: typeof CredentialsModule.readStoredCredentials;
let readMcpStoredCredentials: typeof CredentialsModule.readMcpStoredCredentials;
let writeStoredCredentials: typeof CredentialsModule.writeStoredCredentials;
let restoreStoredCredentials: typeof CredentialsModule.restoreStoredCredentials;
let acquireStoredCredentialLock: typeof CredentialsModule.acquireStoredCredentialLock;
let storedCredentialIdentityMatches: typeof CredentialsModule.storedCredentialIdentityMatches;
let hasValidToken: typeof CredentialsModule.hasValidToken;
let hasRefreshToken: typeof CredentialsModule.hasRefreshToken;

function decryptAuthenticatedCredentials(
  raw: Buffer,
  secret: string | Buffer = ENCRYPTION_KEY,
): Record<string, unknown> {
  const text = raw.toString('utf8').trim();
  expect(text.startsWith(AUTHENTICATED_CREDENTIALS_PREFIX)).toBe(true);
  const encoded = text.slice(AUTHENTICATED_CREDENTIALS_PREFIX.length);
  const [initializationVectorHex, authTagHex, encryptedHex] = encoded.split(':');
  const initializationVector = Buffer.from(initializationVectorHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const encrypted = Buffer.from(encryptedHex, 'hex');

  expect(initializationVector).toHaveLength(GCM_IV_BYTES);
  expect(authTag).toHaveLength(GCM_AUTH_TAG_BYTES);

  const key = crypto.pbkdf2Sync(
    secret,
    initializationVector.toString(),
    CONF_PBKDF2_ITERATIONS,
    CONF_KEY_BYTES,
    'sha512',
  );
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, initializationVector, {
    authTagLength: GCM_AUTH_TAG_BYTES,
  });
  decipher.setAuthTag(authTag);
  return JSON.parse(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8'));
}

function encryptAuthenticatedCredentials(data: Record<string, unknown>): Buffer {
  const initializationVector = crypto.randomBytes(GCM_IV_BYTES);
  const key = crypto.pbkdf2Sync(
    ENCRYPTION_KEY,
    initializationVector.toString(),
    CONF_PBKDF2_ITERATIONS,
    CONF_KEY_BYTES,
    'sha512',
  );
  const cipher = crypto.createCipheriv('aes-256-gcm', key, initializationVector, {
    authTagLength: GCM_AUTH_TAG_BYTES,
  });
  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(data, undefined, '\t'), 'utf8')),
    cipher.final(),
  ]);

  return Buffer.from(
    `${AUTHENTICATED_CREDENTIALS_PREFIX}${initializationVector.toString('hex')}:${cipher
      .getAuthTag()
      .toString('hex')}:${encrypted.toString('hex')}`,
    'utf8',
  );
}

describe('credentials', () => {
  beforeAll(async () => {
    originalHome = process.env['HOME'];
    originalXdgConfigHome = process.env['XDG_CONFIG_HOME'];
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-debug-credentials-'));
    process.env['HOME'] = path.join(tempRoot, 'home');
    process.env['XDG_CONFIG_HOME'] = path.join(tempRoot, 'xdg-config');
    fs.mkdirSync(process.env['HOME'], { recursive: true });

    vi.resetModules();
    const envPaths = (await import('env-paths')).default;
    const configDir = envPaths('kore-platform', { suffix: 'nodejs' }).config;
    primaryCredentialsPathValue = path.join(configDir, 'mcp-debug-credentials.json');
    cliCredentialsPathValue = path.join(configDir, 'credentials.json');
    mcpSecretPathValue = path.join(configDir, 'mcp-debug-credentials.key');
    const credentials = await import('../client/credentials.js');
    readStoredCredentials = credentials.readStoredCredentials;
    readMcpStoredCredentials = credentials.readMcpStoredCredentials;
    writeStoredCredentials = credentials.writeStoredCredentials;
    restoreStoredCredentials = credentials.restoreStoredCredentials;
    acquireStoredCredentialLock = credentials.acquireStoredCredentialLock;
    storedCredentialIdentityMatches = credentials.storedCredentialIdentityMatches;
    hasValidToken = credentials.hasValidToken;
    hasRefreshToken = credentials.hasRefreshToken;
  });

  beforeEach(() => {
    fs.rmSync(path.dirname(primaryCredentialsPath()), { recursive: true, force: true });
    fs.rmSync(path.dirname(legacyCredentialsPath()), { recursive: true, force: true });
    fs.mkdirSync(process.env['HOME'] ?? '', { recursive: true });
  });

  afterAll(() => {
    restoreEnv('HOME', originalHome);
    restoreEnv('XDG_CONFIG_HOME', originalXdgConfigHome);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  describe('readStoredCredentials', () => {
    test('returns null when neither credential store exists', () => {
      expect(readStoredCredentials()).toBeNull();
    });

    test.each([
      {
        name: 'empty file',
        body: '',
      },
      {
        name: 'invalid JSON and not encrypted',
        body: 'not-json-and-not-valid-hex',
      },
      {
        name: 'missing token field',
        body: JSON.stringify({ expiresAt: '2099-01-01T00:00:00.000Z' }),
      },
      {
        name: 'missing expiresAt field',
        body: JSON.stringify({ token: 'abc123' }),
      },
    ])('returns null when the primary credential file has $name', ({ body }) => {
      writeCredentialFile(primaryCredentialsPath(), body);

      expect(readStoredCredentials()).toBeNull();
    });

    test('ignores legacy encrypted CLI credentials so auth can fall back to device auth', () => {
      const legacyEncryptedShape = Buffer.concat([
        crypto.randomBytes(16),
        Buffer.from(':'),
        crypto.randomBytes(32),
      ]);
      writeCredentialFile(cliCredentialsPath(), legacyEncryptedShape);

      expect(readStoredCredentials()).toBeNull();
    });

    test('reads plain JSON credentials', () => {
      writeCredentialFile(
        primaryCredentialsPath(),
        JSON.stringify({
          token: 'abc123',
          expiresAt: '2099-01-01T00:00:00.000Z',
          email: 'user@example.com',
        }),
      );

      expect(readStoredCredentials()).toMatchObject({
        token: 'abc123',
        expiresAt: '2099-01-01T00:00:00.000Z',
        email: 'user@example.com',
      });
    });

    test('includes refreshToken when present', () => {
      writeCredentialFile(
        primaryCredentialsPath(),
        JSON.stringify({
          token: 'abc123',
          expiresAt: '2099-01-01T00:00:00.000Z',
          refreshToken: 'refresh-abc',
        }),
      );

      expect(readStoredCredentials()).toMatchObject({
        token: 'abc123',
        refreshToken: 'refresh-abc',
      });
    });

    test('falls back to CLI credentials when the MCP-debug store is absent', () => {
      writeCredentialFile(
        cliCredentialsPath(),
        JSON.stringify({
          token: 'cli-token',
          expiresAt: '2099-01-01T00:00:00.000Z',
          refreshToken: 'cli-refresh',
        }),
      );

      expect(readStoredCredentials()).toMatchObject({
        token: 'cli-token',
        refreshToken: 'cli-refresh',
      });
    });

    test('falls back to legacy .config credentials when newer stores are absent', () => {
      writeCredentialFile(
        legacyCredentialsPath(),
        JSON.stringify({
          token: 'legacy-token',
          expiresAt: '2099-01-01T00:00:00.000Z',
          refreshToken: 'legacy-refresh',
        }),
      );

      expect(readStoredCredentials()).toMatchObject({
        token: 'legacy-token',
        refreshToken: 'legacy-refresh',
      });
    });

    test('prefers MCP-debug store over stale fallback credentials', () => {
      writeCredentialFile(
        primaryCredentialsPath(),
        encryptAuthenticatedCredentials({
          token: 'primary-token',
          expiresAt: '2099-01-01T00:00:00.000Z',
          refreshToken: 'primary-refresh',
        }),
      );
      writeCredentialFile(
        legacyCredentialsPath(),
        JSON.stringify({
          token: 'legacy-token',
          expiresAt: '2099-01-01T00:00:00.000Z',
        }),
      );

      expect(readStoredCredentials()).toMatchObject({
        token: 'primary-token',
        refreshToken: 'primary-refresh',
      });
    });

    test('returns null when the credential path exists but cannot be read as a file', () => {
      fs.mkdirSync(primaryCredentialsPath(), { recursive: true });

      expect(readStoredCredentials()).toBeNull();
    });
  });

  describe('writeStoredCredentials', () => {
    test('writes authenticated encrypted credentials to the local store', () => {
      writeStoredCredentials({
        token: 'new-token',
        refreshToken: 'new-refresh',
        expiresAt: '2099-01-01T00:00:00.000Z',
        email: 'new@example.com',
        serverUrl: 'https://agents-dev.kore.ai',
      });

      const stat = fs.statSync(primaryCredentialsPath());
      expect(stat.mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(primaryCredentialsPath())).mode & 0o777).toBe(0o700);
      const raw = fs.readFileSync(primaryCredentialsPath());
      const secretStat = fs.statSync(mcpSecretPath());
      expect(secretStat.mode & 0o777).toBe(0o600);
      const localSecret = fs.readFileSync(mcpSecretPath());
      expect(raw).toBeInstanceOf(Buffer);
      expect(() => decryptAuthenticatedCredentials(raw, ENCRYPTION_KEY)).toThrow();
      expect(decryptAuthenticatedCredentials(raw, localSecret)).toMatchObject({
        token: 'new-token',
        refreshToken: 'new-refresh',
        email: 'new@example.com',
        serverUrl: 'https://agents-dev.kore.ai',
      });
      expect(readStoredCredentials()).toMatchObject({
        token: 'new-token',
        refreshToken: 'new-refresh',
        email: 'new@example.com',
        serverUrl: 'https://agents-dev.kore.ai',
      });
    });

    test('keeps the existing local secret when credentials are written again', () => {
      writeStoredCredentials({
        token: 'first-token',
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
      const firstWriterSecret = fs.readFileSync(mcpSecretPath());

      writeStoredCredentials({
        token: 'second-token',
        expiresAt: '2099-01-01T00:00:00.000Z',
      });

      expect(fs.readFileSync(mcpSecretPath())).toEqual(firstWriterSecret);
      expect(
        decryptAuthenticatedCredentials(
          fs.readFileSync(primaryCredentialsPath()),
          firstWriterSecret,
        ),
      ).toMatchObject({
        token: 'second-token',
      });
    });

    test('preserves existing refresh token and email when updating only the access token', () => {
      const oldToken = makeJwt({ sub: 'same-user', tenantId: 'source-tenant' });
      const freshToken = makeJwt({ sub: 'same-user', tenantId: 'target-tenant' });
      writeCredentialFile(
        cliCredentialsPath(),
        JSON.stringify({
          token: oldToken,
          refreshToken: 'keep-refresh',
          expiresAt: '2020-01-01T00:00:00.000Z',
          email: 'keep@example.com',
          serverUrl: 'https://agents-dev.kore.ai',
        }),
      );

      writeStoredCredentials({
        token: freshToken,
        expiresAt: '2099-01-01T00:00:00.000Z',
        serverUrl: 'https://agents-dev.kore.ai',
      });

      expect(readStoredCredentials()).toMatchObject({
        token: freshToken,
        refreshToken: 'keep-refresh',
        email: 'keep@example.com',
        serverUrl: 'https://agents-dev.kore.ai',
      });
      expect(JSON.parse(fs.readFileSync(cliCredentialsPath(), 'utf8'))).toMatchObject({
        token: oldToken,
        refreshToken: 'keep-refresh',
        email: 'keep@example.com',
        serverUrl: 'https://agents-dev.kore.ai',
      });
    });

    test('does not inherit refresh credentials when either credential lacks a server origin', () => {
      const oldToken = makeJwt({ sub: 'same-user', tenantId: 'source-tenant' });
      const freshToken = makeJwt({ sub: 'same-user', tenantId: 'target-tenant' });
      writeCredentialFile(
        cliCredentialsPath(),
        JSON.stringify({
          token: oldToken,
          refreshToken: 'unscoped-refresh',
          expiresAt: '2020-01-01T00:00:00.000Z',
          email: 'legacy@example.com',
        }),
      );

      writeStoredCredentials({
        token: freshToken,
        expiresAt: '2099-01-01T00:00:00.000Z',
      });

      expect(readStoredCredentials()).toEqual({
        token: freshToken,
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
    });

    test('does not inherit refresh credentials from a different server origin', () => {
      writeStoredCredentials({
        token: 'qa-token',
        refreshToken: 'qa-refresh-token',
        expiresAt: '2099-01-01T00:00:00.000Z',
        email: 'qa-user@example.com',
        serverUrl: 'https://agents-qa.kore.ai',
      });

      writeStoredCredentials({
        token: 'dev-token',
        expiresAt: '2099-01-02T00:00:00.000Z',
        serverUrl: 'https://agents-dev.kore.ai',
      });

      expect(readStoredCredentials()).toEqual({
        token: 'dev-token',
        expiresAt: '2099-01-02T00:00:00.000Z',
        serverUrl: 'https://agents-dev.kore.ai',
      });
    });

    test('does not inherit refresh credentials from another user on the same server', () => {
      writeStoredCredentials({
        token: makeJwt({ sub: 'first-user', tenantId: 'tenant-1' }),
        refreshToken: 'first-user-refresh',
        expiresAt: '2099-01-01T00:00:00.000Z',
        email: 'first@example.com',
        serverUrl: 'https://agents-dev.kore.ai',
      });

      const secondUserToken = makeJwt({ sub: 'second-user', tenantId: 'tenant-1' });
      writeStoredCredentials({
        token: secondUserToken,
        expiresAt: '2099-01-02T00:00:00.000Z',
        serverUrl: 'https://agents-dev.kore.ai',
      });

      expect(readStoredCredentials()).toEqual({
        token: secondUserToken,
        expiresAt: '2099-01-02T00:00:00.000Z',
        serverUrl: 'https://agents-dev.kore.ai',
      });
    });

    test('restores an exact snapshot without retaining optional candidate metadata', () => {
      const snapshot = {
        token: makeJwt({ sub: 'same-user', tenantId: 'tenant-1' }),
        expiresAt: '2026-01-01T00:00:00.000Z',
        serverUrl: 'https://agents-dev.kore.ai',
      };
      writeStoredCredentials(snapshot);
      writeStoredCredentials({
        ...snapshot,
        token: makeJwt({ sub: 'same-user', tenantId: 'tenant-2' }),
        refreshToken: 'candidate-refresh',
        email: 'candidate@example.com',
      });

      restoreStoredCredentials(snapshot);

      expect(readStoredCredentials()).toEqual(snapshot);
      expect(
        decryptAuthenticatedCredentials(
          fs.readFileSync(primaryCredentialsPath()),
          fs.readFileSync(mcpSecretPath()),
        ),
      ).toEqual(snapshot);
    });

    test('restores every optional credential field when present in the snapshot', () => {
      const snapshot = {
        token: makeJwt({ sub: 'same-user', tenantId: 'tenant-1' }),
        expiresAt: '2099-01-01T00:00:00.000Z',
        refreshToken: 'restored-refresh',
        email: 'restored@example.com',
        serverUrl: 'https://agents-dev.kore.ai',
      };

      restoreStoredCredentials(snapshot);

      expect(readMcpStoredCredentials()).toEqual(snapshot);
    });

    test('restoring an absent snapshot removes only the MCP-owned credential file', () => {
      writeStoredCredentials({
        token: 'candidate-token',
        expiresAt: '2099-01-01T00:00:00.000Z',
      });

      restoreStoredCredentials(null);

      expect(fs.existsSync(primaryCredentialsPath())).toBe(false);
      expect(readStoredCredentials()).toBeNull();
    });

    test('restores physical MCP absence without copying a CLI fallback into the MCP store', () => {
      const fallback = {
        token: makeJwt({ sub: 'legacy-user', tenantId: 'legacy-tenant' }),
        refreshToken: 'legacy-refresh',
        expiresAt: '2099-01-01T00:00:00.000Z',
        serverUrl: 'https://agents-dev.kore.ai',
      };
      writeCredentialFile(cliCredentialsPath(), encryptAuthenticatedCredentials(fallback));
      expect(readStoredCredentials()).toEqual(fallback);
      expect(readMcpStoredCredentials()).toBeNull();

      const physicalSnapshot = readMcpStoredCredentials();
      writeStoredCredentials({
        token: makeJwt({ sub: 'legacy-user', tenantId: 'candidate-tenant' }),
        expiresAt: '2099-01-02T00:00:00.000Z',
        serverUrl: 'https://agents-dev.kore.ai',
      });
      restoreStoredCredentials(physicalSnapshot);

      expect(fs.existsSync(primaryCredentialsPath())).toBe(false);
      expect(readStoredCredentials()).toEqual(fallback);
    });

    test('serializes credential transactions until the current owner releases its lease', async () => {
      const first = await acquireStoredCredentialLock(500);
      let secondSettled = false;
      const secondPromise = acquireStoredCredentialLock(500).then((lock) => {
        secondSettled = true;
        return lock;
      });
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(secondSettled).toBe(false);

      first.release();
      const second = await secondPromise;
      expect(secondSettled).toBe(true);
      second.release();
    });

    test('reads the physical MCP record and makes lock release idempotent', async () => {
      const credentials = {
        token: 'mcp-token',
        expiresAt: '2099-01-01T00:00:00.000Z',
      };
      writeStoredCredentials(credentials);
      expect(readMcpStoredCredentials()).toEqual(credentials);

      const lock = await acquireStoredCredentialLock(100);
      lock.release();
      expect(() => lock.release()).not.toThrow();
    });

    test('does not remove a credential lock whose ownership changed before release', async () => {
      const lock = await acquireStoredCredentialLock(100);
      const lockPath = `${primaryCredentialsPath()}.lock`;
      fs.writeFileSync(lockPath, 'other-owner', 'utf8');

      lock.release();

      expect(fs.readFileSync(lockPath, 'utf8')).toBe('other-owner');
    });

    test('times out behind a live credential-lock owner', async () => {
      const lockPath = `${primaryCredentialsPath()}.lock`;
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fs.writeFileSync(lockPath, `${process.pid}:live-owner`, 'utf8');

      await expect(acquireStoredCredentialLock(0)).rejects.toThrow(
        'Timed out waiting for the MCP credential transaction lock.',
      );
      expect(fs.existsSync(lockPath)).toBe(true);
    });

    test('does not delete a malformed credential-lock owner record', async () => {
      const lockPath = `${primaryCredentialsPath()}.lock`;
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fs.writeFileSync(lockPath, 'not-a-pid:owner', 'utf8');

      await expect(acquireStoredCredentialLock(0)).rejects.toThrow(
        'Timed out waiting for the MCP credential transaction lock.',
      );
      expect(fs.existsSync(lockPath)).toBe(true);
    });

    test('recovers a credential lock left by a dead process', async () => {
      const lockPath = `${primaryCredentialsPath()}.lock`;
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fs.writeFileSync(lockPath, '2147483647:stale-owner', 'utf8');

      const lock = await acquireStoredCredentialLock(100);

      expect(fs.readFileSync(lockPath, 'utf8')).not.toContain('stale-owner');
      lock.release();
    });

    test('compares only context-bearing credential identity fields', () => {
      const base = {
        token: makeJwt({ sub: 'user-1' }),
        refreshToken: 'refresh',
        expiresAt: '2099-01-01T00:00:00.000Z',
        serverUrl: 'https://agents-dev.kore.ai/path',
      };

      expect(storedCredentialIdentityMatches(null, null)).toBe(true);
      expect(storedCredentialIdentityMatches(base, null)).toBe(false);
      expect(
        storedCredentialIdentityMatches(base, {
          ...base,
          expiresAt: '2100-01-01T00:00:00.000Z',
          serverUrl: 'https://AGENTS-DEV.kore.ai/other',
        }),
      ).toBe(true);
      expect(storedCredentialIdentityMatches(base, { ...base, refreshToken: undefined })).toBe(
        false,
      );
    });
  });

  describe('hasValidToken', () => {
    test('returns true when expiresAt is in the future', () => {
      const creds: StoredCredentials = {
        token: 'abc',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      };
      expect(hasValidToken(creds)).toBe(true);
    });

    test('returns false when expiresAt is in the past', () => {
      const creds: StoredCredentials = {
        token: 'abc',
        expiresAt: new Date(Date.now() - 3_600_000).toISOString(),
      };
      expect(hasValidToken(creds)).toBe(false);
    });
  });

  describe('hasRefreshToken', () => {
    test('returns true when refreshToken is present', () => {
      const creds: StoredCredentials = {
        token: 'abc',
        expiresAt: '2099-01-01T00:00:00.000Z',
        refreshToken: 'refresh-abc',
      };
      expect(hasRefreshToken(creds)).toBe(true);
    });

    test('returns false when refreshToken is undefined', () => {
      const creds: StoredCredentials = {
        token: 'abc',
        expiresAt: '2099-01-01T00:00:00.000Z',
      };
      expect(hasRefreshToken(creds)).toBe(false);
    });
  });
});

function primaryCredentialsPath(): string {
  return primaryCredentialsPathValue;
}

function cliCredentialsPath(): string {
  return cliCredentialsPathValue;
}

function mcpSecretPath(): string {
  return mcpSecretPathValue;
}

function legacyCredentialsPath(): string {
  return path.join(process.env['HOME'] ?? '', '.config', 'kore-platform', 'credentials.json');
}

function writeCredentialFile(target: string, body: string | Buffer): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body);
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}

function makeJwt(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'signature',
  ].join('.');
}
