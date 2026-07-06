import colors from "tailwindcss/colors";

export type TabId = string;

export function createTabId(): TabId {
  return crypto.randomUUID();
}

function basename(folderPath: string): string {
  const normalized = folderPath.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? folderPath;
}

export function getProjectName(folderPath: string): string {
  return basename(folderPath);
}

export function getProjectInitial(folderPath: string): string {
  const name = getProjectName(folderPath);
  return name.charAt(0).toUpperCase();
}

function isColorScale(value: unknown): value is Record<string, string> {
  return value !== null && typeof value === "object" && "600" in value;
}

export const PROJECT_COLORS = Object.values(colors)
  .filter(isColorScale)
  .map((scale) => scale["600"]);

export function getProjectColor(folderPath: string): string {
  let hash = 0;
  for (let i = 0; i < folderPath.length; i++) {
    hash = (hash << 5) - hash + folderPath.charCodeAt(i);
    hash |= 0;
  }
  return PROJECT_COLORS[Math.abs(hash) % PROJECT_COLORS.length] ?? "#3b82f6";
}

export function truncateTitle(content: string): string {
  if (content.length <= 24) return content;
  return content.slice(0, 24).trimEnd() + "…";
}

export function hasUserOrAssistantMessage(messages: { role: string }[]): boolean {
  return messages.some((m) => m.role === "user" || m.role === "assistant");
}
