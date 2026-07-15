import { getLogger } from "@logtape/logtape";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";

import type { AgentEvent } from "../shared/agent-protocol.js";
import { AgentBridge } from "./agent-bridge.js";
import { deletePiSessionFile } from "./pi-session.js";
import { extractMessagesFromAgentPayload } from "./pi-messages.js";

const logger = getLogger(["herman-desktop", "headless-agent"]);

const DEFAULT_TIMEOUT_MS = 90_000;

function extractTextFromMessage(message: Record<string, unknown> | undefined): string {
  if (!message) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part);
      continue;
    }
    if (part && typeof part === "object") {
      const p = part as Record<string, unknown>;
      if (typeof p.text === "string") parts.push(p.text);
      else if (p.type === "text" && typeof p.text === "string") parts.push(p.text);
    }
  }
  return parts.join("");
}

/**
 * Extract a JSON object from assistant text (raw or fenced ```json block).
 */
export function extractJsonObject(text: string): unknown | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced?.[1] ?? text).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

/**
 * Run a one-shot headless agent prompt and return the final assistant text.
 * Used by wizard-compiler and triage. Falls back to empty string on failure.
 */
export async function runHeadlessAgentPrompt(opts: {
  prompt: string;
  timeoutMs?: number;
  label?: string;
}): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const label = opts.label ?? "headless";
  const tempTabId = `headless-${label}-${Date.now()}`;
  const cwd = join(homedir(), "Herman", ".headless");
  await mkdir(cwd, { recursive: true });

  let assistantText = "";
  let settle: (() => void) | undefined;
  const done = new Promise<void>((resolve) => {
    settle = resolve;
  });

  const bridge = new AgentBridge(
    tempTabId,
    () => {},
    () => {},
    (_tabId, event: AgentEvent) => {
      if (event.type === "message_end") {
        const msg = event.message as Record<string, unknown> | undefined;
        if (msg?.role === "assistant") {
          const text = extractTextFromMessage(msg);
          if (text.trim()) assistantText = text;
        }
      }
      if (event.type === "agent_end" || event.type === "agent_complete") {
        if (event.type === "agent_complete" && Array.isArray(event.messages)) {
          for (const raw of event.messages) {
            const msg = raw as Record<string, unknown>;
            if (msg?.role === "assistant") {
              const text = extractTextFromMessage(msg);
              if (text.trim()) assistantText = text;
            }
          }
        }
        settle?.();
      }
    },
  );

  let headlessPiSessionId: string | undefined;
  try {
    await bridge.start(cwd, { mode: "rookie" });
    // Enable pi's built-in auto-retry for transient API errors.
    await bridge.sendCommand({ type: "set_auto_retry", enabled: true }).catch(() => undefined);
    // Capture the new session's id so we can delete its JSONL on cleanup (the
    // shared sessions dir is not per-tab, so we must not leave orphan files).
    try {
      const state = await bridge.sendCommand({ type: "get_state" });
      if (state.success) {
        const data = state.data as Record<string, unknown> | undefined;
        if (data && typeof data.sessionId === "string") headlessPiSessionId = data.sessionId;
      }
    } catch {
      // Non-fatal; cleanup just won't delete the file.
    }
    try {
      await bridge.sendCommand({ type: "prompt", message: opts.prompt });
    } catch (error) {
      logger.warning("Headless agent prompt command failed", {
        label,
        error: error instanceof Error ? error.message : String(error),
      });
      settle?.();
    }

    await Promise.race([
      done,
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);

    if (!assistantText.trim()) {
      try {
        const response = await bridge.sendCommand({ type: "get_messages" });
        if (response.success && response.data && typeof response.data === "object") {
          const messages = extractMessagesFromAgentPayload(response.data as Record<string, unknown>);
          if (messages) {
            for (let i = messages.length - 1; i >= 0; i--) {
              const msg = messages[i];
              if (msg?.role === "assistant" && msg.content.trim()) {
                assistantText = msg.content;
                break;
              }
            }
          }
        }
      } catch (error) {
        logger.debug("Headless agent get_messages fallback failed", {
          label,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return assistantText.trim();
  } catch (error) {
    logger.warning("Headless agent run failed", {
      label,
      error: error instanceof Error ? error.message : String(error),
    });
    return "";
  } finally {
    await bridge.stop().catch(() => undefined);
    if (headlessPiSessionId) deletePiSessionFile(headlessPiSessionId);
  }
}
