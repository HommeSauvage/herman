import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// We test the migration and query logic without depending on electrobun.
// The actual persistence.ts imports Utils.paths.userData, so we test the
// underlying logic through a throwaway in-memory DB.

const migrations = [
  {
    id: "001_create_provider_pins",
    up(db: Database) {
      db.run(`
        CREATE TABLE IF NOT EXISTS provider_pins (
          tab_id TEXT NOT NULL,
          model_name TEXT NOT NULL,
          provider_id TEXT NOT NULL,
          pinned_at INTEGER NOT NULL,
          PRIMARY KEY (tab_id, model_name)
        );
      `);
    },
  },
];

function runMigrations(db: Database) {
  db.run(`
    CREATE TABLE IF NOT EXISTS migration (
      id TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  const applied = new Set(
    db
      .query<{ id: string }, []>("SELECT id FROM migration")
      .all()
      .map((row) => row.id),
  );

  for (const m of migrations) {
    if (applied.has(m.id)) continue;
    db.transaction(() => {
      m.up(db);
      db.run("INSERT INTO migration (id, applied_at) VALUES (?, ?)", [m.id, Date.now()]);
    })();
  }
}

describe("persistence (migrations)", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("creates provider_pins table on first run", () => {
    runMigrations(db);

    const tables = db
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all();
    const names = tables.map((t) => t.name);
    expect(names).toContain("provider_pins");
    expect(names).toContain("migration");
  });

  it("does not re-run already applied migrations", () => {
    runMigrations(db);
    const countBefore = db
      .query<{ count: number }, []>("SELECT COUNT(*) as count FROM migration")
      .get()!.count;

    runMigrations(db);
    const countAfter = db
      .query<{ count: number }, []>("SELECT COUNT(*) as count FROM migration")
      .get()!.count;

    expect(countAfter).toBe(countBefore);
  });

  it("upserts provider pins", () => {
    runMigrations(db);

    db.run(
      `INSERT INTO provider_pins (tab_id, model_name, provider_id, pinned_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (tab_id, model_name) DO UPDATE SET provider_id = excluded.provider_id, pinned_at = excluded.pinned_at`,
      ["tab-1", "kimi-k2.7-code", "kimi-primary", 1000],
    );

    const first = db
      .query<{ provider_id: string }, [string, string]>(
        "SELECT provider_id FROM provider_pins WHERE tab_id = ? AND model_name = ?",
      )
      .get("tab-1", "kimi-k2.7-code");
    expect(first!.provider_id).toBe("kimi-primary");

    // Update to a different provider
    db.run(
      `INSERT INTO provider_pins (tab_id, model_name, provider_id, pinned_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (tab_id, model_name) DO UPDATE SET provider_id = excluded.provider_id, pinned_at = excluded.pinned_at`,
      ["tab-1", "kimi-k2.7-code", "kimi-fallback", 2000],
    );

    const second = db
      .query<{ provider_id: string }, [string, string]>(
        "SELECT provider_id FROM provider_pins WHERE tab_id = ? AND model_name = ?",
      )
      .get("tab-1", "kimi-k2.7-code");
    expect(second!.provider_id).toBe("kimi-fallback");
  });

  it("stores pins per tab independently", () => {
    runMigrations(db);

    db.run(
      `INSERT INTO provider_pins (tab_id, model_name, provider_id, pinned_at) VALUES (?, ?, ?, ?)`,
      ["tab-1", "kimi-k2.7-code", "kimi-primary", 1000],
    );
    db.run(
      `INSERT INTO provider_pins (tab_id, model_name, provider_id, pinned_at) VALUES (?, ?, ?, ?)`,
      ["tab-2", "kimi-k2.7-code", "kimi-secondary", 1000],
    );

    const rows = db
      .query<{ tab_id: string; provider_id: string }, []>(
        "SELECT tab_id, provider_id FROM provider_pins ORDER BY tab_id",
      )
      .all();
    expect(rows).toHaveLength(2);
    expect(rows[0].tab_id).toBe("tab-1");
    expect(rows[0].provider_id).toBe("kimi-primary");
    expect(rows[1].tab_id).toBe("tab-2");
    expect(rows[1].provider_id).toBe("kimi-secondary");
  });

  it("deletes stale pins", () => {
    runMigrations(db);

    const now = Date.now();
    db.run(
      `INSERT INTO provider_pins (tab_id, model_name, provider_id, pinned_at) VALUES (?, ?, ?, ?)`,
      ["tab-old", "kimi-k2.7-code", "old-provider", now - 8 * 24 * 60 * 60 * 1000], // 8 days ago
    );
    db.run(
      `INSERT INTO provider_pins (tab_id, model_name, provider_id, pinned_at) VALUES (?, ?, ?, ?)`,
      ["tab-new", "glm-4.7", "fresh-provider", now], // just now
    );

    const cutoff = now - 7 * 24 * 60 * 60 * 1000;
    db.run("DELETE FROM provider_pins WHERE pinned_at < ?", [cutoff]);

    const remaining = db.query<{ tab_id: string }, []>("SELECT tab_id FROM provider_pins").all();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].tab_id).toBe("tab-new");
  });
});
