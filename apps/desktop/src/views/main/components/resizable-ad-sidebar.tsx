import { useCallback, useRef } from "react";

import { useAgentStore } from "../lib/agent-store.js";
import { AdSidebar } from "./ad-sidebar.js";

const MIN_WIDTH = 200;
const MAX_WIDTH = 600;
export const DEFAULT_SIDEBAR_WIDTH = 288;

export function ResizableAdSidebar() {
  const width = useAgentStore((s) => s.ui.sidebarWidth ?? DEFAULT_SIDEBAR_WIDTH);
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
      <div
        className="absolute top-0 bottom-0 left-0 z-10 flex w-2 -translate-x-1/2 cursor-col-resize touch-none items-center justify-center select-none"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        <div className="h-full w-px bg-white/[0.12]" />
      </div>
      <div className="bg-surface/30 flex h-full min-w-0 flex-1 flex-col overflow-hidden">
        <AdSidebar />
      </div>
    </div>
  );
}
