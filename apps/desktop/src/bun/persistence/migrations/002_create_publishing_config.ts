import type { Database } from "bun:sqlite";

export const id = "002_create_publishing_config";

/**
 * Publishing configuration per project. Secrets (the Coolify API token) are
 * NOT stored here — they live in the encrypted credential store (see
 * src/bun/credentials.ts) under a per-project provider id.
 */
export function up(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS publishing_config (
      project_path TEXT PRIMARY KEY,
      server_ip TEXT,
      ssh_key_path TEXT,
      ssh_public_key TEXT,
      coolify_url TEXT,
      coolify_project_id TEXT,
      coolify_project_name TEXT,
      coolify_application_id TEXT,
      domain TEXT,
      status TEXT NOT NULL DEFAULT 'none',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
}
