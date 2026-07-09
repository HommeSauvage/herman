import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { removeKey, retrieveKey, storeKey } from "./keychain.js";

describe("keychain", () => {
  beforeEach(() => {
    delete process.env.HERMAN_DESKTOP_DISABLE_KEYCHAIN;
  });

  afterEach(() => {
    delete process.env.HERMAN_DESKTOP_DISABLE_KEYCHAIN;
  });

  it("falls back to disabled when the keychain is unavailable", async () => {
    process.env.HERMAN_DESKTOP_DISABLE_KEYCHAIN = "1";

    expect(await storeKey("test-key")).toBe(false);
    expect(await retrieveKey()).toBeUndefined();

    // Should not throw even when disabled.
    await removeKey();
  });

  it("uses PowerShell PasswordVault on Windows", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });

    const spawnSync = vi.spyOn(Bun, "spawnSync").mockReturnValue({
      exitCode: 0,
      stdout: Buffer.from("test-key"),
      stderr: Buffer.alloc(0),
      success: true,
      resourceUsage: {},
    } as unknown as ReturnType<typeof Bun.spawnSync>);

    try {
      expect(await storeKey("test-key")).toBe(true);
      expect(spawnSync).toHaveBeenCalledWith(
        expect.arrayContaining([
          "powershell.exe",
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          expect.stringContaining("PasswordVault"),
        ]),
        expect.objectContaining({ stdout: "pipe", stderr: "pipe", timeout: 10_000 }),
      );

      expect(await retrieveKey()).toBe("test-key");
    } finally {
      spawnSync.mockRestore();
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });

  it("removes a Windows PasswordVault credential", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });

    const spawnSync = vi.spyOn(Bun, "spawnSync").mockReturnValue({
      exitCode: 0,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      success: true,
      resourceUsage: {},
    } as unknown as ReturnType<typeof Bun.spawnSync>);

    try {
      await removeKey();
      expect(spawnSync).toHaveBeenCalledWith(
        expect.arrayContaining([
          "powershell.exe",
          "-Command",
          expect.stringContaining("$vault.Remove"),
        ]),
        expect.any(Object),
      );
    } finally {
      spawnSync.mockRestore();
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });

  it("uses secret-tool on Linux", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });

    const spawnSync = vi.spyOn(Bun, "spawnSync").mockReturnValue({
      exitCode: 0,
      stdout: Buffer.from("test-key"),
      stderr: Buffer.alloc(0),
      success: true,
      resourceUsage: {},
    } as unknown as ReturnType<typeof Bun.spawnSync>);

    try {
      expect(await storeKey("test-key")).toBe(true);
      expect(spawnSync).toHaveBeenCalledWith(
        [
          "secret-tool",
          "store",
          "--label=Herman Desktop credential encryption key",
          "service",
          "com.clique.herman.desktop",
          "account",
          "credential-encryption-key",
        ],
        expect.objectContaining({
          stdin: Buffer.from("test-key", "utf8"),
          stdout: "pipe",
          stderr: "pipe",
          timeout: 10_000,
        }),
      );
      // Should clear any existing entry before storing to avoid duplicates.
      expect(spawnSync).toHaveBeenCalledWith(
        [
          "secret-tool",
          "clear",
          "service",
          "com.clique.herman.desktop",
          "account",
          "credential-encryption-key",
        ],
        expect.any(Object),
      );

      expect(await retrieveKey()).toBe("test-key");
    } finally {
      spawnSync.mockRestore();
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });

  it("removes a Linux secret-tool credential", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });

    const spawnSync = vi.spyOn(Bun, "spawnSync").mockReturnValue({
      exitCode: 0,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      success: true,
      resourceUsage: {},
    } as unknown as ReturnType<typeof Bun.spawnSync>);

    try {
      await removeKey();
      expect(spawnSync).toHaveBeenCalledWith(
        [
          "secret-tool",
          "clear",
          "service",
          "com.clique.herman.desktop",
          "account",
          "credential-encryption-key",
        ],
        expect.any(Object),
      );
    } finally {
      spawnSync.mockRestore();
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });

  it("falls back when the keychain command is unavailable", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });

    const spawnSync = vi.spyOn(Bun, "spawnSync").mockImplementation(() => {
      throw new Error("secret-tool not found");
    });

    try {
      expect(await storeKey("test-key")).toBe(false);
      expect(await retrieveKey()).toBeUndefined();
      await expect(removeKey()).resolves.toBeUndefined();
    } finally {
      spawnSync.mockRestore();
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });

  it("returns undefined when the keychain command exits with a non-zero code", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });

    const spawnSync = vi.spyOn(Bun, "spawnSync").mockReturnValue({
      exitCode: 1,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from("credential not found"),
      success: false,
      resourceUsage: {},
    } as unknown as ReturnType<typeof Bun.spawnSync>);

    try {
      expect(await storeKey("test-key")).toBe(false);
      expect(await retrieveKey()).toBeUndefined();
    } finally {
      spawnSync.mockRestore();
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  });
});
