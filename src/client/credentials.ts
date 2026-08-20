/**
 * Credentials Reader
 *
 * Reads stored credentials from the MCP-debug credential store, with read-only
 * fallback to historical kore-platform credential files.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import envPaths from 'env-paths';

export interface StoredCredentials {
  token: string;
  refreshToken?: string;
  expiresAt: string;
  email?: string;
  serverUrl?: string;
}

const CONF_PROJECT_NAME = 'kore-platform';
const CONF_PROJECT_SUFFIX = 'nodejs';
const CONF_CONFIG_NAME = 'credentials';
const MCP_CONFIG_NAME = 'mcp-debug-credentials';
const MCP_SECRET_NAME = 'mcp-debug-credentials.key';
const CONF_FILE_EXTENSION = 'json';
const CONF_ENCRYPTION_KEY = 'kore-platform-cli-v1';
const AUTHENTICATED_ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const AUTHENTICATED_CREDENTIALS_PREFIX = 'kore-platform-credentials-v2:';
const GCM_IV_BYTES = 12;
const GCM_AUTH_TAG_BYTES = 16;
const CONF_PBKDF2_ITERATIONS = 10_000;
const CONF_KEY_BYTES = 32;
const CONF_PBKDF2_DIGEST = 'sha512';
const LEGACY_CONFIG_DIR_NAME = 'kore-platform';
const CREDENTIAL_DIRECTORY_MODE = 0o700;
const CREDENTIAL_FILE_MODE = 0o600;
const CREDENTIAL_LOCK_RETRY_MS = 25;
const CREDENTIAL_LOCK_TIMEOUT_MS = 15_000;

export interface StoredCredentialLock {
  release(): void;
}

function getConfConfigDir(): string {
  return envPaths(CONF_PROJECT_NAME, { suffix: CONF_PROJECT_SUFFIX }).config;
}

function getMcpCredentialsPath(): string {
  return path.join(getConfConfigDir(), `${MCP_CONFIG_NAME}.${CONF_FILE_EXTENSION}`);
}

function getMcpSecretPath(): string {
  return path.join(getConfConfigDir(), MCP_SECRET_NAME);
}

function getCliCredentialsPath(): string {
  return path.join(getConfConfigDir(), `${CONF_CONFIG_NAME}.${CONF_FILE_EXTENSION}`);
}

function getLegacyCredentialsPath(): string {
  const configDir = path.join(os.homedir(), '.config');
  return path.join(configDir, LEGACY_CONFIG_DIR_NAME, `${CONF_CONFIG_NAME}.${CONF_FILE_EXTENSION}`);
}

function getCredentialsPaths(): string[] {
  const paths = [getMcpCredentialsPath(), getCliCredentialsPath(), getLegacyCredentialsPath()];
  return [...new Set(paths)];
}

function toBuffer(raw: string | Buffer): Buffer {
  return Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf8');
}

function parseJson(raw: string | Buffer): Record<string, unknown> | null {
  const text = toBuffer(raw).toString('utf8').trim();
  if (!text) return null;

  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch (_err) {
    return null;
  }
}

function deriveKey(secret: string | Buffer, initializationVector: Buffer): Buffer {
  return crypto.pbkdf2Sync(
    secret,
    initializationVector.toString(),
    CONF_PBKDF2_ITERATIONS,
    CONF_KEY_BYTES,
    CONF_PBKDF2_DIGEST,
  );
}

function getExistingMcpSecret(): Buffer | null {
  try {
    const secretPath = getMcpSecretPath();
    if (!fs.existsSync(secretPath)) {
      return null;
    }
    const secret = fs.readFileSync(secretPath);
    return secret.length > 0 ? secret : null;
  } catch (_err) {
    return null;
  }
}

function getOrCreateMcpSecret(): Buffer {
  const existing = getExistingMcpSecret();
  if (existing) {
    return existing;
  }

  const secretPath = getMcpSecretPath();
  const dir = path.dirname(secretPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: CREDENTIAL_DIRECTORY_MODE });
  }
  fs.chmodSync(dir, CREDENTIAL_DIRECTORY_MODE);

  const secret = crypto.randomBytes(CONF_KEY_BYTES);
  const encodedSecret = secret.toString('hex');
  let fd: number | undefined;
  try {
    fd = fs.openSync(secretPath, 'wx', CREDENTIAL_FILE_MODE);
    fs.writeFileSync(fd, encodedSecret);
    fs.chmodSync(secretPath, CREDENTIAL_FILE_MODE);
    return Buffer.from(encodedSecret, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const racedSecret = getExistingMcpSecret();
      if (racedSecret) {
        return racedSecret;
      }
    }
    throw error;
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}

function getAuthenticatedCredentialSecrets(options: { create: boolean }): Array<string | Buffer> {
  const secrets: Array<string | Buffer> = [];
  const localSecret = options.create ? getOrCreateMcpSecret() : getExistingMcpSecret();
  if (localSecret) {
    secrets.push(localSecret);
  }
  // Read-only fallback for v2 files written before the per-user secret existed.
  secrets.push(CONF_ENCRYPTION_KEY);
  return secrets;
}

function decryptAuthenticatedCredentials(raw: string | Buffer): string {
  const text = toBuffer(raw).toString('utf8').trim();
  if (!text.startsWith(AUTHENTICATED_CREDENTIALS_PREFIX)) {
    throw new Error('Not an authenticated credentials payload');
  }

  const encoded = text.slice(AUTHENTICATED_CREDENTIALS_PREFIX.length);
  const [initializationVectorHex, authTagHex, encryptedHex] = encoded.split(':');
  if (!initializationVectorHex || !authTagHex || !encryptedHex) {
    throw new Error('Authenticated credentials payload is malformed');
  }

  const initializationVector = Buffer.from(initializationVectorHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const encrypted = Buffer.from(encryptedHex, 'hex');
  if (initializationVector.length !== GCM_IV_BYTES || authTag.length !== GCM_AUTH_TAG_BYTES) {
    throw new Error('Authenticated credentials payload has invalid cryptographic parameters');
  }

  let lastError: unknown;
  for (const secret of getAuthenticatedCredentialSecrets({ create: false })) {
    try {
      const decipher = crypto.createDecipheriv(
        AUTHENTICATED_ENCRYPTION_ALGORITHM,
        deriveKey(secret, initializationVector),
        initializationVector,
        { authTagLength: GCM_AUTH_TAG_BYTES },
      );
      decipher.setAuthTag(authTag);
      return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Unable to decrypt credentials');
}

function parseCredentialData(raw: string | Buffer): Record<string, unknown> | null {
  const json = parseJson(raw);
  if (json) return json;

  try {
    return parseJson(decryptAuthenticatedCredentials(raw));
  } catch (_err) {
    // Legacy unauthenticated/CBC credential formats are no longer accepted.
    // Callers fall back to interactive device auth and rewrite GCM credentials.
    return null;
  }
}

function getStringField(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function toStoredCredentials(data: Record<string, unknown>): StoredCredentials | null {
  const token = getStringField(data, 'token');
  const expiresAt = getStringField(data, 'expiresAt');

  if (!token || !expiresAt) {
    return null;
  }

  return {
    token,
    refreshToken: getStringField(data, 'refreshToken'),
    expiresAt,
    email: getStringField(data, 'email'),
    serverUrl: getStringField(data, 'serverUrl'),
  };
}

function readCredentialDataFromPath(credPath: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(credPath)) {
      return null;
    }

    const raw = fs.readFileSync(credPath);
    return parseCredentialData(raw);
  } catch (_err) {
    return null;
  }
}

function encryptAuthenticatedCredentials(data: Record<string, unknown>): Buffer {
  const initializationVector = crypto.randomBytes(GCM_IV_BYTES);
  const [secret] = getAuthenticatedCredentialSecrets({ create: true });
  const cipher = crypto.createCipheriv(
    AUTHENTICATED_ENCRYPTION_ALGORITHM,
    deriveKey(secret, initializationVector),
    initializationVector,
    { authTagLength: GCM_AUTH_TAG_BYTES },
  );
  const serialized = Buffer.from(JSON.stringify(data, undefined, '\t'), 'utf8');
  const encrypted = Buffer.concat([cipher.update(serialized), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.from(
    `${AUTHENTICATED_CREDENTIALS_PREFIX}${initializationVector.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`,
    'utf8',
  );
}

/**
 * Read stored credentials from the kore-platform credentials file.
 * Returns null if no credentials found, expired, or unreadable.
 */
export function readStoredCredentials(): StoredCredentials | null {
  for (const credPath of getCredentialsPaths()) {
    const data = readCredentialDataFromPath(credPath);
    if (!data) continue;

    const credentials = toStoredCredentials(data);
    if (credentials) return credentials;
  }

  return null;
}

/** Read only the physical MCP-owned record, excluding compatibility fallbacks. */
export function readMcpStoredCredentials(): StoredCredentials | null {
  const data = readCredentialDataFromPath(getMcpCredentialsPath());
  return data ? toStoredCredentials(data) : null;
}

/**
 * Acquire the credential-store transaction lease. The lease is backed by an
 * exclusive lock file so separate MCP server processes cannot interleave a
 * credential write with another process's transport promotion or rollback.
 */
export async function acquireStoredCredentialLock(
  timeoutMs = CREDENTIAL_LOCK_TIMEOUT_MS,
): Promise<StoredCredentialLock> {
  const credentialPath = getMcpCredentialsPath();
  const lockPath = `${credentialPath}.lock`;
  const directory = path.dirname(lockPath);
  const owner = `${process.pid}:${crypto.randomUUID()}`;
  const deadline = Date.now() + timeoutMs;

  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true, mode: CREDENTIAL_DIRECTORY_MODE });
  }
  fs.chmodSync(directory, CREDENTIAL_DIRECTORY_MODE);

  while (true) {
    try {
      const fd = fs.openSync(lockPath, 'wx', CREDENTIAL_FILE_MODE);
      try {
        fs.writeFileSync(fd, owner, 'utf8');
      } catch (error) {
        try {
          fs.unlinkSync(lockPath);
        } catch (_unlinkError) {
          // Preserve the original write failure.
        }
        throw error;
      } finally {
        fs.closeSync(fd);
      }
      let released = false;
      return {
        release: () => {
          if (released) return;
          released = true;
          try {
            if (fs.readFileSync(lockPath, 'utf8') === owner) fs.unlinkSync(lockPath);
          } catch (_error) {
            // A crashed/stale lease may already have been removed.
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      removeDeadCredentialLock(lockPath);
      if (Date.now() >= deadline) {
        throw new Error('Timed out waiting for the MCP credential transaction lock.');
      }
      await new Promise<void>((resolve) => setTimeout(resolve, CREDENTIAL_LOCK_RETRY_MS));
    }
  }
}

function removeDeadCredentialLock(lockPath: string): void {
  try {
    const owner = fs.readFileSync(lockPath, 'utf8');
    const pid = Number(owner.split(':', 1)[0]);
    if (!Number.isSafeInteger(pid) || pid <= 0) return;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') fs.unlinkSync(lockPath);
    }
  } catch (_error) {
    // The lock may have been released between the failed open and inspection.
  }
}

/** Compare context-bearing credential fields while ignoring incidental metadata. */
export function storedCredentialIdentityMatches(
  left: StoredCredentials | null,
  right: StoredCredentials | null,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.token === right.token &&
    (left.refreshToken ?? null) === (right.refreshToken ?? null) &&
    normalizeServerOrigin(left.serverUrl) === normalizeServerOrigin(right.serverUrl)
  );
}

/**
 * Write credentials to the authenticated local credential store.
 * Creates the directory if it doesn't exist.
 */
export function writeStoredCredentials(creds: StoredCredentials): void {
  const existingCredentials = readStoredCredentials();
  const canPreserveExistingMetadata =
    existingCredentials !== null && credentialsShareMetadataScope(existingCredentials, creds);
  const data: Record<string, unknown> = {
    ...(canPreserveExistingMetadata ? existingCredentials : {}),
    token: creds.token,
    expiresAt: creds.expiresAt,
  };

  if (creds.refreshToken) {
    data['refreshToken'] = creds.refreshToken;
  }

  if (creds.email) {
    data['email'] = creds.email;
  }
  if (creds.serverUrl) {
    data['serverUrl'] = creds.serverUrl;
  }

  replaceCredentialFile(data);
}

/**
 * Restore the MCP-owned credential record exactly, without metadata merging.
 * A null snapshot means the record did not exist and removes only the MCP file.
 */
export function restoreStoredCredentials(snapshot: StoredCredentials | null): void {
  if (!snapshot) {
    clearStoredCredentials();
    return;
  }

  const data: Record<string, unknown> = {
    token: snapshot.token,
    expiresAt: snapshot.expiresAt,
    ...(snapshot.refreshToken !== undefined ? { refreshToken: snapshot.refreshToken } : {}),
    ...(snapshot.email !== undefined ? { email: snapshot.email } : {}),
    ...(snapshot.serverUrl !== undefined ? { serverUrl: snapshot.serverUrl } : {}),
  };
  replaceCredentialFile(data);
}

function replaceCredentialFile(data: Record<string, unknown>): void {
  const credPath = getMcpCredentialsPath();
  const dir = path.dirname(credPath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: CREDENTIAL_DIRECTORY_MODE });
  }
  fs.chmodSync(dir, CREDENTIAL_DIRECTORY_MODE);

  const temporaryPath = `${credPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, encryptAuthenticatedCredentials(data), {
      mode: CREDENTIAL_FILE_MODE,
    });
    // Finish every fallible metadata operation before rename. Once rename
    // succeeds, the new credential is authoritative and this function cannot
    // report a failure that would make callers attempt an unsafe rollback.
    fs.chmodSync(temporaryPath, CREDENTIAL_FILE_MODE);
    fs.renameSync(temporaryPath, credPath);
  } finally {
    if (fs.existsSync(temporaryPath)) {
      fs.unlinkSync(temporaryPath);
    }
  }
}

/** Remove only the MCP-owned credential record. Historical CLI files remain untouched. */
export function clearStoredCredentials(): void {
  const credPath = getMcpCredentialsPath();
  if (fs.existsSync(credPath)) {
    fs.unlinkSync(credPath);
  }
}

/**
 * Check if stored credentials have a valid (non-expired) access token.
 */
export function hasValidToken(creds: StoredCredentials): boolean {
  return new Date(creds.expiresAt) > new Date();
}

/**
 * Check if stored credentials have a refresh token for renewal.
 */
export function hasRefreshToken(creds: StoredCredentials): boolean {
  return !!creds.refreshToken;
}

function credentialsShareMetadataScope(
  existing: StoredCredentials,
  incoming: StoredCredentials,
): boolean {
  const existingOrigin = normalizeServerOrigin(existing.serverUrl);
  const incomingOrigin = normalizeServerOrigin(incoming.serverUrl);
  if (!existingOrigin || !incomingOrigin || existingOrigin !== incomingOrigin) return false;

  const existingSubject = readJwtSubject(existing.token);
  const incomingSubject = readJwtSubject(incoming.token);
  return existingSubject !== null && existingSubject === incomingSubject;
}

function normalizeServerOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin.toLowerCase();
  } catch (_error) {
    return null;
  }
}

function readJwtSubject(token: string): string | null {
  try {
    const payloadSegment = token.split('.')[1];
    if (!payloadSegment) return null;
    const value = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8')) as unknown;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const subject = record.sub ?? record.userId;
    return typeof subject === 'string' && subject.trim().length > 0 ? subject : null;
  } catch (_error) {
    return null;
  }
}
