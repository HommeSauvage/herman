import type { Database } from "bun:sqlite";

export const id = "001_create_provider_pins";

export function up(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS provider_pins (
      tab_id TEXT NOT NULL,
      model_name TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      pinned_at INTEGER NOT NULL,
      PRIMARY KEY (tab_id, model_name)
    );
  `);
}
