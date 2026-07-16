import { AlertCircle, Sparkles } from "lucide-react";

import { SignalButton } from "../ui/signal-button.js";

export type PreviewErrorBoxProps = {
  title: string;
  subtitle?: string;
  error: string;
  onAsk: () => void;
  onRetry?: () => void;
  disabled?: boolean;
};

export function PreviewErrorBox({
  title,
  subtitle,
  error,
  onAsk,
  onRetry,
  disabled,
}: PreviewErrorBoxProps) {
  return (
    <div className="w-full max-w-xl rounded-2xl border border-mist bg-surface/50 p-5 shadow-2xl">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-red-500/10">
          <AlertCircle className="text-red-400" size={20} />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-text text-sm font-semibold">{title}</h3>
          {subtitle && <p className="text-ghost mt-0.5 text-xs">{subtitle}</p>}
          <div className="text-dim mt-2 max-h-[180px] overflow-y-auto rounded-lg border border-white/6 bg-black/20 p-3 font-mono text-xs whitespace-pre-wrap">
            {error}
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <SignalButton size="sm" onClick={onAsk} disabled={disabled}>
              <Sparkles size={13} />
              Ask Herman to fix
            </SignalButton>
            {onRetry && (
              <button
                onClick={onRetry}
                className="text-ghost hover:text-dim rounded-lg border border-white/8 px-3 py-2 text-xs transition hover:bg-white/4"
              >
                Try again
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
