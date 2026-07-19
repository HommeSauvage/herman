import { existsSync, statSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  discoverSshKeys,
  generateSshKey,
  readPublicKey,
} from "../../src/bun/publishing/ssh-keygen.js";
import {
  clearHermantAppDir,
  createTestTempDir,
  removeTestTempDir,
  setHermantAppDir,
} from "../helpers/temp-dir.js";

/**
 * generateSshKey accepts an explicit baseDir so tests never touch the real
 * ~/.herman/ssh directory.
 */

let keyDir: string;

function hasSshKeygen(): boolean {
  const which = Bun.spawnSync(["which", "ssh-keygen"], { stdout: "pipe" });
  return which.exitCode === 0;
}

beforeEach(() => {
  keyDir = createTestTempDir("herman-ssh-keygen-");
});

afterEach(() => {
  removeTestTempDir(keyDir);
});

describe("generateSshKey", () => {
  it("generates an ED25519 key pair with correct permissions", async () => {
    if (!hasSshKeygen()) return;

    const result = await generateSshKey("test_key", keyDir);

    expect(existsSync(result.privateKeyPath)).toBe(true);
    expect(existsSync(`${result.privateKeyPath}.pub`)).toBe(true);
    expect(result.privateKeyPath.startsWith(keyDir)).toBe(true);
    expect(result.publicKey).toMatch(/^ssh-ed25519 /);
    expect(result.publicKey).toContain("herman-deploy");

    const mode = statSync(result.privateKeyPath).mode;
    expect(mode & 0o777).toBe(0o600);
  });

  it("is idempotent — returns the existing key on a second call", async () => {
    if (!hasSshKeygen()) return;

    const first = await generateSshKey("test_key", keyDir);
    const second = await generateSshKey("test_key", keyDir);

    expect(second.privateKeyPath).toBe(first.privateKeyPath);
    expect(second.publicKey).toBe(first.publicKey);
  });

  it("uses the default key name when none is given", async () => {
    if (!hasSshKeygen()) return;

    const result = await generateSshKey(undefined, keyDir);
    expect(result.privateKeyPath.endsWith("herman_deploy_key")).toBe(true);
  });

  it("recovers from a partial remnant (private key without .pub)", async () => {
    if (!hasSshKeygen()) return;

    // Simulate a crashed first run: private key exists, .pub missing.
    const first = await generateSshKey("test_key", keyDir);
    const { unlinkSync } = await import("node:fs");
    unlinkSync(`${first.privateKeyPath}.pub`);

    const second = await generateSshKey("test_key", keyDir);
    expect(existsSync(`${second.privateKeyPath}.pub`)).toBe(true);
    expect(second.publicKey).toMatch(/^ssh-ed25519 /);
  });
});

describe("readPublicKey", () => {
  it("reads the .pub file for a given private key path", async () => {
    if (!hasSshKeygen()) return;

    const key = await generateSshKey("read_key", keyDir);
    expect(readPublicKey(key.privateKeyPath)).toBe(key.publicKey);
  });

  it("reads when given the .pub path directly", async () => {
    if (!hasSshKeygen()) return;

    const key = await generateSshKey("read_key2", keyDir);
    expect(readPublicKey(`${key.privateKeyPath}.pub`)).toBe(key.publicKey);
  });

  it("throws when the public key file does not exist", () => {
    expect(() => readPublicKey("/nonexistent/key/path")).toThrow(/not found/);
  });
});

describe("discoverSshKeys", () => {
  it("returns an array (possibly empty) without throwing", () => {
    const keys = discoverSshKeys();
    expect(Array.isArray(keys)).toBe(true);
  });

  it("each discovered key has name, path, and publicKey (path has no .pub suffix)", () => {
    for (const key of discoverSshKeys()) {
      expect(typeof key.name).toBe("string");
      expect(typeof key.path).toBe("string");
      expect(key.publicKey.length).toBeGreaterThan(0);
      expect(key.path).not.toMatch(/\.pub$/);
    }
  });
});

describe("app dir integration", () => {
  let appDir: string | undefined;

  afterEach(() => {
    if (appDir) {
      clearHermantAppDir(appDir);
      appDir = undefined;
    }
  });

  it("defaults to sshDir() under HERMAN_APP_DIR when no baseDir is given", async () => {
    if (!hasSshKeygen()) return;

    appDir = createTestTempDir("herman-ssh-appdir-");
    setHermantAppDir(appDir);

    const result = await generateSshKey("env_key");
    expect(result.privateKeyPath).toBe(`${appDir}/ssh/env_key`);
  });
});
