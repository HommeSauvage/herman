import { memo } from "react";

import { Spinner } from "./spinner.js";
import { TextShimmer } from "./text-shimmer.js";

export const ThinkingRow = memo(function ThinkingRow() {
  return (
    <div
      role="status"
      aria-live="polite"
      data-slot="session-turn-thinking"
      className="text-faint mt-3 flex min-h-5 items-center gap-2 text-sm font-medium"
    >
      <Spinner className="text-signal size-3.5" />
      <TextShimmer text="Thinking" active />
    </div>
  );
});
