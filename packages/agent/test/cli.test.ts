import { describe, expect, it } from "vitest";
import type { Subprocess } from "bun";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { $ } from "bun";

const CLI_PATH = resolve(import.meta.dir, "..", "dist", "herman-agent");
type PipedSubprocess = Subprocess<"pipe", "pipe", "pipe">;

const SPAWN_ENV = {
  ...process.env,
  HERMAN_SERVER_URL: "http://localhost:4000",
  HERMAN_SESSION_TOKEN: "test-token",
};

async function ensureBuiltCli() {
  if (existsSync(CLI_PATH)) return;
  await $`bun run build`;
}

function spawnRpcAgent(): PipedSubprocess {
  return Bun.spawn({
    cmd: [CLI_PATH, "--mode", "rpc"],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: SPAWN_ENV,
  }) as PipedSubprocess;
}

function assertValidJsonlLine(line: string): void {
  const parsed = JSON.parse(line) as { type?: unknown };
  expect(parsed).toBeTypeOf("object");
  expect(parsed).not.toBeNull();
  expect(parsed.type).toBeTypeOf("string");
}

async function sendAndReceive(
  proc: PipedSubprocess,
  command: unknown,
  onStdoutLine?: (line: string) => void,
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
      onStdoutLine?.(line);
      try {
        const parsed = JSON.parse(line) as { type?: string; id?: string };
        if (parsed.type === "response" && parsed.id === (command as { id: string }).id) {
          void reader.cancel();
          return parsed;
        }
      } catch {
        // ignore malformed lines while waiting for the matching response
      }
    }
  }
  return undefined;
}

async function collectStreamForMs(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    const result = await Promise.race([
      reader.read(),
      new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) =>
        setTimeout(() => resolve({ done: true, value: undefined }), remaining),
      ),
    ]);
    if (result.done) break;
    if (result.value) {
      text += decoder.decode(result.value, { stream: true });
    }
  }

  try {
    await reader.cancel();
  } catch {
    // ignore
  }

  return text;
}

async function readStartupStreams(
  proc: PipedSubprocess,
  timeoutMs: number,
): Promise<{ stdoutLines: string[]; stderr: string }> {
  const [stdoutText, stderr] = await Promise.all([
    collectStreamForMs(proc.stdout.getReader(), timeoutMs),
    collectStreamForMs(proc.stderr.getReader(), timeoutMs),
  ]);

  const stdoutLines = stdoutText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  return { stdoutLines, stderr };
}

describe("Herman agent CLI", () => {
  it("spawns in RPC mode and responds to get_state", async () => {
    await ensureBuiltCli();

    const proc = spawnRpcAgent();

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

  it("keeps startup stdout JSONL-only and writes logs to stderr", async () => {
    await ensureBuiltCli();

    const proc = spawnRpcAgent();

    try {
      const { stdoutLines, stderr } = await readStartupStreams(proc, 1_000);

      for (const line of stdoutLines) {
        assertValidJsonlLine(line);
      }

      expect(stderr).toContain("Starting agent");
    } finally {
      proc.kill("SIGTERM");
      await proc.exited;
    }
  }, 15_000);

  it("keeps stdout JSONL-only while handling RPC commands", async () => {
    await ensureBuiltCli();

    const proc = spawnRpcAgent();
    const stdoutLines: string[] = [];

    try {
      const response = await sendAndReceive(
        proc,
        { id: "test-jsonl-2", type: "get_state" },
        (line) => stdoutLines.push(line),
      );

      expect(response).toMatchObject({
        type: "response",
        id: "test-jsonl-2",
        command: "get_state",
        success: true,
      });

      expect(stdoutLines.length).toBeGreaterThan(0);
      for (const line of stdoutLines) {
        assertValidJsonlLine(line);
      }
    } finally {
      proc.kill("SIGTERM");
      await proc.exited;
    }
  }, 15_000);
});
