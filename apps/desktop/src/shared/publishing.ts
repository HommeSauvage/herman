/** Status of the publishing pipeline for a project. */
export type PublishingStatus =
  | "none" // No publishing setup started
  | "server_ready" // Server IP + SSH key recorded
  | "coolify_installed" // Coolify URL + API token recorded
  | "project_created" // Coolify project + app created by agent
  | "deployed"; // Fully deployed with domain

/** All statuses in pipeline order (index = rank). */
export const PUBLISHING_STATUSES: readonly PublishingStatus[] = [
  "none",
  "server_ready",
  "coolify_installed",
  "project_created",
  "deployed",
];

export function isPublishingStatus(value: unknown): value is PublishingStatus {
  return typeof value === "string" && (PUBLISHING_STATUSES as readonly string[]).includes(value);
}

/** Sanitized publishing config safe for the renderer (no secrets). */
export interface PublishingConfigView {
  projectPath: string;
  serverIp?: string;
  sshPublicKey?: string;
  coolifyUrl?: string;
  coolifyProjectId?: string;
  coolifyProjectName?: string;
  coolifyApplicationId?: string;
  domain?: string;
  status: PublishingStatus;
  hasApiToken: boolean;
  hasSshKey: boolean;
  createdAt: number;
  updatedAt: number;
}

/**
 * Partial update accepted by savePublishingConfig.
 *
 * Semantics per field:
 * - `undefined` (key absent) → leave the stored value unchanged.
 * - `null` → clear the stored value.
 * - a string → set the value.
 *
 * `null` is used instead of `undefined` for clearing because `undefined`
 * properties are dropped at the JSON-RPC boundary.
 */
export interface PublishingConfigUpdate {
  serverIp?: string | null;
  sshKeyPath?: string | null;
  sshPublicKey?: string | null;
  coolifyUrl?: string | null;
  coolifyApiToken?: string | null;
  coolifyProjectId?: string | null;
  coolifyProjectName?: string | null;
  coolifyApplicationId?: string | null;
  domain?: string | null;
  status?: PublishingStatus;
}

const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
const HOSTNAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/;

/**
 * Validate a publishing update. Returns an error message, or null when valid.
 * Shared by the renderer-facing RPC handler and the agent-facing host bridge
 * so both funnels enforce the same rules.
 */
export function validatePublishingUpdate(update: PublishingConfigUpdate): string | null {
  if (update.status !== undefined && !isPublishingStatus(update.status)) {
    return `Invalid publishing status: ${String(update.status)}`;
  }

  if (typeof update.serverIp === "string") {
    const v = update.serverIp.trim();
    if (!IPV4_RE.test(v) && !HOSTNAME_RE.test(v)) {
      return `Invalid server address: ${update.serverIp}`;
    }
  }

  if (typeof update.coolifyUrl === "string") {
    const v = update.coolifyUrl.trim();
    let parsed: URL | null = null;
    try {
      parsed = new URL(v);
    } catch {
      parsed = null;
    }
    if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
      return `Invalid Coolify URL (must be http(s)): ${update.coolifyUrl}`;
    }
  }

  if (typeof update.domain === "string" && update.domain.trim().length > 0) {
    // Allow comma-separated domain lists (Coolify supports them); each must
    // look like a hostname.
    const domains = update.domain
      .split(",")
      .map((d) => d.trim())
      .filter(Boolean);
    for (const d of domains) {
      if (!HOSTNAME_RE.test(d)) {
        return `Invalid domain: ${d}`;
      }
    }
  }

  return null;
}
