import { useCallback, useRef } from "react";
import { GitCompare } from "lucide-react";

import { useAgentStore } from "../lib/agent-store.js";
import { AdSidebar } from "./ad-sidebar.js";
import { ChangesPanel } from "./changes-panel.js";

const MIN_WIDTH = 200;
const MAX_WIDTH = 600;

/** Thin tab bar rendered between the always-visible ads and the content area. */
function SidebarTabs() {
  const sidebarTab = useAgentStore((s) => s.ui.sidebarTab);
  const setSidebarTab = useAgentStore((s) => s.setSidebarTab);

  return (
    <div className="flex shrink-0 border-b border-white/[0.06]">
      <button
        type="button"
        onClick={() => setSidebarTab("changes")}
        className={`flex flex-1 items-center justify-center gap-1.5 px-3 py-1.5 text-[10px] font-medium transition-colors ${
          sidebarTab === "changes"
            ? "text-text border-b-2 border-signal pb-[calc(0.375rem-2px)]"
            : "text-dim hover:text-text pb-1.5"
        }`}
        title="Changed files"
      >
        <GitCompare size={12} />
        Changes
      </button>
    </div>
  );
}

/**
 * Right sidebar: always-visible ad panel on top, tabs below for tooling panels
 * (diff viewer, etc.).  Only shown in normal mode.
 */
export function RightSidebar() {
  const width = useAgentStore((s) => s.ui.sidebarWidth ?? 288);
  const sidebarTab = useAgentStore((s) => s.ui.sidebarTab);
  const setSidebarWidth = useAgentStore((s) => s.setSidebarWidth);
  const dragStart = useRef<{ x: number; width: number } | null>(null);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      document.body.style.userSelect = "none";
      dragStart.current = { x: e.clientX, width };
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [width],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragStart.current) return;
      const delta = e.clientX - dragStart.current.x;
      const nextWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, dragStart.current.width - delta));
      setSidebarWidth(nextWidth);
    },
    [setSidebarWidth],
  );

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    dragStart.current = null;
    document.body.style.userSelect = "";
    e.currentTarget.releasePointerCapture(e.pointerId);
  }, []);

  return (
    <div className="relative flex h-full shrink-0" style={{ width }}>
      {/* Resize handle */}
      <div
        className="absolute top-0 bottom-0 left-0 z-10 flex w-2 -translate-x-1/2 cursor-col-resize touch-none items-center justify-center select-none"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        <div className="h-full w-px bg-white/[0.12]" />
      </div>
      <div className="bg-surface/30 flex h-full min-w-0 flex-1 flex-col overflow-hidden">
        {/* Always-visible ad panel */}
        <div className="shrink-0">
          <AdSidebar />
        </div>

        {/* Tab bar */}
        <SidebarTabs />

        {/* Tab content */}
        <div className="flex-1 overflow-hidden">
          {sidebarTab === "changes" ? <ChangesPanel /> : null}
        </div>
      </div>
    </div>
  );
}
