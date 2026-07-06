import type { AgentEvent } from "../src/shared/agent-protocol.js";

const WS_URL = `ws://localhost:${process.env.HERMAN_E2E_PORT ?? "8765"}/ws`;

async function run() {
  const sessionRes = await fetch(
    `http://localhost:${process.env.HERMAN_E2E_PORT ?? "8765"}/api/session`,
  );
  const { sessionId } = (await sessionRes.json()) as { sessionId: string };
  console.log("[e2e] session", sessionId.slice(0, 8));

  const ws = new WebSocket(WS_URL);

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
      const event = data.event as AgentEvent;
      if (event.type === "message_update") {
        const partial = event.message as { content?: { text?: string }[] } | undefined;
        const text = partial?.content?.map((c) => c.text).join("") ?? "";
        console.log("[stream]", text);
      }
    }
    if (data.type === "agent_stderr") {
      stderr += String(data.text ?? "");
    }
  });

  // Wait for agent start.
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

  console.log("\n=== E2E RESULT ===");
  console.log("Events received:", events.length);
  console.log(
    "Assistant message:",
    assistantMessage ? JSON.stringify(assistantMessage.message).slice(0, 200) : "none",
  );
  console.log("Stderr preview:", stderr.slice(0, 500));

  if (!assistantMessage) {
    console.error("FAIL: No assistant message received");
    process.exit(1);
  }

  const content = (assistantMessage.message as { content?: { text?: string }[] }).content ?? [];
  const text = content.map((c) => c.text).join("");
  if (!text.includes("Herman")) {
    console.error("FAIL: Assistant response did not include 'Herman'");
    process.exit(1);
  }

  console.log("PASS: End-to-end streaming works");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
