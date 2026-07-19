/**
 * ProjectToolsBanner — self-healing nudge shown when the active project's
 * declared requirements no longer pass (macOS update broke CLT, PATH
 * changed, tool uninstalled…). Checks on project switch; "Fix" runs the
 * same toolchain engine as first-run setup, inline.
 */

import { AlertTriangle, Check, Loader2, Wrench, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import type { RequirementCheckResult } from "../../../shared/herman-manifest.js";
import { currentToolPlatform, getStrategy, getToolEntry } from "../../../shared/tool-registry.js";
import { useAgentStore } from "../lib/agent-store.js";
import { desktopRpc } from "../lib/desktop-rpc.js";
import { useToolchainInstall } from "../lib/use-toolchain-install.js";

export function ProjectToolsBanner() {
  const _activeTabId = useAgentStore((s) => s.activeTabId);
  const projectRoot = useAgentStore((s) =>
    s.activeTabId
      ? (s.tabs[s.activeTabId]?.projectRoot ?? s.tabs[s.activeTabId]?.folderPath)
      : undefined,
  );

  const [missing, setMissing] = useState<RequirementCheckResult[]>([]);
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const [justFixed, setJustFixed] = useState(false);
  const { state, runInstall } = useToolchainInstall();

  const check = useCallback(async (folderPath: string) => {
    const { results } = await desktopRpc.request
      .checkProjectRequirements({ folderPath })
      .catch(() => ({ results: [] as RequirementCheckResult[] }));
    const requiredMissing = results.filter((r) => !r.ok && !r.optional);
    setMissing(requiredMissing);
    return requiredMissing.length === 0;
  }, []);

  useEffect(() => {
    setJustFixed(false);
    if (!projectRoot) {
      setMissing([]);
      return;
    }
    void check(projectRoot);
  }, [projectRoot, check]);

  const handleFix = useCallback(async () => {
    if (!projectRoot || missing.length === 0) return;
    const items = missing.map((req) => {
      const entry = getToolEntry(req.id);
      const strategy = entry ? getStrategy(entry, currentToolPlatform()) : undefined;
      return {
        toolId: req.id,
        label: req.label,
        ...(strategy || !req.installCmd ? {} : { customCommand: req.installCmd }),
      };
    });
    const results = await runInstall(items);
    const healthy = await check(projectRoot);
    if (results.every((r) => r.ok) && healthy) {
      setJustFixed(true);
      setTimeout(() => setJustFixed(false), 4000);
    }
  }, [projectRoot, missing, runInstall, check]);

  const bannerKey = `${projectRoot}:${missing.map((m) => m.id).join(",")}`;
  if (!projectRoot || missing.length === 0 || dismissedFor === bannerKey) {
    if (!justFixed) return null;
  }

  if (justFixed) {
    return (
      <div className="border-b border-emerald-500/15 bg-emerald-500/[0.06] px-5 py-2">
        <div className="mx-auto flex w-full max-w-3xl items-center gap-2 text-xs text-emerald-400">
          <Check size={13} strokeWidth={2.5} />
          Tools repaired — you're good to go.
        </div>
      </div>
    );
  }

  return (
    <div className="border-b border-amber-500/15 bg-amber-500/[0.06] px-5 py-2">
      <div className="mx-auto flex w-full max-w-3xl items-center gap-2.5 text-xs">
        <AlertTriangle size={13} className="shrink-0 text-amber-400" />
        <span className="min-w-0 flex-1 truncate text-amber-200/90">
          {missing.length === 1
            ? `${missing[0]?.label} went missing — this project needs it.`
            : `Missing tools: ${missing.map((m) => m.label).join(", ")}.`}
        </span>
        <button
          type="button"
          disabled={state.running}
          onClick={handleFix}
          className="flex shrink-0 items-center gap-1 rounded-lg bg-amber-500/15 px-2 py-1 font-medium text-amber-200 transition hover:bg-amber-500/25 disabled:opacity-60"
        >
          {state.running ? <Loader2 size={11} className="animate-spin" /> : <Wrench size={11} />}
          {state.running ? "Fixing…" : "Fix"}
        </button>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => setDismissedFor(bannerKey)}
          className="shrink-0 rounded p-0.5 text-amber-200/60 transition hover:text-amber-200"
        >
          <X size={13} />
        </button>
      </div>
    </div>
  );
}
