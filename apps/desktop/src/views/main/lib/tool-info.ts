import {
  Bot,
  FilePen,
  FileText,
  Folder,
  Globe,
  HelpCircle,
  ListChecks,
  type LucideIcon,
  Pencil,
  Search,
  Terminal,
  Wrench,
} from "lucide-react";

type ToolInfo = {
  icon: LucideIcon;
  title: string;
  subtitle?: string;
  // Present participle form for transient activity labels (e.g. "Reading",
  // "Executing"). The status bar uses this to describe what the agent is
  // doing right now, while `title` is the noun form used in the message list.
  gerund: string;
};

function argString(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== "object" || !(key in input)) return undefined;
  const value = (input as Record<string, unknown>)[key];
  if (typeof value === "string" && value.length > 0) return value;
  return undefined;
}

function argNumber(input: unknown, key: string): number | undefined {
  if (!input || typeof input !== "object" || !(key in input)) return undefined;
  const value = (input as Record<string, unknown>)[key];
  if (typeof value === "number") return value;
  return undefined;
}

function basename(path: string): string {
  if (!path) return path;
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i >= 0 ? path.slice(i + 1) : path;
}

export function getToolInfo(toolName: string, args: unknown): ToolInfo {
  switch (toolName) {
    case "read": {
      const offset = argNumber(args, "offset");
      const limit = argNumber(args, "limit");
      const readPath = argString(args, "path");
      const subtitleParts: string[] = [];
      if (readPath) subtitleParts.push(basename(readPath));
      if (offset !== undefined) subtitleParts.push(`offset=${offset}`);
      if (limit !== undefined) subtitleParts.push(`limit=${limit}`);
      return {
        icon: FileText,
        title: "Read",
        subtitle: subtitleParts.join(" · ") || undefined,
        gerund: "Reading",
      };
    }
    case "write":
      return {
        icon: FilePen,
        title: "Write",
        subtitle: argString(args, "path") ? basename(argString(args, "path") as string) : undefined,
        gerund: "Writing",
      };
    case "edit":
      return {
        icon: Pencil,
        title: "Edit",
        subtitle: argString(args, "path") ? basename(argString(args, "path") as string) : undefined,
        gerund: "Editing",
      };
    case "apply_patch": {
      const files = (args as { files?: unknown } | undefined)?.files;
      if (Array.isArray(files) && files.length > 0) {
        return {
          icon: FilePen,
          title: "Apply patch",
          subtitle: `${files.length} ${files.length === 1 ? "file" : "files"}`,
          gerund: "Patching",
        };
      }
      return { icon: FilePen, title: "Apply patch", gerund: "Patching" };
    }
    case "bash":
      return {
        icon: Terminal,
        title: "Bash",
        subtitle:
          argString(args, "description") ?? (argString(args, "command")?.slice(0, 80) || undefined),
        gerund: "Executing",
      };
    case "glob":
      return {
        icon: Search,
        title: "Glob",
        subtitle: argString(args, "pattern") ?? argString(args, "path"),
        gerund: "Finding",
      };
    case "grep":
      return {
        icon: Search,
        title: "Grep",
        subtitle: argString(args, "pattern") ?? argString(args, "path"),
        gerund: "Searching",
      };
    case "list":
      return {
        icon: Folder,
        title: "List",
        subtitle: argString(args, "path") ?? argString(args, "directory"),
        gerund: "Listing",
      };
    case "webfetch":
      return {
        icon: Globe,
        title: "Web fetch",
        subtitle: argString(args, "url"),
        gerund: "Fetching",
      };
    case "websearch":
      return {
        icon: Globe,
        title: "Web search",
        subtitle: argString(args, "query"),
        gerund: "Searching",
      };
    case "task": {
      const type = argString(args, "subagent_type");
      const description = argString(args, "description");
      return {
        icon: Bot,
        title: type ? type[0]?.toUpperCase() + type.slice(1) : "Task",
        subtitle: description,
        gerund: "Delegating",
      };
    }
    case "todowrite":
      return { icon: ListChecks, title: "Todo", gerund: "Planning" };
    case "question":
      return { icon: HelpCircle, title: "Question", gerund: "Waiting" };
    default:
      return {
        icon: Wrench,
        title: toolName,
        subtitle:
          argString(args, "description") ??
          argString(args, "query") ??
          argString(args, "url") ??
          argString(args, "filePath") ??
          argString(args, "path") ??
          argString(args, "pattern") ??
          argString(args, "name"),
        gerund: "Working",
      };
  }
}

export { CONTEXT_TOOLS, isContextTool } from "../../../shared/context-tools.js";
