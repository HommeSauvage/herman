export const CONTEXT_TOOLS = new Set(["read", "glob", "grep", "list"]);

export function isContextTool(name: string): boolean {
  return CONTEXT_TOOLS.has(name);
}
