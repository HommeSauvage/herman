import { getLogger } from "@logtape/logtape";

import { PUBLISHING_STATUSES, validatePublishingUpdate } from "../../shared/publishing.js";
import { getCredential, removeCredential, setCredential } from "../credentials.js";
import { getDb } from "../persistence.js";
import type {
  PublishingConfig,
  PublishingConfigUpdate,
  PublishingConfigView,
  PublishingStatus,
} from "./types.js";

const logger = getLogger(["herman-desktop", "publishing", "store"]);

function statusRank(status: PublishingStatus): number {
  return PUBLISHING_STATUSES.indexOf(status);
}

/**
 * The Coolify API token is a secret: it lives in the encrypted credential
 * store (keychain-backed when available), keyed by a synthetic provider id
 * per project — never in the SQLite row.
 */
function tokenProviderId(projectPath: string): string {
  return `coolify:${projectPath}`;
}

/** Column map: config field → sqlite column. Single source of truth for SQL. */
const COLUMNS = [
  ["serverIp", "server_ip"],
  ["sshKeyPath", "ssh_key_path"],
  ["sshPublicKey", "ssh_public_key"],
  ["coolifyUrl", "coolify_url"],
  ["coolifyProjectId", "coolify_project_id"],
  ["coolifyProjectName", "coolify_project_name"],
  ["coolifyApplicationId", "coolify_application_id"],
  ["domain", "domain"],
] as const;

type PublishingRow = {
  project_path: string;
  status: string;
  created_at: number;
  updated_at: number;
} & Record<string, unknown>;

function rowToConfig(row: PublishingRow, coolifyApiToken?: string): PublishingConfig {
  const config: PublishingConfig = {
    projectPath: row.project_path,
    status: (row.status as PublishingStatus) || "none",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    coolifyApiToken: coolifyApiToken || undefined,
  };
  for (const [field, column] of COLUMNS) {
    const value = row[column];
    if (typeof value === "string" && value.length > 0) {
      config[field] = value;
    }
  }
  return config;
}

function configToView(config: PublishingConfig): PublishingConfigView {
  return {
    projectPath: config.projectPath,
    serverIp: config.serverIp,
    sshPublicKey: config.sshPublicKey,
    coolifyUrl: config.coolifyUrl,
    coolifyProjectId: config.coolifyProjectId,
    coolifyProjectName: config.coolifyProjectName,
    coolifyApplicationId: config.coolifyApplicationId,
    domain: config.domain,
    status: config.status,
    hasApiToken: Boolean(config.coolifyApiToken),
    hasSshKey: Boolean(config.sshKeyPath || config.sshPublicKey),
    createdAt: config.createdAt,
    updatedAt: config.updatedAt,
  };
}

function readRow(projectPath: string): PublishingRow | null {
  const db = getDb();
  const row = db
    .query<PublishingRow, [string]>("SELECT * FROM publishing_config WHERE project_path = ?")
    .get(projectPath);
  return row ?? null;
}

function writeRow(config: PublishingConfig): void {
  const db = getDb();
  const columnNames = COLUMNS.map(([, c]) => c);
  const values = COLUMNS.map(([field]) => config[field] ?? null);

  db.run(
    `INSERT INTO publishing_config (
      project_path, ${columnNames.join(", ")}, status, created_at, updated_at
    ) VALUES (?, ${columnNames.map(() => "?").join(", ")}, ?, ?, ?)
    ON CONFLICT(project_path) DO UPDATE SET
      ${columnNames.map((c) => `${c} = excluded.${c}`).join(", ")},
      status = excluded.status,
      updated_at = excluded.updated_at`,
    [config.projectPath, ...values, config.status, config.createdAt, config.updatedAt],
  );
}

/** Get the publishing config for a project (including secrets), or null. */
export async function getPublishingConfig(projectPath: string): Promise<PublishingConfig | null> {
  const row = readRow(projectPath);
  if (!row) return null;
  const token = await getCredential(tokenProviderId(projectPath));
  return rowToConfig(row, token?.type === "apiKey" ? token.key : undefined);
}

/** Get a sanitized view safe for the renderer. */
export async function getPublishingConfigView(
  projectPath: string,
): Promise<PublishingConfigView | null> {
  const config = await getPublishingConfig(projectPath);
  if (!config) return null;
  return configToView(config);
}

/**
 * Create or update the publishing config for a project.
 *
 * Field semantics: `undefined` (absent) keeps the stored value, `null`
 * clears it, a string sets it. Throws on invalid input (status enum,
 * URL/IP/domain shape).
 */
export async function savePublishingConfig(
  projectPath: string,
  update: PublishingConfigUpdate,
): Promise<PublishingConfig> {
  const invalid = validatePublishingUpdate(update);
  if (invalid) {
    throw new Error(invalid);
  }

  const now = Date.now();
  const existingRow = readRow(projectPath);

  const merged: PublishingConfig = existingRow
    ? rowToConfig(existingRow)
    : { projectPath, status: "none", createdAt: now, updatedAt: now };
  merged.updatedAt = now;

  for (const [field] of COLUMNS) {
    const value = update[field];
    if (value === undefined) continue; // absent → keep
    merged[field] = value === null || value === "" ? undefined : value.trim();
  }
  if (update.status !== undefined) {
    // The pipeline status only ever advances (for every writer — UI and
    // agent). Going backwards is a reset, which is a delete + fresh save.
    if (statusRank(update.status) > statusRank(merged.status)) {
      merged.status = update.status;
    }
  }

  writeRow(merged);

  // Token round-trips through the encrypted credential store.
  if (update.coolifyApiToken !== undefined) {
    const token = update.coolifyApiToken;
    if (token === null || token.trim() === "") {
      await removeCredential(tokenProviderId(projectPath));
      merged.coolifyApiToken = undefined;
    } else {
      await setCredential(tokenProviderId(projectPath), {
        type: "apiKey",
        key: token.trim(),
      });
      merged.coolifyApiToken = token.trim();
    }
  } else {
    const token = await getCredential(tokenProviderId(projectPath));
    merged.coolifyApiToken = token?.type === "apiKey" ? token.key : undefined;
  }

  logger.info(existingRow ? "Updated publishing config" : "Created publishing config", {
    projectPath,
    status: merged.status,
  });
  return merged;
}

/** Delete the publishing config (and its stored token) for a project. */
export async function deletePublishingConfig(projectPath: string): Promise<boolean> {
  const db = getDb();
  const result = db.run("DELETE FROM publishing_config WHERE project_path = ?", [projectPath]);
  await removeCredential(tokenProviderId(projectPath));
  const deleted = result.changes > 0;
  if (deleted) {
    logger.info("Deleted publishing config", { projectPath });
  }
  return deleted;
}

/** Fields the agent may report back after deploying (everything else is UI-owned). */
export interface AgentPublishingUpdate {
  coolifyProjectId?: string | null;
  coolifyProjectName?: string | null;
  coolifyApplicationId?: string | null;
  domain?: string | null;
  status?: PublishingStatus;
}

/**
 * Apply a write-back from the agent (deployment results). The pipeline status
 * can only advance — the agent can never move it backwards. Returns null when
 * no config exists for the project (setup must start from the Publishing
 * screen).
 */
export async function applyAgentPublishingUpdate(
  projectPath: string,
  update: AgentPublishingUpdate,
): Promise<PublishingConfig | null> {
  const existing = await getPublishingConfig(projectPath);
  if (!existing) return null;

  const scoped: PublishingConfigUpdate = {
    coolifyProjectId: update.coolifyProjectId,
    coolifyProjectName: update.coolifyProjectName,
    coolifyApplicationId: update.coolifyApplicationId,
    domain: update.domain,
  };

  if (update.status !== undefined && statusRank(update.status) > statusRank(existing.status)) {
    scoped.status = update.status;
  }

  return savePublishingConfig(projectPath, scoped);
}
