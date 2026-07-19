import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { getLogger } from "@logtape/logtape";
import { logStorageError } from "../logging-shared.js";
import { dbPath } from "./app-paths.js";
import { ensureDir } from "./fs-utils.js";
import { migrations } from "./persistence/migrations/index.js";

const logger = getLogger(["herman-desktop", "storage"]);

const dp = dbPath;

let _db: Database | undefined;

export function getDb(): Database {
  if (_db) return _db;

  const path = dp();
  ensureDir(dirname(path));
  try {
    _db = new Database(path, { create: true });
    _db.run("PRAGMA journal_mode = WAL");
    _db.run("PRAGMA synchronous = NORMAL");
    _db.run("PRAGMA busy_timeout = 5000");
    _db.run("PRAGMA foreign_keys = ON");

    runMigrations(_db);
    logger.info("SQLite database initialized", { path });
  } catch (error) {
    logStorageError(logger, "initDatabase", path, error);
    throw error;
  }

  return _db;
}

/** Test-only hook: close the singleton so a new HERMAN_APP_DIR takes effect. */
export function __resetDbForTests(): void {
  try {
    _db?.close();
  } catch {
    // already closed
  }
  _db = undefined;
}

function runMigrations(db: Database): void {
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
    logger.info("Applied database migration", { migrationId: m.id });
  }
}

export function getPinnedProviders(tabId: string): Record<string, string> {
  const db = getDb();
  const rows = db
    .query<{ model_name: string; provider_id: string }, [string]>(
      "SELECT model_name, provider_id FROM provider_pins WHERE tab_id = ?",
    )
    .all(tabId);

  const map: Record<string, string> = {};
  for (const row of rows) {
    map[row.model_name] = row.provider_id;
  }
  return map;
}

export function setPinnedProvider(tabId: string, modelName: string, providerId: string): void {
  const db = getDb();
  db.run(
    `INSERT INTO provider_pins (tab_id, model_name, provider_id, pinned_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (tab_id, model_name) DO UPDATE SET provider_id = excluded.provider_id, pinned_at = excluded.pinned_at`,
    [tabId, modelName, providerId, Date.now()],
  );
}

/** Delete pins older than `maxAgeMs` (default 7 days). Called on startup. */
export function cleanStalePins(maxAgeMs = 7 * 24 * 60 * 60 * 1000): void {
  const db = getDb();
  const cutoff = Date.now() - maxAgeMs;
  db.run("DELETE FROM provider_pins WHERE pinned_at < ?", [cutoff]);
}
