import type { PreviewConsoleEntry, PreviewLogEntry } from "@herman/rpc/host-bridge";
import type { PreviewServerLogLine } from "../../shared/preview.js";
import { looksLikeServerError } from "../preview/preview-log-filter.js";

function mergeErrorWindows(
  lines: { line: string; isError: boolean }[],
  maxLinesBeforeAfter: number,
): Set<number> {
  const included = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]?.isError) {
      const start = Math.max(0, i - maxLinesBeforeAfter);
      const end = Math.min(lines.length, i + maxLinesBeforeAfter + 1);
      for (let j = start; j < end; j++) {
        included.add(j);
      }
    }
  }
  return included;
}

export function formatServerLogText(
  rawLines: PreviewServerLogLine[],
  opts: {
    maxEntries: number;
    maxLinesBeforeAfter: number;
    maxChars: number;
  },
): { text: string; entries: PreviewLogEntry[]; truncated: boolean } {
  // Take last maxEntries*4 lines as the working window.
  const windowSize = opts.maxEntries * 4;
  const workingLines = rawLines.slice(-windowSize);

  const enriched = workingLines.map((l) => ({
    line: l.line,
    isError: looksLikeServerError(l.line),
    ts: l.ts,
    source: l.source,
  }));

  const errorWindows = mergeErrorWindows(enriched, opts.maxLinesBeforeAfter);

  // Always include the plain last-maxEntries tail.
  const tailStart = Math.max(0, enriched.length - opts.maxEntries);
  const tailSet = new Set<number>();
  for (let i = tailStart; i < enriched.length; i++) {
    tailSet.add(i);
  }

  const allIncluded = new Set([...errorWindows, ...tailSet]);
  const sortedIndices = [...allIncluded].sort((a, b) => a - b);

  const entries: PreviewLogEntry[] = [];
  const parts: string[] = [];

  for (const idx of sortedIndices) {
    const e = enriched[idx];
    if (!e) continue;
    const entry: PreviewLogEntry = {
      ts: e.ts,
      source: e.source,
      line: e.line,
      isError: e.isError,
    };
    entries.push(entry);
    parts.push(`[${e.source}] ${e.line}`);
  }

  let text = parts.join("\n");
  let truncated = false;
  if (text.length > opts.maxChars) {
    // Keep the newest tail (most relevant for diagnostics).
    const suffix = "\n… (truncated)";
    text = text.slice(text.length - (opts.maxChars - suffix.length)) + suffix;
    truncated = true;
    // Sync entries: drop oldest entries proportionally.
    const charRatio = (opts.maxChars - suffix.length) / text.length;
    const keepEntries = Math.max(1, Math.ceil(entries.length * charRatio));
    entries.splice(0, entries.length - keepEntries);
  }

  return { text, entries, truncated };
}

export function formatConsoleLogText(
  entries: PreviewConsoleEntry[],
  opts: {
    maxEntries: number;
    maxLinesBeforeAfter: number;
    maxChars: number;
    currentUrl?: string;
  },
): { text: string; entries: PreviewLogEntry[]; truncated: boolean } {
  const tail = entries.slice(-opts.maxEntries);

  const result: PreviewLogEntry[] = [];
  const parts: string[] = [];

  for (let i = 0; i < tail.length; i++) {
    const c = tail[i];
    if (!c) continue;
    let line = `[${c.level}] ${c.message}`;
    if (c.url && c.url !== opts.currentUrl) {
      line += ` — ${c.url}`;
    }
    const entry: PreviewLogEntry = {
      ts: c.ts,
      source: "console",
      level: c.level,
      line: c.message,
      stack: c.stack,
      url: c.url,
      isError: c.level === "error",
    };
    result.push(entry);
    parts.push(line);
    if (c.stack) {
      parts.push(
        c.stack
          .split("\n")
          .map((s) => `    ${s}`)
          .join("\n"),
      );
    }
  }

  let text = parts.join("\n");
  let truncated = false;
  if (text.length > opts.maxChars) {
    // Keep the newest tail (most relevant for diagnostics).
    const suffix = "\n… (truncated)";
    text = text.slice(text.length - (opts.maxChars - suffix.length)) + suffix;
    truncated = true;
    // Sync entries: drop oldest entries proportionally.
    const charRatio = (opts.maxChars - suffix.length) / text.length;
    const keepEntries = Math.max(1, Math.ceil(result.length * charRatio));
    result.splice(0, result.length - keepEntries);
  }

  return { text, entries: result, truncated };
}
