import type { HostBridgePublishingConfig } from "@herman/rpc/host-bridge";

const STATUS_LABELS: Record<HostBridgePublishingConfig["status"], string> = {
  none: "setup started",
  server_ready: "server + SSH key configured",
  coolify_installed: "Coolify connected (URL + API token)",
  project_created: "Coolify project/application created",
  deployed: "deployed",
};

/**
 * Per-turn publishing context for the system prompt. Injected only when a
 * publishing setup exists for the session's project (rookie mode).
 */
export function formatPublishingStateBlock(config: HostBridgePublishingConfig): string {
  const lines: string[] = [];
  lines.push("<herman_publishing_state>");
  lines.push("This project has a publishing setup (Hetzner server + Coolify):");
  lines.push(`- Status: ${STATUS_LABELS[config.status] ?? config.status}`);
  if (config.serverIp) lines.push(`- Server: ${config.serverIp}`);
  if (config.coolifyUrl) lines.push(`- Coolify: ${config.coolifyUrl}`);
  if (config.coolifyProjectName || config.coolifyProjectId) {
    lines.push(`- Coolify project: ${config.coolifyProjectName ?? config.coolifyProjectId}`);
  }
  if (config.domain) lines.push(`- Domain: ${config.domain}`);
  lines.push(
    "- When the user asks to deploy/publish: call herman_get_publishing_config for the full connection details (including the API token), then use the coolify-ops skill. Deploy from the git repo with the Dockerfile build pack — never docker-compose or Nixpacks.",
  );
  lines.push(
    "- After creating Coolify resources or changing the domain, report them with herman_update_publishing so the Publishing screen stays accurate.",
  );
  lines.push("</herman_publishing_state>");
  return lines.join("\n");
}
