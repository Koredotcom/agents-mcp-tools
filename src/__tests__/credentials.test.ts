/**
 * Tests for credentials reader
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { StoredCredentials } from "../client/credentials.js";
import type * as CredentialsModule from "../client/credentials.js";

const ENCRYPTION_KEY = "kore-platform-cli-v1";
const CONF_IV_BYTES = 16;
const CONF_PBKDF2_ITERATIONS = 10_000;
const CONF_KEY_BYTES = 32;

let tempRoot = "";
let originalHome: string | undefined;
let originalXdgConfigHome: string | undefined;
let primaryCredentialsPathValue = "";
let readStoredCredentials: typeof CredentialsModule.readStoredCredentials;
let writeStoredCredentials: typeof CredentialsModule.writeStoredCredentials;
let hasValidToken: typeof CredentialsModule.hasValidToken;
let hasRefreshToken: typeof CredentialsModule.hasRefreshToken;

function encryptConfV12(data: Record<string, unknown>): Buffer {
  const initializationVector = crypto.randomBytes(CONF_IV_BYTES);
  const password = crypto.pbkdf2Sync(
    ENCRYPTION_KEY,
    initializationVector.toString(),
    CONF_PBKDF2_ITERATIONS,
    CONF_KEY_BYTES,
    "sha512",
  );
  const cipher = crypto.createCipheriv(
    "aes-256-cbc",
    password,
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

function encryptLegacyConf(data: Record<string, unknown>): string {
  const key = crypto.createHash("sha256").update(ENCRYPTION_KEY).digest();
  const initializationVector = crypto.randomBytes(CONF_IV_BYTES);
  const cipher = crypto.createCipheriv(
    "aes-256-cbc",
    key,
    initializationVector,
  );
  const serialized = JSON.stringify(data);

  return Buffer.concat([
    initializationVector,
    cipher.update(serialized, "utf8"),
    cipher.final(),
  ]).toString("hex");
}

describe("credentials", () => {
  beforeAll(async () => {
    originalHome = process.env["HOME"];
    originalXdgConfigHome = process.env["XDG_CONFIG_HOME"];
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-debug-credentials-"));
    process.env["HOME"] = path.join(tempRoot, "home");
    process.env["XDG_CONFIG_HOME"] = path.join(tempRoot, "xdg-config");
    fs.mkdirSync(process.env["HOME"], { recursive: true });

    vi.resetModules();
    const envPaths = (await import("env-paths")).default;
    primaryCredentialsPathValue = path.join(
      envPaths("kore-platform", { suffix: "nodejs" }).config,
      "credentials.json",
    );
    const credentials = await import("../client/credentials.js");
    readStoredCredentials = credentials.readStoredCredentials;
    writeStoredCredentials = credentials.writeStoredCredentials;
    hasValidToken = credentials.hasValidToken;
    hasRefreshToken = credentials.hasRefreshToken;
  });

  beforeEach(() => {
    fs.rmSync(path.dirname(primaryCredentialsPath()), {
      recursive: true,
      force: true,
    });
    fs.rmSync(path.dirname(legacyCredentialsPath()), {
      recursive: true,
      force: true,
    });
    fs.mkdirSync(process.env["HOME"] ?? "", { recursive: true });
  });

  afterAll(() => {
    restoreEnv("HOME", originalHome);
    restoreEnv("XDG_CONFIG_HOME", originalXdgConfigHome);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  describe("readStoredCredentials", () => {
    test("returns null when neither credential store exists", () => {
      expect(readStoredCredentials()).toBeNull();
    });

    test.each([
      {
        name: "empty file",
        body: "",
      },
      {
        name: "invalid JSON and not encrypted",
        body: "not-json-and-not-valid-hex",
      },
      {
        name: "missing token field",
        body: JSON.stringify({ expiresAt: "2099-01-01T00:00:00.000Z" }),
      },
      {
        name: "missing expiresAt field",
        body: JSON.stringify({ token: "abc123" }),
      },
    ])(
      "returns null when the primary credential file has $name",
      ({ body }) => {
        writeCredentialFile(primaryCredentialsPath(), body);

        expect(readStoredCredentials()).toBeNull();
      },
    );

    test("reads plain JSON credentials", () => {
      writeCredentialFile(
        primaryCredentialsPath(),
        JSON.stringify({
          token: "abc123",
          expiresAt: "2099-01-01T00:00:00.000Z",
          email: "user@example.com",
        }),
      );

      expect(readStoredCredentials()).toMatchObject({
        token: "abc123",
        expiresAt: "2099-01-01T00:00:00.000Z",
        email: "user@example.com",
      });
    });

    test("includes refreshToken when present", () => {
      writeCredentialFile(
        primaryCredentialsPath(),
        JSON.stringify({
          token: "abc123",
          expiresAt: "2099-01-01T00:00:00.000Z",
          refreshToken: "refresh-abc",
        }),
      );

      expect(readStoredCredentials()).toMatchObject({
        token: "abc123",
        refreshToken: "refresh-abc",
      });
    });

    test("reads encrypted Conf v12 CLI credentials", () => {
      writeCredentialFile(
        primaryCredentialsPath(),
        encryptConfV12({
          token: "encrypted-token",
          expiresAt: "2099-01-01T00:00:00.000Z",
          refreshToken: "encrypted-refresh",
          email: "encrypted@example.com",
        }),
      );

      expect(readStoredCredentials()).toMatchObject({
        token: "encrypted-token",
        refreshToken: "encrypted-refresh",
        email: "encrypted@example.com",
      });
    });

    test("falls back to legacy .config credentials when CLI Conf store is absent", () => {
      writeCredentialFile(
        legacyCredentialsPath(),
        JSON.stringify({
          token: "legacy-token",
          expiresAt: "2099-01-01T00:00:00.000Z",
          refreshToken: "legacy-refresh",
        }),
      );

      expect(readStoredCredentials()).toMatchObject({
        token: "legacy-token",
        refreshToken: "legacy-refresh",
      });
    });

    test("prefers CLI Conf store over stale legacy credentials", () => {
      writeCredentialFile(
        primaryCredentialsPath(),
        encryptConfV12({
          token: "primary-token",
          expiresAt: "2099-01-01T00:00:00.000Z",
          refreshToken: "primary-refresh",
        }),
      );
      writeCredentialFile(
        legacyCredentialsPath(),
        JSON.stringify({
          token: "legacy-token",
          expiresAt: "2099-01-01T00:00:00.000Z",
        }),
      );

      expect(readStoredCredentials()).toMatchObject({
        token: "primary-token",
        refreshToken: "primary-refresh",
      });
    });

    test("reads older hand-rolled encrypted credentials for backward compatibility", () => {
      writeCredentialFile(
        primaryCredentialsPath(),
        encryptLegacyConf({
          token: "legacy-encrypted-token",
          expiresAt: "2099-01-01T00:00:00.000Z",
          email: "legacy-encrypted@example.com",
        }),
      );

      expect(readStoredCredentials()).toMatchObject({
        token: "legacy-encrypted-token",
        email: "legacy-encrypted@example.com",
      });
    });

    test("returns null when the credential path exists but cannot be read as a file", () => {
      fs.mkdirSync(primaryCredentialsPath(), { recursive: true });

      expect(readStoredCredentials()).toBeNull();
    });
  });

  describe("writeStoredCredentials", () => {
    test("writes encrypted credentials to the CLI Conf store", () => {
      writeStoredCredentials({
        token: "new-token",
        refreshToken: "new-refresh",
        expiresAt: "2099-01-01T00:00:00.000Z",
        email: "new@example.com",
        serverUrl: "https://agents-dev.kore.ai",
      });

      const stat = fs.statSync(primaryCredentialsPath());
      expect(stat.mode & 0o777).toBe(0o600);
      expect(
        fs.statSync(path.dirname(primaryCredentialsPath())).mode & 0o777,
      ).toBe(0o700);
      expect(fs.readFileSync(primaryCredentialsPath())).toBeInstanceOf(Buffer);
      expect(readStoredCredentials()).toMatchObject({
        token: "new-token",
        refreshToken: "new-refresh",
        email: "new@example.com",
        serverUrl: "https://agents-dev.kore.ai",
      });
    });

    test("preserves existing refresh token and email when updating only the access token", () => {
      writeCredentialFile(
        primaryCredentialsPath(),
        encryptConfV12({
          token: "old-token",
          refreshToken: "keep-refresh",
          expiresAt: "2020-01-01T00:00:00.000Z",
          email: "keep@example.com",
        }),
      );

      writeStoredCredentials({
        token: "fresh-token",
        expiresAt: "2099-01-01T00:00:00.000Z",
      });

      expect(readStoredCredentials()).toMatchObject({
        token: "fresh-token",
        refreshToken: "keep-refresh",
        email: "keep@example.com",
      });
    });
  });

  describe("hasValidToken", () => {
    test("returns true when expiresAt is in the future", () => {
      const creds: StoredCredentials = {
        token: "abc",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      };
      expect(hasValidToken(creds)).toBe(true);
    });

    test("returns false when expiresAt is in the past", () => {
      const creds: StoredCredentials = {
        token: "abc",
        expiresAt: new Date(Date.now() - 3_600_000).toISOString(),
      };
      expect(hasValidToken(creds)).toBe(false);
    });
  });

  describe("hasRefreshToken", () => {
    test("returns true when refreshToken is present", () => {
      const creds: StoredCredentials = {
        token: "abc",
        expiresAt: "2099-01-01T00:00:00.000Z",
        refreshToken: "refresh-abc",
      };
      expect(hasRefreshToken(creds)).toBe(true);
    });

    test("returns false when refreshToken is undefined", () => {
      const creds: StoredCredentials = {
        token: "abc",
        expiresAt: "2099-01-01T00:00:00.000Z",
      };
      expect(hasRefreshToken(creds)).toBe(false);
    });
  });
});

function primaryCredentialsPath(): string {
  return primaryCredentialsPathValue;
}

function legacyCredentialsPath(): string {
  return path.join(
    process.env["HOME"] ?? "",
    ".config",
    "kore-platform",
    "credentials.json",
  );
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
