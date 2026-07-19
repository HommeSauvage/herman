import type { HostBridgePreviewState } from "@herman/rpc/host-bridge";

export function formatPreviewStateBlock(state: HostBridgePreviewState): string {
  if (!state.available) {
    return "";
  }

  const lines: string[] = [];
  lines.push("<herman_preview_state>");
  lines.push("Live preview status (refreshed every turn — trust this over herman.yaml/README ports):");

  if (state.phase === "ready") {
    const urlStr = state.primaryUrl ? ` at ${state.primaryUrl}` : "";
    const serverIdStr = state.primaryServerId ? ` (server "${state.primaryServerId}"` + (state.port ? `, port ${state.port}` : "") + ")" : "";
    lines.push(`- Preview: ready${urlStr}${serverIdStr}`);
  } else if (state.phase === "starting" || state.phase === "installing") {
    lines.push("- Preview: starting up…");
  } else if (state.phase === "failed") {
    const detail = state.error ? `: ${state.error}` : "";
    lines.push(`- Preview: failed${detail}`);
  } else {
    lines.push("- Preview: not running");
  }

  if (state.currentUrl && state.currentUrl !== state.primaryUrl) {
    lines.push(`- Open page: ${state.currentUrl}`);
  }

  const { server, console: consoleErrors } = state.recentErrors;
  if (server > 0 || consoleErrors > 0) {
    const parts: string[] = [];
    if (consoleErrors > 0) parts.push(`${consoleErrors} console`);
    if (server > 0) parts.push(`${server} server`);
    lines.push(`- Recent errors: ${parts.join(", ")} in the last 5 minutes — call herman_get_preview_logs("console" | "server") for details`);
  }

  lines.push("</herman_preview_state>");
  return lines.join("\n");
}
