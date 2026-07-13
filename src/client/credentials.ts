/**
 * Credentials Reader
 *
 * Reads stored credentials from the kore-platform CLI credential store.
 * Compatible with the kore-platform-cli credential storage.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import envPaths from "env-paths";

export interface StoredCredentials {
  token: string;
  refreshToken?: string;
  expiresAt: string;
  email?: string;
  serverUrl?: string;
}

const CONF_PROJECT_NAME = "kore-platform";
const CONF_PROJECT_SUFFIX = "nodejs";
const CONF_CONFIG_NAME = "credentials";
const CONF_FILE_EXTENSION = "json";
const CONF_ENCRYPTION_KEY = "kore-platform-cli-v1";
const CONF_ENCRYPTION_ALGORITHM = "aes-256-cbc";
const CONF_IV_BYTES = 16;
const CONF_SEPARATOR_BYTES = 1;
const CONF_PBKDF2_ITERATIONS = 10_000;
const CONF_KEY_BYTES = 32;
const CONF_PBKDF2_DIGEST = "sha512";
const LEGACY_CONFIG_DIR_NAME = "kore-platform";
const CREDENTIAL_DIRECTORY_MODE = 0o700;
const CREDENTIAL_FILE_MODE = 0o600;

function getConfConfigDir(): string {
  return envPaths(CONF_PROJECT_NAME, { suffix: CONF_PROJECT_SUFFIX }).config;
}

function getPrimaryCredentialsPath(): string {
  return path.join(
    getConfConfigDir(),
    `${CONF_CONFIG_NAME}.${CONF_FILE_EXTENSION}`,
  );
}

function getLegacyCredentialsPath(): string {
  const configDir = path.join(os.homedir(), ".config");
  return path.join(
    configDir,
    LEGACY_CONFIG_DIR_NAME,
    `${CONF_CONFIG_NAME}.${CONF_FILE_EXTENSION}`,
  );
}

function getCredentialsPaths(): string[] {
  const paths = [getPrimaryCredentialsPath(), getLegacyCredentialsPath()];
  return [...new Set(paths)];
}

function toBuffer(raw: string | Buffer): Buffer {
  return Buffer.isBuffer(raw) ? raw : Buffer.from(raw, "utf8");
}

function parseJson(raw: string | Buffer): Record<string, unknown> | null {
  const text = toBuffer(raw).toString("utf8").trim();
  if (!text) return null;

  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch (_err) {
    return null;
  }
}

function deriveConfKey(initializationVector: Buffer): Buffer {
  return crypto.pbkdf2Sync(
    CONF_ENCRYPTION_KEY,
    initializationVector.toString(),
    CONF_PBKDF2_ITERATIONS,
    CONF_KEY_BYTES,
    CONF_PBKDF2_DIGEST,
  );
}

function decryptConfV12(raw: string | Buffer): string {
  const data = toBuffer(raw);
  const minimumBytes = CONF_IV_BYTES + CONF_SEPARATOR_BYTES + 1;
  if (data.length < minimumBytes || data[CONF_IV_BYTES] !== ":".charCodeAt(0)) {
    throw new Error("Not a Conf v12 encrypted payload");
  }

  const initializationVector = data.subarray(0, CONF_IV_BYTES);
  const encrypted = data.subarray(CONF_IV_BYTES + CONF_SEPARATOR_BYTES);
  const decipher = crypto.createDecipheriv(
    CONF_ENCRYPTION_ALGORITHM,
    deriveConfKey(initializationVector),
    initializationVector,
  );

  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString(
    "utf8",
  );
}

function decryptLegacyConf(raw: string | Buffer): string {
  const text = toBuffer(raw).toString("utf8").trim();
  const key = crypto.createHash("sha256").update(CONF_ENCRYPTION_KEY).digest();
  const data = Buffer.from(text, "hex");
  const initializationVector = data.subarray(0, CONF_IV_BYTES);
  const encrypted = data.subarray(CONF_IV_BYTES);

  const decipher = crypto.createDecipheriv(
    CONF_ENCRYPTION_ALGORITHM,
    key,
    initializationVector,
  );
  let decrypted = decipher.update(encrypted, undefined, "utf8");
  decrypted += decipher.final("utf8");

  return decrypted;
}

function parseCredentialData(
  raw: string | Buffer,
): Record<string, unknown> | null {
  const json = parseJson(raw);
  if (json) return json;

  try {
    return parseJson(decryptConfV12(raw));
  } catch (_err) {
    // Try the older hand-rolled format used by early MCP tooling.
  }

  try {
    return parseJson(decryptLegacyConf(raw));
  } catch (_err) {
    return null;
  }
}

function getStringField(
  data: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = data[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function toStoredCredentials(
  data: Record<string, unknown>,
): StoredCredentials | null {
  const token = getStringField(data, "token");
  const expiresAt = getStringField(data, "expiresAt");

  if (!token || !expiresAt) {
    return null;
  }

  return {
    token,
    refreshToken: getStringField(data, "refreshToken"),
    expiresAt,
    email: getStringField(data, "email"),
    serverUrl: getStringField(data, "serverUrl"),
  };
}

function readCredentialDataFromPath(
  credPath: string,
): Record<string, unknown> | null {
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

function encryptConfV12(data: Record<string, unknown>): Buffer {
  const initializationVector = crypto.randomBytes(CONF_IV_BYTES);
  const cipher = crypto.createCipheriv(
    CONF_ENCRYPTION_ALGORITHM,
    deriveConfKey(initializationVector),
    initializationVector,
  );
  const serialized = Buffer.from(JSON.stringify(data, undefined, "\t"), "utf8");

  return Buffer.concat([
    initializationVector,
    Buffer.from(":"),
    cipher.update(serialized),
    cipher.final(),
  ]);
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

/**
 * Write credentials to the CLI-compatible Conf store.
 * Creates the directory if it doesn't exist.
 */
export function writeStoredCredentials(creds: StoredCredentials): void {
  const credPath = getPrimaryCredentialsPath();
  const dir = path.dirname(credPath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: CREDENTIAL_DIRECTORY_MODE });
  }
  fs.chmodSync(dir, CREDENTIAL_DIRECTORY_MODE);

  const existing = readCredentialDataFromPath(credPath) || {};
  const data: Record<string, unknown> = {
    ...existing,
    token: creds.token,
    expiresAt: creds.expiresAt,
  };

  if (creds.refreshToken) {
    data["refreshToken"] = creds.refreshToken;
  }

  if (creds.email) {
    data["email"] = creds.email;
  }
  if (creds.serverUrl) {
    data["serverUrl"] = creds.serverUrl;
  }

  const temporaryPath = `${credPath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, encryptConfV12(data), {
      mode: CREDENTIAL_FILE_MODE,
    });
    fs.renameSync(temporaryPath, credPath);
    fs.chmodSync(credPath, CREDENTIAL_FILE_MODE);
  } finally {
    if (fs.existsSync(temporaryPath)) {
      fs.unlinkSync(temporaryPath);
    }
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
