import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { clearHermantAppDir, createTestTempDir, setHermantAppDir } from "../helpers/temp-dir.js";

/**
 * Tests the REAL publishing store (src/bun/publishing/store.ts) against a
 * real SQLite database in a temp HERMAN_APP_DIR. The API token must round-trip
 * through the encrypted credential store (keychain disabled → encrypted file
 * fallback), never through the SQLite row.
 */

let tempDir: string;

beforeEach(() => {
  tempDir = createTestTempDir("herman-publishing-store-");
  process.env.HERMAN_DESKTOP_DISABLE_KEYCHAIN = "1";
  setHermantAppDir(tempDir);
});

afterEach(async () => {
  const { __resetDbForTests } = await import("../../src/bun/persistence.js");
  __resetDbForTests();
  clearHermantAppDir(tempDir);
  delete process.env.HERMAN_DESKTOP_DISABLE_KEYCHAIN;
});

async function importStore() {
  const { __resetDbForTests } = await import("../../src/bun/persistence.js");
  __resetDbForTests(); // point the singleton at this test's temp dir
  return import("../../src/bun/publishing/store.js");
}

function rawRow(projectPath: string): Record<string, unknown> | null {
  const db = new Database(join(tempDir, "herman.db"), { readonly: true });
  try {
    return (
      db
        .query<Record<string, unknown>, [string]>(
          "SELECT * FROM publishing_config WHERE project_path = ?",
        )
        .get(projectPath) ?? null
    );
  } finally {
    db.close();
  }
}

const PROJECT = "/projects/my-site";

describe("publishing store (real)", () => {
  describe("getPublishingConfig", () => {
    it("returns null for an unknown project", async () => {
      const store = await importStore();
      expect(await store.getPublishingConfig(PROJECT)).toBeNull();
    });

    it("round-trips a full config including the token", async () => {
      const store = await importStore();
      await store.savePublishingConfig(PROJECT, {
        serverIp: "142.93.123.45",
        sshPublicKey: "ssh-ed25519 AAAAC3...",
        sshKeyPath: "/home/user/.herman/ssh/herman_deploy_key",
        coolifyUrl: "http://142.93.123.45:8000",
        coolifyApiToken: "secret-token-123",
        status: "coolify_installed",
      });

      const config = await store.getPublishingConfig(PROJECT);
      expect(config).not.toBeNull();
      expect(config?.serverIp).toBe("142.93.123.45");
      expect(config?.sshPublicKey).toBe("ssh-ed25519 AAAAC3...");
      expect(config?.sshKeyPath).toBe("/home/user/.herman/ssh/herman_deploy_key");
      expect(config?.coolifyUrl).toBe("http://142.93.123.45:8000");
      expect(config?.coolifyApiToken).toBe("secret-token-123");
      expect(config?.status).toBe("coolify_installed");
      expect(config?.createdAt).toBeGreaterThan(0);
      expect(config?.updatedAt).toBeGreaterThan(0);
    });

    it("never stores the token in the SQLite row", async () => {
      const store = await importStore();
      await store.savePublishingConfig(PROJECT, { coolifyApiToken: "super-secret" });

      const row = rawRow(PROJECT);
      expect(row).not.toBeNull();
      if (!row) throw new Error("test precondition: expected row");
      // The schema has no token column at all.
      expect(Object.keys(row)).not.toContain("coolify_api_token");
      expect(Object.values(row)).not.toContain("super-secret");

      // But the encrypted credential file exists in the app dir.
      expect(existsSync(join(tempDir, "credentials.enc.json"))).toBe(true);
    });
  });

  describe("getPublishingConfigView", () => {
    it("strips secrets and reports booleans", async () => {
      const store = await importStore();
      await store.savePublishingConfig(PROJECT, {
        serverIp: "10.0.0.1",
        sshKeyPath: "/keys/deploy",
        sshPublicKey: "ssh-ed25519 AAAAC3...",
        coolifyApiToken: "super-secret-token",
      });

      const view = await store.getPublishingConfigView(PROJECT);
      expect(view).not.toBeNull();
      expect(view?.hasApiToken).toBe(true);
      expect(view?.hasSshKey).toBe(true);
      expect(view?.sshPublicKey).toBe("ssh-ed25519 AAAAC3...");
      expect((view as Record<string, unknown>).coolifyApiToken).toBeUndefined();
      expect((view as Record<string, unknown>).sshKeyPath).toBeUndefined();
    });

    it("treats a pasted public key (no private key) as having an SSH key", async () => {
      const store = await importStore();
      await store.savePublishingConfig(PROJECT, { sshPublicKey: "ssh-ed25519 pasted" });

      const view = await store.getPublishingConfigView(PROJECT);
      expect(view?.hasSshKey).toBe(true);
    });

    it("returns null for unknown projects", async () => {
      const store = await importStore();
      expect(await store.getPublishingConfigView("/nope")).toBeNull();
    });
  });

  describe("savePublishingConfig", () => {
    it("defaults status to 'none' on create", async () => {
      const store = await importStore();
      const config = await store.savePublishingConfig(PROJECT, { serverIp: "10.0.0.1" });
      expect(config.status).toBe("none");
    });

    it("keeps omitted fields on update (undefined = unchanged)", async () => {
      const store = await importStore();
      await store.savePublishingConfig(PROJECT, {
        serverIp: "10.0.0.1",
        sshPublicKey: "key1",
        status: "server_ready",
      });

      await store.savePublishingConfig(PROJECT, { status: "coolify_installed" });

      const config = await store.getPublishingConfig(PROJECT);
      expect(config?.serverIp).toBe("10.0.0.1");
      expect(config?.sshPublicKey).toBe("key1");
      expect(config?.status).toBe("coolify_installed");
    });

    it("clears a field with null", async () => {
      const store = await importStore();
      await store.savePublishingConfig(PROJECT, {
        serverIp: "10.0.0.1",
        domain: "example.com",
      });

      await store.savePublishingConfig(PROJECT, { domain: null });

      const config = await store.getPublishingConfig(PROJECT);
      expect(config?.domain).toBeUndefined();
      expect(config?.serverIp).toBe("10.0.0.1");
    });

    it("keeps the token when the update omits it; clears it with null", async () => {
      const store = await importStore();
      await store.savePublishingConfig(PROJECT, { coolifyApiToken: "tok-1" });

      // Omitting the token keeps it.
      await store.savePublishingConfig(PROJECT, { serverIp: "10.0.0.1" });
      expect((await store.getPublishingConfig(PROJECT))?.coolifyApiToken).toBe("tok-1");

      // null clears it.
      await store.savePublishingConfig(PROJECT, { coolifyApiToken: null });
      expect((await store.getPublishingConfig(PROJECT))?.coolifyApiToken).toBeUndefined();
      expect((await store.getPublishingConfigView(PROJECT))?.hasApiToken).toBe(false);
    });

    it("never changes the project path on update", async () => {
      const store = await importStore();
      await store.savePublishingConfig(PROJECT, { serverIp: "10.0.0.1" });
      await store.savePublishingConfig(PROJECT, { serverIp: "10.0.0.2" });

      const config = await store.getPublishingConfig(PROJECT);
      expect(config?.projectPath).toBe(PROJECT);
      expect(config?.serverIp).toBe("10.0.0.2");
    });

    it("never moves the status backwards, even for UI saves", async () => {
      const store = await importStore();
      await store.savePublishingConfig(PROJECT, { status: "coolify_installed" });

      // A UI re-save of an earlier wizard step must not downgrade the status.
      const config = await store.savePublishingConfig(PROJECT, {
        serverIp: "10.0.0.9",
        status: "server_ready",
      });

      expect(config.status).toBe("coolify_installed");
      expect(config.serverIp).toBe("10.0.0.9"); // other fields still update
    });

    it("bumps updatedAt, keeps createdAt", async () => {
      const store = await importStore();
      const first = await store.savePublishingConfig(PROJECT, { serverIp: "10.0.0.1" });
      await new Promise((r) => setTimeout(r, 5));
      const second = await store.savePublishingConfig(PROJECT, { serverIp: "10.0.0.2" });

      expect(second.updatedAt).toBeGreaterThan(first.updatedAt);
      expect(second.createdAt).toBe(first.createdAt);
    });
  });

  describe("validation", () => {
    it("rejects an invalid status", async () => {
      const store = await importStore();
      await expect(
        store.savePublishingConfig(PROJECT, { status: "bogus" as never }),
      ).rejects.toThrow(/status/i);
    });

    it("rejects an invalid Coolify URL", async () => {
      const store = await importStore();
      await expect(
        store.savePublishingConfig(PROJECT, { coolifyUrl: "not-a-url" }),
      ).rejects.toThrow(/url/i);
    });

    it("rejects an invalid server address", async () => {
      const store = await importStore();
      await expect(store.savePublishingConfig(PROJECT, { serverIp: "bad host!!" })).rejects.toThrow(
        /server/i,
      );
    });

    it("accepts https Coolify URLs and hostnames", async () => {
      const store = await importStore();
      const config = await store.savePublishingConfig(PROJECT, {
        coolifyUrl: "https://coolify.example.com",
        serverIp: "my-server.example.com",
        domain: "example.com",
      });
      expect(config.coolifyUrl).toBe("https://coolify.example.com");
    });
  });

  describe("deletePublishingConfig", () => {
    it("deletes the row and the stored token", async () => {
      const store = await importStore();
      await store.savePublishingConfig(PROJECT, {
        serverIp: "10.0.0.1",
        coolifyApiToken: "tok",
      });

      expect(await store.deletePublishingConfig(PROJECT)).toBe(true);
      expect(await store.getPublishingConfig(PROJECT)).toBeNull();

      // Token is gone too — a fresh save must not resurrect it.
      await store.savePublishingConfig(PROJECT, { serverIp: "10.0.0.2" });
      expect((await store.getPublishingConfig(PROJECT))?.coolifyApiToken).toBeUndefined();
    });

    it("returns false for a non-existent project", async () => {
      const store = await importStore();
      expect(await store.deletePublishingConfig("/ghost")).toBe(false);
    });

    it("only deletes the targeted project", async () => {
      const store = await importStore();
      await store.savePublishingConfig("/projects/a", { serverIp: "10.0.0.1" });
      await store.savePublishingConfig("/projects/b", { serverIp: "10.0.0.2" });

      await store.deletePublishingConfig("/projects/a");

      expect(await store.getPublishingConfig("/projects/a")).toBeNull();
      expect(await store.getPublishingConfig("/projects/b")).not.toBeNull();
    });
  });

  describe("applyAgentPublishingUpdate", () => {
    it("returns null when no config exists", async () => {
      const store = await importStore();
      expect(
        await store.applyAgentPublishingUpdate(PROJECT, { coolifyProjectId: "uuid-1" }),
      ).toBeNull();
    });

    it("records deployment results and advances the status", async () => {
      const store = await importStore();
      await store.savePublishingConfig(PROJECT, {
        serverIp: "10.0.0.1",
        coolifyUrl: "http://10.0.0.1:8000",
        coolifyApiToken: "tok",
        status: "coolify_installed",
      });

      const updated = await store.applyAgentPublishingUpdate(PROJECT, {
        coolifyProjectId: "proj-uuid",
        coolifyProjectName: "my-site",
        coolifyApplicationId: "app-uuid",
        status: "project_created",
      });

      expect(updated).not.toBeNull();
      expect(updated?.coolifyProjectId).toBe("proj-uuid");
      expect(updated?.coolifyProjectName).toBe("my-site");
      expect(updated?.coolifyApplicationId).toBe("app-uuid");
      expect(updated?.status).toBe("project_created");
    });

    it("never moves the status backwards", async () => {
      const store = await importStore();
      await store.savePublishingConfig(PROJECT, { status: "deployed", domain: "example.com" });

      const updated = await store.applyAgentPublishingUpdate(PROJECT, {
        status: "project_created",
        coolifyApplicationId: "app-uuid",
      });

      expect(updated?.status).toBe("deployed"); // kept
      expect(updated?.coolifyApplicationId).toBe("app-uuid"); // still applied
    });

    it("ignores fields the agent may not touch", async () => {
      const store = await importStore();
      await store.savePublishingConfig(PROJECT, {
        serverIp: "10.0.0.1",
        coolifyUrl: "http://10.0.0.1:8000",
      });

      const updated = await store.applyAgentPublishingUpdate(PROJECT, {
        // Sneak UI-owned fields in via a cast — the store must drop them.
        ...({ serverIp: "9.9.9.9", coolifyApiToken: "hacked" } as object),
        coolifyProjectId: "proj-uuid",
      } as Parameters<typeof store.applyAgentPublishingUpdate>[1]);

      expect(updated?.serverIp).toBe("10.0.0.1");
      expect(updated?.coolifyApiToken).toBeUndefined();
      expect(updated?.coolifyProjectId).toBe("proj-uuid");
    });
  });
});
