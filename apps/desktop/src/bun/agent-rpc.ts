import { getLogger } from "@logtape/logtape";
import type { Subprocess } from "bun";

import { config } from "../env.js";
import type { AgentCommand, AgentEvent, AgentResponse } from "../shared/agent-protocol.js";
import { JsonlParser, serializeJsonl } from "./jsonl.js";

const logger = getLogger(["herman-desktop", "agent-rpc"]);

const DEFAULT_COMMAND_TIMEOUT = 30_000;

type PendingRequest = {
  resolve: (response: AgentResponse) => void;
  reject: (error: Error) => void;
};

type ToolStreamState = {
  toolName: string;
  startedAt: number;
  updateCount: number;
};

export type AgentEventListener = (event: AgentEvent) => void;
export type AgentResponseListener = (response: AgentResponse) => void;
export type AgentExitListener = (code: number) => void;
export type AgentErrorListener = (error: Error) => void;
export type AgentStderrListener = (data: string) => void;

type PipedSubprocess = Subprocess<"pipe", "pipe", "pipe">;

function stderrLogLevel(line: string): "info" | "debug" | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (trimmed.includes("[herman-extension]")) {
    return /error|failed|refuses/i.test(trimmed) ? "info" : "debug";
  }
  return "info";
}

const STDERR_MAX_LINES = 200;
const STDERR_MAX_BYTES = 64 * 1024;

export class AgentRpcClient {
  private subprocess: PipedSubprocess | null = null;
  private parser: JsonlParser;
  private pendingRequests = new Map<string, PendingRequest>();
  private requestCounter = 0;
  private commandTimeout: number;
  private stderrBuffer = "";
  private stderrLines: string[] = [];
  private exited = false;
  private stdoutReader?: ReadableStreamDefaultReader<Uint8Array>;
  private stderrReader?: ReadableStreamDefaultReader<Uint8Array>;

  private eventListeners: AgentEventListener[] = [];
  private responseListeners: AgentResponseListener[] = [];
  private exitListeners: AgentExitListener[] = [];
  private errorListeners: AgentErrorListener[] = [];
  private stderrListeners: AgentStderrListener[] = [];
  private messageStreamStartedAt: number | null = null;
  private messageUpdateCount = 0;
  private toolStreams = new Map<string, ToolStreamState>();

  constructor(commandTimeout = DEFAULT_COMMAND_TIMEOUT) {
    this.commandTimeout = commandTimeout;
    this.parser = new JsonlParser((line) => this.handleLine(line));
  }

  attach(process: PipedSubprocess) {
    this.subprocess = process;
    this.exited = false;
    void this.readStdout();
    void this.readStderr();

    process.exited.then((code) => {
      this.exited = true;
      this.parser.flush();
      this.rejectAllPending(new Error(`Agent process exited with code ${code}`));
      for (const listener of this.exitListeners) {
        listener(code);
      }
    });
  }

  sendCommand(command: AgentCommand): Promise<AgentResponse> {
    if (!this.subprocess || this.exited) {
      return Promise.reject(new Error("Agent RPC client is not connected"));
    }

    const id = command.id ?? `herman_${++this.requestCounter}`;
    const commandWithId = { ...command, id } as AgentCommand;
    const { subprocess } = this;

    return new Promise<AgentResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Command ${command.type} timed out after ${this.commandTimeout}ms`));
      }, this.commandTimeout);

      this.pendingRequests.set(id, {
        resolve: (response) => {
          clearTimeout(timer);
          if (response.type === "response" && response.success === false) {
            reject(new Error(response.error || `Command failed`));
            return;
          }
          resolve(response);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });

      subprocess.stdin.write(serializeJsonl(commandWithId));
    });
  }

  sendRaw(command: AgentCommand) {
    if (!this.subprocess || this.exited) return;
    this.subprocess.stdin.write(serializeJsonl(command));
  }

  onEvent(listener: AgentEventListener): () => void {
    this.eventListeners.push(listener);
    return () => this.removeFromArray(this.eventListeners, listener);
  }

  onResponse(listener: AgentResponseListener): () => void {
    this.responseListeners.push(listener);
    return () => this.removeFromArray(this.responseListeners, listener);
  }

  onExit(listener: AgentExitListener): () => void {
    this.exitListeners.push(listener);
    return () => this.removeFromArray(this.exitListeners, listener);
  }

  onError(listener: AgentErrorListener): () => void {
    this.errorListeners.push(listener);
    return () => this.removeFromArray(this.errorListeners, listener);
  }

  onStderr(listener: AgentStderrListener): () => void {
    this.stderrListeners.push(listener);
    return () => this.removeFromArray(this.stderrListeners, listener);
  }

  async close() {
    this.rejectAllPending(new Error("Agent RPC client closed"));

    try {
      await this.stdoutReader?.cancel();
    } catch (error) {
      logger.debug("Error cancelling stdout reader during close", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    this.stdoutReader = undefined;

    try {
      await this.stderrReader?.cancel();
    } catch (error) {
      logger.debug("Error cancelling stderr reader during close", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    this.stderrReader = undefined;

    if (this.subprocess) {
      try {
        await this.subprocess.stdin.end();
      } catch (error) {
        logger.debug("Error ending subprocess stdin during close", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  get stderr(): string {
    return this.stderrBuffer;
  }

  private async readStdout() {
    if (!this.subprocess) return;
    this.stdoutReader = this.subprocess.stdout.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await this.stdoutReader.read();
        if (done) break;
        this.parser.feed(decoder.decode(value, { stream: true }));
      }
      this.parser.flush();
    } catch (error) {
      if (!this.exited) {
        this.emitError(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private async readStderr() {
    if (!this.subprocess) return;
    this.stderrReader = this.subprocess.stderr.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await this.stderrReader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        this.appendStderr(text);
        for (const line of text.split("\n")) {
          const trimmed = line.trim();
          const level = stderrLogLevel(trimmed);
          if (level === "info") {
            logger.info("Agent stderr", { line: trimmed });
          } else if (level === "debug") {
            logger.debug("Agent stderr", { line: trimmed });
          }
        }
        for (const listener of this.stderrListeners) {
          listener(text);
        }
      }
    } catch (error) {
      logger.debug("Error reading agent stderr", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private appendStderr(text: string) {
    this.stderrBuffer += text;
    this.stderrLines.push(...text.split("\n"));
    while (this.stderrLines.length > STDERR_MAX_LINES) {
      this.stderrLines.shift();
    }
    if (this.stderrBuffer.length > STDERR_MAX_BYTES) {
      this.stderrBuffer = this.stderrLines.slice(-STDERR_MAX_LINES).join("\n");
    }
  }

  private handleLine(line: string) {
    let data: unknown;
    try {
      data = JSON.parse(line);
    } catch (error) {
      this.emitError(
        new Error(
          `Failed to parse JSONL: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      return;
    }

    if (typeof data !== "object" || data === null || !("type" in data)) {
      this.emitError(new Error(`Unexpected JSONL line (no 'type' field): ${line.slice(0, 200)}`));
      return;
    }

    const typed = data as { type: string };

    if (typed.type === "response") {
      const response = data as AgentResponse;
      this.logResponse(response, line);
      for (const listener of this.responseListeners) {
        listener(response);
      }
      const responseId = response.id;
      if (responseId && this.pendingRequests.has(responseId)) {
        const pending = this.pendingRequests.get(responseId);
        this.pendingRequests.delete(responseId);
        pending?.resolve(response);
      }
      return;
    }

    const event = data as AgentEvent;
    this.logAgentEvent(event, line, typed.type);
    for (const listener of this.eventListeners) {
      listener(event);
    }
  }

  private logResponse(response: AgentResponse, line: string) {
    if (config.verboseAgentRpc) {
      logger.debug("Agent stdout line", { line: line.slice(0, 200) });
      return;
    }

    logger.debug("Agent command response", {
      command: response.command,
      success: response.success,
      ...(response.success === false ? { error: response.error } : {}),
    });
  }

  private logAgentEvent(event: AgentEvent, line: string, rawType: string) {
    if (config.verboseAgentRpc) {
      logger.debug("Agent stdout line", { line: line.slice(0, 200) });
      return;
    }

    if (rawType === "turn_end") {
      logger.debug("Agent turn ended");
      return;
    }

    switch (event.type) {
      case "message_start": {
        this.messageStreamStartedAt = Date.now();
        this.messageUpdateCount = 0;
        const role = typeof event.message.role === "string" ? event.message.role : undefined;
        logger.debug("Agent message stream started", { role });
        break;
      }
      case "message_update": {
        this.messageUpdateCount++;
        break;
      }
      case "message_end": {
        const durationMs =
          this.messageStreamStartedAt !== null ? Date.now() - this.messageStreamStartedAt : null;
        logger.debug(
          "Agent message stream ended",
          messageEndSummary(event, this.messageUpdateCount, durationMs),
        );
        this.messageStreamStartedAt = null;
        this.messageUpdateCount = 0;
        break;
      }
      case "tool_execution_start": {
        this.toolStreams.set(event.toolCallId, {
          toolName: event.toolName,
          startedAt: Date.now(),
          updateCount: 0,
        });
        logger.debug("Agent tool execution started", {
          toolName: event.toolName,
          toolCallId: event.toolCallId,
        });
        break;
      }
      case "tool_execution_update": {
        const stream = this.toolStreams.get(event.toolCallId);
        if (stream) stream.updateCount++;
        break;
      }
      case "tool_execution_end": {
        const stream = this.toolStreams.get(event.toolCallId);
        const durationMs = stream ? Date.now() - stream.startedAt : null;
        logger.debug(
          "Agent tool execution ended",
          toolEndSummary(event, stream?.updateCount ?? 0, durationMs),
        );
        this.toolStreams.delete(event.toolCallId);
        break;
      }
      case "agent_start":
        logger.debug("Agent started");
        break;
      case "agent_end":
        this.resetStreamTracking();
        logger.debug("Agent ended", agentEndSummary(event));
        break;
      case "agent_complete":
        this.resetStreamTracking();
        logger.debug("Agent completed", agentEndSummary(event));
        break;
      case "agent_error":
        this.resetStreamTracking();
        logger.warning("Agent error", { error: event.error });
        break;
      case "extension_error":
        logger.warning("Agent extension error", {
          error: event.error,
          extensionPath: event.extensionPath,
          event: event.event,
        });
        break;
      case "herman/agent_proxy_error":
        logger.warning("Agent proxy error", { error: event.error, code: event.code });
        break;
      default:
        logger.debug("Agent event", { eventType: event.type });
    }
  }

  private resetStreamTracking() {
    this.messageStreamStartedAt = null;
    this.messageUpdateCount = 0;
    this.toolStreams.clear();
  }

  private rejectAllPending(error: Error) {
    for (const [, pending] of this.pendingRequests) {
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private emitError(error: Error) {
    for (const listener of this.errorListeners) {
      listener(error);
    }
  }

  private removeFromArray<T>(arr: T[], value: T) {
    const index = arr.indexOf(value);
    if (index !== -1) {
      arr.splice(index, 1);
    }
  }
}

function messageEndSummary(
  event: Extract<AgentEvent, { type: "message_end" }>,
  updateCount: number,
  durationMs: number | null,
) {
  const content =
    typeof event.message.content === "string"
      ? event.message.content
      : JSON.stringify(event.message.content ?? "");
  return {
    role: typeof event.message.role === "string" ? event.message.role : undefined,
    contentBytes: content.length,
    toolCallCount: Array.isArray(event.message.toolCalls) ? event.message.toolCalls.length : 0,
    updateCount,
    durationMs,
  };
}

function agentEndSummary(event: Extract<AgentEvent, { type: "agent_end" | "agent_complete" }>) {
  const messages = (event as { messages?: unknown[] }).messages;
  const lastRoles = Array.isArray(messages)
    ? messages
        .slice(-3)
        .map((m) =>
          m && typeof m === "object" && "role" in m
            ? String((m as { role?: unknown }).role ?? "?")
            : "?",
        )
        .join(",")
    : "none";
  return {
    messageCount: Array.isArray(messages) ? messages.length : 0,
    lastRoles,
  };
}

function toolEndSummary(
  event: Extract<AgentEvent, { type: "tool_execution_end" }>,
  updateCount: number,
  durationMs: number | null,
) {
  const resultText =
    typeof event.result === "string" ? event.result : JSON.stringify(event.result ?? "");
  return {
    toolName: event.toolName,
    toolCallId: event.toolCallId,
    isError: event.isError,
    resultBytes: resultText.length,
    updateCount,
    durationMs,
  };
}
