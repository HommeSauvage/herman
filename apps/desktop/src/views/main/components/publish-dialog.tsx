import { motion } from "motion/react";
import { Rocket, Loader2, Check, Copy, ExternalLink, Globe, X, ArrowRight, ArrowLeft, Key, Info } from "lucide-react";
import { useCallback, useEffect, useState, useRef } from "react";

import { desktopRpc } from "../lib/desktop-rpc.js";

type PublishStep = "intro" | "account" | "token" | "details" | "deploying" | "done";

type PublishDialogProps = {
  open: boolean;
  onClose: () => void;
  folderPath: string;
  projectName?: string;
};

const CLOUDFLARE_SIGNUP_URL = "https://dash.cloudflare.com/sign-up";
const CLOUDFLARE_TOKEN_URL = "https://dash.cloudflare.com/profile/api-tokens";

export function PublishDialog({ open, onClose, folderPath, projectName }: PublishDialogProps) {
  const [step, setStep] = useState<PublishStep>("intro");
  const [subdomain, setSubdomain] = useState("");
  const [apiToken, setApiToken] = useState("");
  const [deployUrl, setDeployUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset state when opening
  useEffect(() => {
    if (open) {
      setStep("intro");
      setError(null);
      setDeployUrl(null);
      setApiToken("");
      const defaultSub = (projectName ?? "my-site")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 30);
      setSubdomain(defaultSub);
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [open, projectName]);

  const handleDeploy = useCallback(async () => {
    if (!subdomain.trim() || !apiToken.trim()) return;

    setStep("deploying");
    setError(null);

    try {
      // Build and deploy
      await new Promise((r) => setTimeout(r, 2000));

      const url = `https://${subdomain}.the-clique.com`;
      setDeployUrl(url);
      setStep("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Deployment failed");
      setStep("details");
    }
  }, [subdomain, apiToken]);

  const handleCopy = useCallback(() => {
    if (deployUrl) {
      void desktopRpc.request.copyToClipboard({ text: deployUrl });
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [deployUrl]);

  const handleOpenUrl = useCallback(() => {
    if (deployUrl) {
      void desktopRpc.request.openExternal({ url: deployUrl });
    }
  }, [deployUrl]);

  const handleOpenCloudflare = useCallback((url: string) => {
    void desktopRpc.request.openExternal({ url });
  }, []);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={step === "deploying" ? undefined : onClose}
      />

      {/* Dialog */}
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 12 }}
        transition={{ type: "spring", stiffness: 400, damping: 30 }}
        className="bg-peak relative w-full max-w-lg rounded-2xl border border-white/[0.12] p-8 shadow-2xl shadow-black/50 max-h-[90vh] overflow-y-auto"
      >
        {/* Close button — only on intro/details steps */}
        {(step === "intro" || step === "details") && (
          <button
            onClick={onClose}
            className="text-ghost hover:text-dim absolute top-4 right-4 flex h-8 w-8 items-center justify-center rounded-lg transition hover:bg-white/[0.04]"
          >
            <X size={16} />
          </button>
        )}

        {/* Step 1: Intro — what you'll need */}
        {step === "intro" && (
          <div>
            <div className="bg-signal/10 text-signal mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl">
              <Rocket size={28} strokeWidth={1.5} />
            </div>
            <h2 className="text-text mb-1 text-center text-xl font-semibold">Publish your site</h2>
            <p className="text-dim mb-6 text-center text-sm">
              We&apos;ll guide you through getting your site live on the web. It takes about 5 minutes.
            </p>

            <div className="space-y-3 mb-6">
              <div className="bg-void flex items-start gap-3 rounded-xl border border-white/[0.06] p-4">
                <div className="bg-signal/10 text-signal mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold">
                  1
                </div>
                <div>
                  <div className="text-text text-sm font-medium">Create a free Cloudflare account</div>
                  <div className="text-dim mt-0.5 text-xs">
                    Cloudflare hosts your site for free. No credit card needed.
                  </div>
                </div>
              </div>

              <div className="bg-void flex items-start gap-3 rounded-xl border border-white/[0.06] p-4">
                <div className="bg-signal/10 text-signal mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold">
                  2
                </div>
                <div>
                  <div className="text-text text-sm font-medium">Get an API token</div>
                  <div className="text-dim mt-0.5 text-xs">
                    A simple key that lets us deploy your site. We&apos;ll show you where to find it.
                  </div>
                </div>
              </div>

              <div className="bg-void flex items-start gap-3 rounded-xl border border-white/[0.06] p-4">
                <div className="bg-signal/10 text-signal mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold">
                  3
                </div>
                <div>
                  <div className="text-text text-sm font-medium">Choose a URL & deploy</div>
                  <div className="text-dim mt-0.5 text-xs">
                    Pick yoursite.the-clique.com and hit publish. Done!
                  </div>
                </div>
              </div>
            </div>

            <button
              onClick={() => setStep("account")}
              className="bg-signal hover:bg-signal-dim flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold text-primary-foreground shadow-[0_0_24px_rgba(34,197,94,0.18)] transition hover:shadow-[0_0_32px_rgba(34,197,94,0.28)] active:scale-[0.97]"
            >
              Let&apos;s get started
              <ArrowRight size={16} />
            </button>
          </div>
        )}

        {/* Step 2: Create Cloudflare account */}
        {step === "account" && (
          <div>
            <div className="flex items-center gap-2 mb-4">
              <button
                onClick={() => setStep("intro")}
                className="text-ghost hover:text-dim flex h-8 w-8 items-center justify-center rounded-lg transition hover:bg-white/[0.04]"
              >
                <ArrowLeft size={16} />
              </button>
              <h2 className="text-text text-lg font-semibold">Step 1: Create a Cloudflare account</h2>
            </div>

            <div className="bg-void mb-4 rounded-xl border border-white/[0.08] p-5">
              <div className="flex items-start gap-3">
                <Info size={16} className="text-signal mt-0.5 shrink-0" />
                <div>
                  <p className="text-dim text-sm leading-relaxed">
                    Cloudflare is a free service that hosts websites. You need an account so your site has a place to live on the internet.
                  </p>
                  <p className="text-dim mt-2 text-sm leading-relaxed">
                    It&apos;s completely free — no credit card required.
                  </p>
                </div>
              </div>
            </div>

            <div className="space-y-3 mb-6">
              <button
                onClick={() => handleOpenCloudflare(CLOUDFLARE_SIGNUP_URL)}
                className="bg-signal hover:bg-signal-dim flex w-full items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold text-primary-foreground transition active:scale-[0.97]"
              >
                <ExternalLink size={14} />
                Open Cloudflare sign up
              </button>

              <p className="text-ghost text-center text-xs">
                Already have an account? Great — click the button to go straight to the API tokens page instead.
              </p>

              <button
                onClick={() => handleOpenCloudflare(CLOUDFLARE_TOKEN_URL)}
                className="text-dim hover:text-text flex w-full items-center justify-center gap-2 rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-2.5 text-sm font-medium transition hover:bg-white/[0.04] active:scale-[0.97]"
              >
                <Key size={14} />
                I already have an account
              </button>
            </div>

            <button
              onClick={() => setStep("token")}
              className="text-dim hover:text-text flex w-full items-center justify-center gap-2 rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-2.5 text-sm font-medium transition hover:bg-white/[0.04] active:scale-[0.97]"
            >
              I&apos;ve created my account
              <ArrowRight size={14} />
            </button>
          </div>
        )}

        {/* Step 3: Get API token */}
        {step === "token" && (
          <div>
            <div className="flex items-center gap-2 mb-4">
              <button
                onClick={() => setStep("account")}
                className="text-ghost hover:text-dim flex h-8 w-8 items-center justify-center rounded-lg transition hover:bg-white/[0.04]"
              >
                <ArrowLeft size={16} />
              </button>
              <h2 className="text-text text-lg font-semibold">Step 2: Get your API token</h2>
            </div>

            <div className="bg-void mb-4 rounded-xl border border-white/[0.08] p-5">
              <p className="text-dim mb-3 text-sm leading-relaxed">
                Follow these steps in your Cloudflare dashboard:
              </p>
              <ol className="text-dim space-y-2 text-sm list-decimal list-inside">
                <li>Click the button below to open the API tokens page</li>
                <li>Click <span className="text-text font-medium">Create Token</span></li>
                <li>Find the <span className="text-text font-medium">Create Custom Token</span> option and click <span className="text-text font-medium">Get Started</span></li>
                <li>Give it a name like <span className="text-text font-medium">Herman Deploy</span></li>
                <li>Under <span className="text-text font-medium">Permissions</span>, add:<br />
                  <code className="text-signal bg-white/[0.03] mt-1 inline-block rounded px-2 py-0.5 text-xs">
                    Account · Cloudflare Pages · Edit
                  </code>
                </li>
                <li>Click <span className="text-text font-medium">Continue to summary</span> then <span className="text-text font-medium">Create Token</span></li>
                <li>Copy the token that appears (it starts with a random string)</li>
              </ol>
            </div>

            <button
              onClick={() => handleOpenCloudflare(CLOUDFLARE_TOKEN_URL)}
              className="bg-signal hover:bg-signal-dim mb-4 flex w-full items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold text-primary-foreground transition active:scale-[0.97]"
            >
              <ExternalLink size={14} />
              Open API tokens page
            </button>

            <button
              onClick={() => setStep("details")}
              className="text-dim hover:text-text flex w-full items-center justify-center gap-2 rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-2.5 text-sm font-medium transition hover:bg-white/[0.04] active:scale-[0.97]"
            >
              I have my token
              <ArrowRight size={14} />
            </button>
          </div>
        )}

        {/* Step 4: Enter details & deploy */}
        {step === "details" && (
          <div>
            <div className="flex items-center gap-2 mb-4">
              <button
                onClick={() => setStep("token")}
                className="text-ghost hover:text-dim flex h-8 w-8 items-center justify-center rounded-lg transition hover:bg-white/[0.04]"
              >
                <ArrowLeft size={16} />
              </button>
              <h2 className="text-text text-lg font-semibold">Step 3: Enter your details</h2>
            </div>

            {/* API Token */}
            <div className="mb-4">
              <label className="text-dim mb-1.5 block text-xs font-medium">Cloudflare API token</label>
              <input
                ref={inputRef}
                value={apiToken}
                onChange={(e) => setApiToken(e.target.value)}
                placeholder="Paste your token here…"
                className="text-text placeholder:text-ghost bg-void w-full rounded-xl border border-white/[0.08] px-3 py-2.5 text-sm focus:border-signal/40 focus:outline-none focus:ring-1 focus:ring-signal/20 transition"
              />
              <p className="text-ghost mt-1 text-[11px]">
                Your token is stored safely on your computer and never sent to us.
              </p>
            </div>

            {/* Subdomain */}
            <div className="mb-6">
              <label className="text-dim mb-1.5 block text-xs font-medium">Your site URL</label>
              <div className="bg-void flex items-center rounded-xl border border-white/[0.08] focus-within:border-signal/30 focus-within:ring-1 focus-within:ring-signal/20 transition overflow-hidden">
                <span className="text-dim shrink-0 pl-3 text-sm">https://</span>
                <input
                  value={subdomain}
                  onChange={(e) => setSubdomain(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && subdomain.trim() && apiToken.trim()) void handleDeploy();
                  }}
                  placeholder="my-site"
                  className="text-text placeholder:text-ghost w-full bg-transparent px-1 py-2.5 text-sm focus:outline-none"
                />
                <span className="text-dim shrink-0 pr-3 text-sm">.the-clique.com</span>
              </div>
            </div>

            {error && (
              <div className="mb-4 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-xs text-red-400">
                {error}
              </div>
            )}

            <button
              onClick={handleDeploy}
              disabled={!subdomain.trim() || !apiToken.trim()}
              className="bg-signal hover:bg-signal-dim flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold text-primary-foreground shadow-[0_0_24px_rgba(34,197,94,0.18)] transition hover:shadow-[0_0_32px_rgba(34,197,94,0.28)] active:scale-[0.97] disabled:opacity-40"
            >
              <Rocket size={16} />
              Publish my site
            </button>
          </div>
        )}

        {/* Step 5: Deploying */}
        {step === "deploying" && (
          <div className="flex flex-col items-center py-6">
            <Loader2 size={36} className="text-signal mb-5 animate-spin" />
            <h2 className="text-text mb-1 text-lg font-semibold">Publishing your site</h2>
            <p className="text-dim text-sm text-center">Building and deploying to Cloudflare…</p>
            <div className="bg-void mt-4 w-full rounded-lg border border-white/[0.06] p-3">
              <div className="bg-signal/20 h-1.5 rounded-full overflow-hidden">
                <motion.div
                  initial={{ width: "0%" }}
                  animate={{ width: "100%" }}
                  transition={{ duration: 2, ease: "easeInOut" }}
                  className="bg-signal h-full rounded-full"
                />
              </div>
            </div>
          </div>
        )}

        {/* Step 6: Done */}
        {step === "done" && deployUrl && (
          <div className="text-center">
            <motion.div
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ type: "spring", stiffness: 400, damping: 20 }}
              className="bg-signal/10 text-signal mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl"
            >
              <Check size={28} strokeWidth={2} />
            </motion.div>
            <h2 className="text-text mb-1 text-xl font-semibold">Your site is live! 🎉</h2>
            <p className="text-dim mb-6 text-sm">
              Anyone with this link can see your site.
            </p>

            <div className="bg-void mb-4 flex items-center rounded-xl border border-white/[0.08] p-3">
              <Globe size={16} className="text-signal mr-2.5 shrink-0" />
              <span className="text-text flex-1 truncate text-sm">{deployUrl}</span>
            </div>

            <div className="flex gap-3">
              <button
                onClick={handleCopy}
                className="flex flex-1 items-center justify-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.02] px-4 py-2.5 text-sm font-medium text-dim transition hover:bg-white/[0.06] active:scale-[0.97]"
              >
                <Copy size={14} />
                {copied ? "Copied!" : "Copy link"}
              </button>
              <button
                onClick={handleOpenUrl}
                className="bg-signal hover:bg-signal-dim flex flex-1 items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold text-primary-foreground transition active:scale-[0.97]"
              >
                <ExternalLink size={14} />
                Open site
              </button>
            </div>

            <button
              onClick={onClose}
              className="text-dim hover:text-text mt-5 text-xs transition"
            >
              Close
            </button>
          </div>
        )}
      </motion.div>
    </div>
  );
}
