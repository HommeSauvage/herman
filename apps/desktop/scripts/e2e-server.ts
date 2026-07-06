import { spawn } from "node:child_process";
import { resolve } from "node:path";

import type { ServerWebSocket } from "bun";

const PORT = Number(process.env.HERMAN_E2E_PORT ?? "8765");
const AGENT_PATH =
  process.env.HERMAN_AGENT_PATH ?? resolve(process.cwd(), "packages/herman-agent/dist/cli.js");
const SERVER_URL = process.env.HERMAN_SERVER_URL ?? "http://localhost:4000";

const sessions = new Map<string, { token: string }>();

async function createSession(): Promise<string> {
  const output =
    await Bun.$`bun run --env-file=apps/herman-server/.env.test apps/herman-server/scripts/create-test-session.ts`.text();
  const token = output.trim().split("\n").pop() ?? "";
  const id = crypto.randomUUID();
  sessions.set(id, { token });
  return id;
}

type Client = {
  ws: ServerWebSocket<unknown>;
  proc?: ReturnType<typeof spawn>;
};

const clients = new Map<ServerWebSocket<unknown>, Client>();

const server = Bun.serve({
  port: PORT,
  async fetch(req, server) {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true }));
    }

    if (url.pathname === "/api/session") {
      const sessionId = await createSession();
      return new Response(JSON.stringify({ sessionId, serverUrl: SERVER_URL }));
    }

    if (url.pathname === "/ws") {
      const upgraded = server.upgrade(req);
      if (upgraded) return undefined;
      return new Response("Upgrade required", { status: 426 });
    }

    // Serve static files from web-dist for e2e.
    const filePath = resolve(
      process.cwd(),
      "apps/herman-desktop/web-dist",
      url.pathname === "/" ? "index.html" : url.pathname,
    );
    const file = Bun.file(filePath);
    if (await file.exists()) {
      return new Response(file);
    }

    return new Response("Not found", { status: 404 });
  },
  websocket: {
    async open(ws) {
      console.log("[herman-e2e] WS client connected");
      clients.set(ws, { ws });
      ws.send(JSON.stringify({ type: "hello" }));
    },
    async message(ws, raw) {
      const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(text);
      } catch {
        return;
      }

      const client = clients.get(ws);
      if (!client) return;

      if (data.type === "start_agent") {
        const sessionId = typeof data.sessionId === "string" ? data.sessionId : undefined;
        const session = sessionId ? sessions.get(sessionId) : undefined;
        const token = session?.token ?? "";

        console.log("[herman-e2e] Starting agent for session", sessionId);

        const proc = spawn(process.execPath, [AGENT_PATH, "--mode", "rpc"], {
          env: {
            ...process.env,
            HERMAN_SERVER_URL: SERVER_URL,
            HERMAN_SESSION_TOKEN: token,
            HERMAN_CLIENT_VERSION: "0.0.1",
          },
          stdio: ["pipe", "pipe", "pipe"],
        });

        client.proc = proc;

        proc.stdout.on("data", (chunk: Buffer) => {
          const lines = chunk.toString().split("\n");
          for (const line of lines) {
            if (!line.trim()) continue;
            console.log("[herman-e2e] agent stdout:", line.slice(0, 200));
            ws.send(JSON.stringify({ type: "agent_event", event: JSON.parse(line) }));
          }
        });

        proc.stderr.on("data", (chunk: Buffer) => {
          console.error("[herman-e2e] agent stderr:", chunk.toString().slice(0, 200));
          ws.send(JSON.stringify({ type: "agent_stderr", text: chunk.toString() }));
        });

        proc.on("exit", (code) => {
          ws.send(JSON.stringify({ type: "agent_exit", code }));
        });
      }

      if (data.type === "agent_command" && typeof data.command === "string") {
        console.log("[herman-e2e] Forwarding command", data.command.slice(0, 200));
        client.proc?.stdin?.write(`${data.command}\n`);
      }

      if (data.type === "abort") {
        client.proc?.kill("SIGTERM");
      }
    },
    close(ws) {
      const client = clients.get(ws);
      client?.proc?.kill("SIGTERM");
      clients.delete(ws);
    },
  },
});

console.log(`[herman-e2e] Server running on http://localhost:${PORT}`);
console.log(`[herman-e2e] Agent path: ${AGENT_PATH}`);
console.log(`[herman-e2e] Herman server: ${SERVER_URL}`);
