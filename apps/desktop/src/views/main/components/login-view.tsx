import { Sparkles, Copy, ExternalLink, ArrowLeft, Loader2 } from "lucide-react";
import { getLogger } from "@logtape/logtape";
import { useEffect, useState } from "react";

import { desktopRpc } from "../lib/desktop-rpc.js";

const logger = getLogger(["herman-desktop", "view", "login"]);

export function LoginView() {
  const [code, setCode] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("");
  const [isError, setIsError] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const listener = (update: { status: string; message: string }) => {
      if (update.status === "activation-expired") {
        setIsError(true);
        setStatus(update.message);
        setCode(null);
      } else if (update.status === "activation-error") {
        setIsError(true);
        setStatus(update.message);
      } else if (update.status === "activation-code") {
        setIsError(false);
        setStatus(update.message);
      }
    };
    desktopRpc.addMessageListener("updateStatus", listener);
    return () => desktopRpc.removeMessageListener("updateStatus", listener);
  }, []);

  async function signIn() {
    setIsLoading(true);
    setStatus("Requesting device code…");
    setIsError(false);
    try {
      const response = await desktopRpc.request.startDeviceActivation();
      setCode(response.userCode);
      setStatus("Your browser should have opened. Use the code below if needed.");
      desktopRpc.send.openVerificationUrl();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start sign in";
      logger.warning("Sign in failed", { error: message });
      setIsError(true);
      setStatus(message);
    } finally {
      setIsLoading(false);
    }
  }

  function copyCode() {
    if (code) {
      desktopRpc.request.copyToClipboard({ text: code }).catch(() => {});
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  }

  function openUrl() {
    desktopRpc.send.openVerificationUrl();
  }

  function cancel() {
    setCode(null);
    setStatus("");
    setIsError(false);
    desktopRpc.send.cancelActivation();
  }

  return (
    <div className="bg-void flex h-full items-center justify-center p-6">
      {/* Ambient glow behind the card */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div className="bg-signal/10 h-[520px] w-[520px] rounded-full blur-[140px]" />
      </div>

      <div className="animate-fade-in-up relative w-full max-w-md">
        <div className="bg-peak rounded-3xl border border-white/[0.12] p-10 shadow-2xl shadow-black/50">
          {/* Logo */}
          <div className="mb-8 flex justify-center">
            <div className="animate-signal-pulse bg-signal/10 text-signal flex h-[72px] w-[72px] items-center justify-center rounded-2xl">
              <Sparkles size={32} strokeWidth={1.5} />
            </div>
          </div>

          <div className="text-center">
            <h1 className="text-text mb-2 text-center text-[28px] font-semibold tracking-tight">
              Sign in to Herman
            </h1>
            <p className="text-dim mx-auto max-w-xs text-center text-sm leading-relaxed text-balance">
              A free coding agent for your desktop. Funded by ads, powered by Clique.
            </p>
          </div>

          <div className="mt-8">
            {code ? (
              <div className="animate-fade-in-up space-y-4">
                <div className="border-signal/20 bg-signal/5 rounded-2xl border p-5 text-center">
                  <div className="text-signal mb-1 text-xs font-medium tracking-wider uppercase">
                    Your code
                  </div>
                  <div className="text-text font-mono text-3xl tracking-[0.2em]">{code}</div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <button
                    onClick={copyCode}
                    className="text-text flex items-center justify-center gap-2 rounded-xl border border-white/[0.06] bg-white/[0.04] px-4 py-2.5 text-sm font-medium transition hover:bg-white/[0.08] active:scale-[0.96]"
                  >
                    <Copy size={14} />
                    {copied ? "Copied" : "Copy code"}
                  </button>
                  <button
                    onClick={openUrl}
                    className="bg-signal hover:bg-signal-dim flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold text-primary-foreground transition active:scale-[0.96]"
                  >
                    <ExternalLink size={14} />
                    Open browser
                  </button>
                </div>

                <button
                  onClick={cancel}
                  className="text-faint hover:text-dim flex w-full items-center justify-center gap-1.5 rounded-xl px-4 py-2.5 text-sm font-medium transition hover:bg-white/[0.04] active:scale-[0.96]"
                >
                  <ArrowLeft size={14} />
                  Back to sign in
                </button>
              </div>
            ) : (
              <button
                onClick={signIn}
                disabled={isLoading}
                className="bg-signal hover:bg-signal-dim flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold text-primary-foreground shadow-[0_0_24px_rgba(34,197,94,0.18)] transition hover:shadow-[0_0_32px_rgba(34,197,94,0.28)] active:scale-[0.96] disabled:opacity-60"
              >
                {isLoading ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <ExternalLink size={16} />
                )}
                {isLoading ? "Connecting…" : "Continue with browser"}
              </button>
            )}

            {status && (
              <div
                className={`mt-4 rounded-xl px-4 py-3 text-center text-xs leading-relaxed ${
                  isError
                    ? "border border-red-500/20 bg-red-500/10 text-red-400"
                    : code
                      ? "text-dim"
                      : "text-faint"
                }`}
              >
                {status}
              </div>
            )}
          </div>
        </div>

        <p className="text-ghost mt-5 text-center text-xs">
          By signing in, you agree to Clique&apos;s Terms of Service.
        </p>
      </div>
    </div>
  );
}
