import { describe, expect, it } from "vitest";
import type { Subprocess } from "bun";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { $ } from "bun";

const CLI_PATH = resolve(import.meta.dir, "..", "dist", "cli.js");
type PipedSubprocess = Subprocess<"pipe", "pipe", "pipe">;

async function ensureBuiltCli() {
  if (existsSync(CLI_PATH)) return;
  await $`bun run build`;
}

async function sendAndReceive(
  proc: PipedSubprocess,
  command: unknown,
): Promise<unknown> {
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();

  proc.stdin.write(`${JSON.stringify(command)}\n`);

  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as { type?: string; id?: string };
        if (parsed.type === "response" && parsed.id === (command as { id: string }).id) {
          void reader.cancel();
          return parsed;
        }
      } catch {
        // ignore malformed lines
      }
    }
  }
  return undefined;
}

describe("Herman agent CLI", () => {
  it("spawns in RPC mode and responds to get_state", async () => {
    await ensureBuiltCli();

    const proc = Bun.spawn({
      cmd: ["bun", CLI_PATH, "--mode", "rpc"],
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        HERMAN_SERVER_URL: "http://localhost:4000",
        HERMAN_SESSION_TOKEN: "test-token",
      },
    }) as PipedSubprocess;

    try {
      const response = await sendAndReceive(proc, { id: "test-1", type: "get_state" });
      expect(response).toMatchObject({
        type: "response",
        id: "test-1",
        command: "get_state",
        success: true,
      });
    } finally {
      proc.kill("SIGTERM");
      await proc.exited;
    }
  }, 15_000);
});
