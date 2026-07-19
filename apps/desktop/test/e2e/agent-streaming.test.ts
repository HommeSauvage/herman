import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AgentEvent } from "../../src/shared/agent-protocol.js";
import { E2E_BASE_URL, E2E_PORT, type E2EServer, startE2EServer } from "./helpers/server.js";

const runE2E = process.env.HERMAN_RUN_E2E === "1";
const hasSessionConfig =
  Boolean(process.env.HERMAN_E2E_SESSION_TOKEN) ||
  Boolean(process.env.HERMAN_E2E_CREATE_SESSION_SCRIPT);

describe.skipIf(!runE2E || !hasSessionConfig)("agent streaming e2e", () => {
  let server: E2EServer;

  beforeAll(() => {
    server = startE2EServer();
  });

  afterAll(() => {
    server.stop();
  });

  it("streams an assistant reply over the e2e websocket bridge", async () => {
    const sessionRes = await fetch(`${E2E_BASE_URL}/api/session`);
    expect(sessionRes.ok).toBe(true);
    const { sessionId } = (await sessionRes.json()) as { sessionId: string };

    const ws = new WebSocket(`ws://localhost:${E2E_PORT}/ws`);
    const events: AgentEvent[] = [];
    let stderr = "";

    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", reject);
    });

    ws.send(JSON.stringify({ type: "start_agent", sessionId }));

    ws.addEventListener("message", (msg) => {
      const data = JSON.parse(msg.data as string) as Record<string, unknown>;
      if (data.type === "agent_event") {
        events.push(data.event as AgentEvent);
      }
      if (data.type === "agent_stderr") {
        stderr += String(data.text ?? "");
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 2000));

    ws.send(
      JSON.stringify({
        type: "agent_command",
        command: JSON.stringify({ type: "prompt", message: "say hello" }),
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 7000));
    ws.close();

    const assistantMessage = events.find(
      (e): e is Extract<AgentEvent, { type: "message_end" }> =>
        e.type === "message_end" && (e.message as { role?: string }).role === "assistant",
    );

    expect(events.length).toBeGreaterThan(0);
    expect(assistantMessage).toBeDefined();
    if (!assistantMessage) throw new Error("test precondition: expected assistant message");

    const content = (assistantMessage.message as { content?: { text?: string }[] }).content ?? [];
    const text = content.map((c) => c.text).join("");
    expect(text).toContain("Herman");
    expect(stderr.length).toBeGreaterThanOrEqual(0);
  }, 30_000);
});
