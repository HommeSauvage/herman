/**
 * useToolchainInstall — run a toolchain install and track live progress.
 *
 * The bun side streams `toolchainEvent` messages tagged with a client-generated
 * runId; this hook owns the subscription and reduces events into per-tool
 * progress state. `runInstall` resolves with the final results on `all-done`.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type {
  ToolchainEvent,
  ToolInstallItem,
  ToolInstallResult,
} from "../../../shared/tool-registry.js";
import { desktopRpc } from "./desktop-rpc.js";

export type ToolProgress = {
  toolId: string;
  label: string;
  state: "pending" | "running" | "waiting" | "done" | "failed";
  /** Waiting message (native dialog up) or failure reason. */
  note?: string;
};

export type InstallRunState = {
  running: boolean;
  tools: ToolProgress[];
  logLines: string[];
};

const IDLE: InstallRunState = { running: false, tools: [], logLines: [] };

export function useToolchainInstall() {
  const [state, setState] = useState<InstallRunState>(IDLE);
  const runIdRef = useRef<string | null>(null);
  const resolveRef = useRef<((results: ToolInstallResult[]) => void) | null>(null);

  useEffect(() => {
    const handler = ({ event }: { event: ToolchainEvent }) => {
      if (!runIdRef.current || event.runId !== runIdRef.current) return;

      setState((prev) => {
        switch (event.type) {
          case "tool-start":
            return {
              ...prev,
              tools: prev.tools.map((t) =>
                t.toolId === event.toolId
                  ? { ...t, state: "running" as const, note: event.message }
                  : t,
              ),
            };
          case "tool-log":
            return { ...prev, logLines: [...prev.logLines, event.text].slice(-200) };
          case "tool-waiting":
            return {
              ...prev,
              tools: prev.tools.map((t) =>
                t.toolId === event.toolId
                  ? { ...t, state: "waiting" as const, note: event.message }
                  : t,
              ),
            };
          case "tool-done":
            return {
              ...prev,
              tools: prev.tools.map((t) =>
                t.toolId === event.toolId
                  ? {
                      ...t,
                      state: event.ok ? ("done" as const) : ("failed" as const),
                      ...(event.ok ? {} : { note: event.error }),
                    }
                  : t,
              ),
            };
          case "all-done":
            return { ...prev, running: false };
          default:
            return prev;
        }
      });

      if (event.type === "all-done") {
        const resolve = resolveRef.current;
        resolveRef.current = null;
        runIdRef.current = null;
        resolve?.(event.results);
      }
    };

    desktopRpc.addMessageListener("toolchainEvent", handler);
    return () => desktopRpc.removeMessageListener("toolchainEvent", handler);
  }, []);

  const runInstall = useCallback(async (items: ToolInstallItem[]): Promise<ToolInstallResult[]> => {
    const runId =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `run-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    setState({
      running: true,
      tools: items.map((i) => ({
        toolId: i.toolId,
        label: i.label ?? i.toolId,
        state: "pending" as const,
      })),
      logLines: [],
    });

    const done = new Promise<ToolInstallResult[]>((resolve) => {
      resolveRef.current = resolve;
      runIdRef.current = runId;
    });

    try {
      const { accepted, reason } = await desktopRpc.request.installTools({ runId, items });
      if (!accepted) {
        resolveRef.current = null;
        runIdRef.current = null;
        const results = items.map((i) => ({
          toolId: i.toolId,
          ok: false,
          error: reason ?? "Install was not accepted",
        }));
        setState((prev) => ({
          ...prev,
          running: false,
          tools: prev.tools.map((t) => ({ ...t, state: "failed" as const, note: reason })),
        }));
        return results;
      }
    } catch (error) {
      resolveRef.current = null;
      runIdRef.current = null;
      const message = error instanceof Error ? error.message : String(error);
      setState((prev) => ({ ...prev, running: false }));
      return items.map((i) => ({ toolId: i.toolId, ok: false, error: message }));
    }

    return done;
  }, []);

  const reset = useCallback(() => setState(IDLE), []);

  return { state, runInstall, reset };
}
