import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@herman/ui/components/accordion";
import { AlertCircle, Sparkles, X } from "lucide-react";

import { SignalButton } from "./ui/signal-button.js";

export type PreviewRuntimeError = {
  id: string;
  source: "client" | "server";
  message: string;
  ts: number;
};

type PreviewErrorBannerProps = {
  errors: PreviewRuntimeError[];
  onDismiss: () => void;
  onAsk: () => void;
  disabled?: boolean;
};

export function PreviewErrorBanner({
  errors,
  onDismiss,
  onAsk,
  disabled,
}: PreviewErrorBannerProps) {
  return (
    <div
      data-herman-preview-error-banner
      role="status"
      className="absolute inset-x-3 bottom-3 z-10 rounded-2xl border border-mist bg-surface/95 p-4 shadow-2xl backdrop-blur-sm"
    >
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-red-500/10">
          <AlertCircle className="text-red-400" size={18} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h3 className="text-text text-sm font-semibold">
                There were some errors in the logs
              </h3>
              <p className="text-ghost mt-0.5 text-xs">
                {errors.length} error{errors.length === 1 ? "" : "s"} detected
              </p>
            </div>
            <button
              type="button"
              onClick={onDismiss}
              aria-label="Dismiss"
              className="text-ghost hover:text-dim flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition hover:bg-white/[0.04]"
            >
              <X size={14} />
            </button>
          </div>

          <Accordion className="mt-3 border-white/[0.06] bg-transparent">
            <AccordionItem value="details" className="border-white/[0.06]">
              <AccordionTrigger className="px-0 py-2 text-xs hover:no-underline">
                See details
              </AccordionTrigger>
              <AccordionContent className="text-dim max-h-[160px] overflow-y-auto px-0 pb-0 font-mono text-xs whitespace-pre-wrap">
                {errors.map((entry) => (
                  <div key={entry.id} className="mb-2 last:mb-0">
                    <span className="text-ghost">[{entry.source}]</span> {entry.message}
                  </div>
                ))}
              </AccordionContent>
            </AccordionItem>
          </Accordion>

          <div className="mt-3">
            <SignalButton size="sm" onClick={onAsk} disabled={disabled}>
              <Sparkles size={13} />
              Ask Herman to fix
            </SignalButton>
          </div>
        </div>
      </div>
    </div>
  );
}
