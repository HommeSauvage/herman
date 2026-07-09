import { spawn } from "node:child_process";
import { resolve } from "node:path";

import type { ServerWebSocket } from "bun";

const repoRoot = resolve(import.meta.dir, "../../../..");
const desktopRoot = resolve(import.meta.dir, "../../..");

export const E2E_PORT = Number(process.env.HERMAN_E2E_PORT ?? "8765");
export const E2E_BASE_URL = `http://localhost:${E2E_PORT}`;

const AGENT_PATH =
  process.env.HERMAN_AGENT_PATH ?? resolve(repoRoot, "packages/agent/dist/cli.js");
const SERVER_URL = process.env.HERMAN_SERVER_URL ?? "http://localhost:4000";
const RENDERER_DIR = resolve(desktopRoot, "dist/renderer");

const sessions = new Map<string, { token: string }>();

async function createSession(): Promise<string> {
  const token = process.env.HERMAN_E2E_SESSION_TOKEN;
  if (token) {
    const id = crypto.randomUUID();
    sessions.set(id, { token });
    return id;
  }

  const script = process.env.HERMAN_E2E_CREATE_SESSION_SCRIPT;
  const envFile = process.env.HERMAN_E2E_SESSION_ENV_FILE;
  if (!script) {
    throw new Error(
      "Set HERMAN_E2E_SESSION_TOKEN or HERMAN_E2E_CREATE_SESSION_SCRIPT for e2e session creation",
    );
  }

  const output = envFile
    ? await Bun.$`bun run --env-file=${envFile} ${script}`.text()
    : await Bun.$`bun run ${script}`.text();
  const sessionToken = output.trim().split("\n").pop() ?? "";
  if (!sessionToken) {
    throw new Error("Failed to create Herman session for e2e");
  }

  const id = crypto.randomUUID();
  sessions.set(id, { token: sessionToken });
  return id;
}

type Client = {
  ws: ServerWebSocket<unknown>;
  proc?: ReturnType<typeof spawn>;
};

const clients = new Map<ServerWebSocket<unknown>, Client>();

export type E2EServer = {
  port: number;
  stop: () => void;
};

export function startE2EServer(): E2EServer {
  const server = Bun.serve({
    port: E2E_PORT,
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

      const filePath = resolve(
        RENDERER_DIR,
        url.pathname === "/" ? "index.html" : url.pathname.slice(1),
      );
      const file = Bun.file(filePath);
      if (await file.exists()) {
        return new Response(file);
      }

      return new Response("Not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        clients.set(ws, { ws });
        ws.send(JSON.stringify({ type: "hello" }));
      },
      message(ws, raw) {
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
              ws.send(JSON.stringify({ type: "agent_event", event: JSON.parse(line) }));
            }
          });

          proc.stderr.on("data", (chunk: Buffer) => {
            ws.send(JSON.stringify({ type: "agent_stderr", text: chunk.toString() }));
          });

          proc.on("exit", (code) => {
            ws.send(JSON.stringify({ type: "agent_exit", code }));
          });
        }

        if (data.type === "agent_command" && typeof data.command === "string") {
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

  return {
    port: server.port ?? E2E_PORT,
    stop: () => server.stop(),
  };
}
