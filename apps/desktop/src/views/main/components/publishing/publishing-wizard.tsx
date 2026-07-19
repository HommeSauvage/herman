import { cn } from "@herman/ui/lib/utils";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  Globe,
  Info,
  Key,
  Loader2,
  Plus,
  Server,
  Shield,
  Terminal,
  Wand2,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { PublishingConfigView } from "../../../../shared/publishing.js";
import { desktopRpc } from "../../lib/desktop-rpc.js";
import { SignalButton } from "../ui/index.js";

// ── Constants ────────────────────────────────────────────────────────────────

const HETZNER_CLOUD_URL = "https://console.hetzner.cloud/";
const COOLIFY_INSTALL_CMD = "curl -fsSL https://cdn.coollabs.io/coolify/install.sh | sudo bash";
const COOLIFY_API_DOCS_URL = "https://coolify.io/docs/api-reference/authorization";

// ── Types ────────────────────────────────────────────────────────────────────

type WizardStep = "intro" | "ssh-key" | "server" | "coolify-install" | "coolify-setup" | "review";

type SshMode = "generate" | "existing" | "paste";

interface SshKeyState {
  mode: SshMode;
  privateKeyPath?: string;
  publicKey: string;
  loading: boolean;
}

interface DiscoveredKey {
  name: string;
  path: string;
  publicKey: string;
}

type InstallState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done"; verified: boolean }
  | { kind: "failed"; error: string };

// ── Step header ──────────────────────────────────────────────────────────────

function StepHeader({
  icon: Icon,
  title,
  subtitle,
}: {
  icon: React.ElementType;
  title: string;
  subtitle: string;
}) {
  return (
    <div className="mb-6 text-center">
      <div className="bg-signal/10 text-signal mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl">
        <Icon size={24} strokeWidth={1.5} />
      </div>
      <h2 className="text-text text-xl font-semibold">{title}</h2>
      <p className="text-dim mt-1.5 text-sm">{subtitle}</p>
    </div>
  );
}

// ── Info box ─────────────────────────────────────────────────────────────────

function InfoBox({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-void mb-4 rounded-xl border border-white/[0.08] p-4">
      <div className="flex items-start gap-3">
        <Info size={16} className="text-signal mt-0.5 shrink-0" />
        <div className="text-dim text-sm leading-relaxed">{children}</div>
      </div>
    </div>
  );
}

// ── Code block ───────────────────────────────────────────────────────────────

function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    void desktopRpc.request.copyToClipboard({ text: code });
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [code]);

  return (
    <div className="bg-void group relative mb-4 rounded-xl border border-white/[0.08] p-4">
      <button
        type="button"
        onClick={handleCopy}
        className="text-ghost hover:text-dim absolute top-3 right-3 flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs transition hover:bg-white/[0.06]"
      >
        {copied ? <Check size={12} className="text-signal" /> : <Copy size={12} />}
        {copied ? "Copied!" : "Copy"}
      </button>
      <pre className="text-text overflow-x-auto pr-16 text-sm whitespace-pre-wrap break-all">
        {code}
      </pre>
    </div>
  );
}

// ── Back / continue row ──────────────────────────────────────────────────────

function StepNav({
  onBack,
  continueLabel = "Continue",
  continueDisabled = false,
  continueLoading = false,
  onContinue,
}: {
  onBack: () => void;
  continueLabel?: string;
  continueDisabled?: boolean;
  continueLoading?: boolean;
  onContinue: () => void;
}) {
  return (
    <div className="flex gap-3">
      <button
        type="button"
        onClick={onBack}
        className="text-dim hover:text-text flex items-center gap-1.5 rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-2.5 text-sm transition hover:bg-white/[0.04]"
      >
        <ArrowLeft size={14} />
        Back
      </button>
      <SignalButton
        size="md"
        className="flex-1"
        disabled={continueDisabled || continueLoading}
        onClick={onContinue}
      >
        {continueLoading ? <Loader2 size={14} className="animate-spin" /> : null}
        {continueLabel}
        {!continueLoading ? <ArrowRight size={14} /> : null}
      </SignalButton>
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

export function PublishingWizard({
  projectPath,
  initialConfig,
  onConfigSaved,
}: {
  projectPath: string;
  /** Existing config when resuming a partial setup or editing. */
  initialConfig?: PublishingConfigView | null;
  onConfigSaved: () => void;
}) {
  const [step, setStep] = useState<WizardStep>("intro");
  const [serverIp, setServerIp] = useState(initialConfig?.serverIp ?? "");
  const [sshKey, setSshKey] = useState<SshKeyState>(() => ({
    mode: initialConfig?.sshPublicKey ? "paste" : "generate",
    publicKey: initialConfig?.sshPublicKey ?? "",
    loading: false,
  }));
  const [discoveredKeys, setDiscoveredKeys] = useState<DiscoveredKey[]>([]);
  const [selectedDiscoveredKey, setSelectedDiscoveredKey] = useState<string>("");
  const [pastedKey, setPastedKey] = useState(initialConfig?.sshPublicKey ?? "");
  const [install, setInstall] = useState<InstallState>({ kind: "idle" });
  const [installLog, setInstallLog] = useState<string[]>([]);
  const [showManualInstall, setShowManualInstall] = useState(false);
  const [coolifyUrl, setCoolifyUrl] = useState(initialConfig?.coolifyUrl ?? "");
  const [coolifyToken, setCoolifyToken] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const logRef = useRef<HTMLDivElement>(null);

  const hasSavedToken = Boolean(initialConfig?.hasApiToken);

  // Focus the first input when the step changes.
  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 100);
  }, [step]);

  // Load discovered keys when entering ssh-key step.
  useEffect(() => {
    if (step === "ssh-key") {
      desktopRpc.request
        .discoverSshKeys()
        .then((result) => setDiscoveredKeys(result.keys))
        .catch(() => setDiscoveredKeys([]));
    }
  }, [step]);

  // Subscribe to install progress lines while installing.
  useEffect(() => {
    const handleProgress = (payload: { projectPath: string; line: string }) => {
      if (payload.projectPath !== projectPath) return;
      setInstallLog((prev) => [...prev.slice(-199), payload.line]);
    };
    desktopRpc.addMessageListener("publishingInstallProgress", handleProgress);
    return () => {
      desktopRpc.removeMessageListener("publishingInstallProgress", handleProgress);
    };
  }, [projectPath]);

  // Auto-scroll the install log.
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [installLog]);

  // ── Handlers ────────────────────────────────────────────────────────────

  const savePartial = useCallback(
    async (update: Parameters<typeof desktopRpc.request.savePublishingConfig>[0]["update"]) => {
      await desktopRpc.request.savePublishingConfig({ projectPath, update });
    },
    [projectPath],
  );

  const handleGenerateKey = useCallback(async () => {
    setSshKey((prev) => ({ ...prev, loading: true, mode: "generate" }));
    setError(null);
    try {
      const result = await desktopRpc.request.generatePublishingSshKey({});
      setSshKey({
        mode: "generate",
        privateKeyPath: result.privateKeyPath,
        publicKey: result.publicKey,
        loading: false,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate SSH key");
      setSshKey((prev) => ({ ...prev, loading: false }));
    }
  }, []);

  const handleContinueFromSshKey = useCallback(async () => {
    setIsSaving(true);
    setError(null);
    try {
      // Paste mode means Herman has no private key for this public key —
      // clear any previously stored key path so it can't go stale.
      await savePartial({
        sshPublicKey: sshKey.publicKey,
        sshKeyPath: sshKey.privateKeyPath ?? null,
      });
      setStep("server");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setIsSaving(false);
    }
  }, [savePartial, sshKey]);

  const handleContinueFromServer = useCallback(async () => {
    setIsSaving(true);
    setError(null);
    try {
      await savePartial({ serverIp: serverIp.trim(), status: "server_ready" });
      setStep("coolify-install");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setIsSaving(false);
    }
  }, [savePartial, serverIp]);

  const handleInstall = useCallback(async () => {
    setInstall({ kind: "running" });
    setInstallLog([]);
    setError(null);
    try {
      const result = await desktopRpc.request.installCoolify({ projectPath });
      if (result.ok) {
        setInstall({ kind: "done", verified: Boolean(result.verified) });
        if (result.coolifyUrl) {
          setCoolifyUrl((prev) => prev || (result.coolifyUrl as string));
        }
      } else {
        setInstall({ kind: "failed", error: result.error ?? "Install failed" });
      }
    } catch (err) {
      setInstall({
        kind: "failed",
        error: err instanceof Error ? err.message : "Install failed",
      });
    }
  }, [projectPath]);

  const handleFinish = useCallback(async () => {
    setIsSaving(true);
    setError(null);
    try {
      const url = coolifyUrl.trim();
      const token = coolifyToken.trim();
      await savePartial({
        coolifyUrl: url,
        // Only send a token when the user typed one — otherwise keep the
        // previously saved token (absent = unchanged).
        ...(token ? { coolifyApiToken: token } : {}),
        status: url && (token || hasSavedToken) ? "coolify_installed" : "server_ready",
      });
      onConfigSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save publishing config");
    } finally {
      setIsSaving(false);
    }
  }, [savePartial, coolifyUrl, coolifyToken, hasSavedToken, onConfigSaved]);

  const handleOpenExternal = useCallback((url: string) => {
    void desktopRpc.request.openExternal({ url });
  }, []);

  const canContinueToReview =
    Boolean(coolifyUrl.trim()) && Boolean(coolifyToken.trim() || hasSavedToken);

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <div>
      <AnimatePresence mode="wait">
        {/* Step 1: Intro */}
        {step === "intro" && (
          <motion.div
            key="intro"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
          >
            <StepHeader
              icon={Globe}
              title="Publish your project"
              subtitle="We'll walk you through deploying your site on your own server with Coolify. Takes about 10 minutes."
            />

            <InfoBox>
              Your project needs a home on the internet before people can visit it. We use{" "}
              <strong>Coolify</strong> (a free, open-source platform) running on a cheap cloud
              server to host your site affordably. You stay in full control — no vendor lock-in.
            </InfoBox>

            <div className="space-y-3 mb-6">
              <StepCard num={1} title="Set up SSH access" done={false}>
                Generate a secure key so Herman can connect to your server — no terminal needed, we
                create it for you.
              </StepCard>
              <StepCard num={2} title="Get a server" done={false}>
                Rent a cheap cloud server. We recommend Hetzner (from ~€4/month) — you'll paste your
                new key in while creating it, and we'll show you exactly where.
              </StepCard>
              <StepCard num={3} title="Herman installs Coolify" done={false}>
                Herman connects to your server and installs Coolify for you. You just watch it
                happen.
              </StepCard>
              <StepCard num={4} title="Connect & deploy" done={false}>
                Link Coolify to Herman with an API token. Then Herman takes over to deploy your
                project.
              </StepCard>
            </div>

            <SignalButton size="lg" fullWidth glow onClick={() => setStep("ssh-key")}>
              Let's get started
              <ArrowRight size={16} />
            </SignalButton>
          </motion.div>
        )}

        {/* Step 2: SSH Key (FIRST — the key must exist before creating the server) */}
        {step === "ssh-key" && (
          <motion.div
            key="ssh-key"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
          >
            <StepHeader
              icon={Key}
              title="Step 1: Set up SSH access"
              subtitle="Generate a key so Herman can connect to your server."
            />

            <InfoBox>
              <p className="mb-2">
                SSH keys let Herman securely connect to your server without a password. We'll
                generate one for you (or you can use an existing key).
              </p>
              <p>
                <strong>Why now?</strong> In the next step you'll create your server, and the server
                provider asks for this key <em>during creation</em>. Having it ready first means
                Herman can connect right away.
              </p>
            </InfoBox>

            {/* Mode selector */}
            <div className="bg-void mb-4 flex rounded-xl border border-white/[0.08] p-1">
              {(["generate", "existing", "paste"] as const).map((mode) => (
                <button
                  type="button"
                  key={mode}
                  onClick={() => setSshKey((prev) => ({ ...prev, mode }))}
                  className={cn(
                    "flex-1 rounded-lg px-3 py-2 text-xs font-medium transition",
                    sshKey.mode === mode
                      ? "bg-white/[0.08] text-text"
                      : "text-ghost hover:text-dim",
                  )}
                >
                  {mode === "generate"
                    ? "Generate new"
                    : mode === "existing"
                      ? "Use existing"
                      : "Paste key"}
                </button>
              ))}
            </div>

            {/* Generate mode */}
            {sshKey.mode === "generate" && (
              <div className="mb-4">
                {sshKey.publicKey ? (
                  <CodeBlock code={sshKey.publicKey} />
                ) : (
                  <button
                    type="button"
                    onClick={handleGenerateKey}
                    disabled={sshKey.loading}
                    className="bg-signal hover:bg-signal-dim flex w-full items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold text-primary-foreground transition active:scale-[0.97] disabled:opacity-50"
                  >
                    {sshKey.loading ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <Plus size={14} />
                    )}
                    Generate SSH key
                  </button>
                )}
                {sshKey.publicKey && (
                  <p className="text-ghost mt-2 text-[11px]">
                    This is your <strong>public key</strong> — it's safe to share. Keep it handy:
                    you'll paste it into your server provider in the next step.
                  </p>
                )}
              </div>
            )}

            {/* Existing mode */}
            {sshKey.mode === "existing" && (
              <div className="mb-4">
                {discoveredKeys.length === 0 ? (
                  <p className="text-dim text-sm text-center py-4">
                    No SSH keys found in ~/.ssh. Generate a new one or paste one manually.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {discoveredKeys.map((key) => (
                      <button
                        type="button"
                        key={key.name}
                        onClick={() => {
                          setSelectedDiscoveredKey(key.name);
                          setSshKey((prev) => ({
                            ...prev,
                            publicKey: key.publicKey,
                            privateKeyPath: key.path,
                          }));
                        }}
                        className={cn(
                          "bg-void w-full rounded-xl border px-4 py-3 text-left transition",
                          selectedDiscoveredKey === key.name
                            ? "border-signal/40 bg-signal/[0.04]"
                            : "border-white/[0.08] hover:border-white/[0.14]",
                        )}
                      >
                        <div className="text-text text-sm font-medium">{key.name}</div>
                        <div className="text-ghost mt-0.5 truncate text-[11px] font-mono">
                          {key.publicKey.slice(0, 60)}…
                        </div>
                      </button>
                    ))}
                  </div>
                )}
                {sshKey.publicKey && (
                  <p className="text-ghost mt-2 text-[11px]">
                    Using key <code className="text-dim">{selectedDiscoveredKey}</code>. Make sure
                    this public key is the one you add to your server in the next step.
                  </p>
                )}
              </div>
            )}

            {/* Paste mode */}
            {sshKey.mode === "paste" && (
              <div className="mb-4">
                <textarea
                  value={pastedKey}
                  onChange={(e) => {
                    setPastedKey(e.target.value);
                    setSshKey((prev) => ({
                      ...prev,
                      publicKey: e.target.value.trim(),
                      privateKeyPath: undefined,
                    }));
                  }}
                  placeholder="Paste your public key here (starts with ssh-ed25519 or ssh-rsa)…"
                  rows={4}
                  className="text-text placeholder:text-ghost bg-void w-full resize-none rounded-xl border border-white/[0.08] px-3 py-2.5 text-sm font-mono focus:border-signal/40 focus:outline-none focus:ring-1 focus:ring-signal/20 transition"
                />
                <p className="text-ghost mt-2 text-[11px]">
                  Note: with a pasted public key, Herman can't connect to the server for you (the
                  matching private key stays with you) — you'd install Coolify manually in step 3.
                </p>
              </div>
            )}

            {error && (
              <div className="mb-4 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-xs text-red-400">
                {error}
              </div>
            )}

            <StepNav
              onBack={() => setStep("intro")}
              continueDisabled={!sshKey.publicKey}
              continueLoading={isSaving}
              onContinue={handleContinueFromSshKey}
            />
          </motion.div>
        )}

        {/* Step 3: Server (AFTER the key — paste it during server creation) */}
        {step === "server" && (
          <motion.div
            key="server"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
          >
            <StepHeader
              icon={Server}
              title="Step 2: Get a server"
              subtitle="Rent a cloud server and enter its IP address."
            />

            <InfoBox>
              <p className="mb-2">
                You need a cloud server to host your site. We recommend <strong>Hetzner</strong> —
                reliable, affordable, and easy to set up. Their cheapest plan (~€4/month) is plenty
                for most projects.
              </p>
              <p>
                <strong>Important:</strong> while creating the server, Hetzner shows an{" "}
                <strong>"SSH Keys"</strong> section — click <em>Add SSH Key</em> and paste the
                public key from the previous step. A server created without it can't be reached by
                Herman.
              </p>
            </InfoBox>

            {sshKey.publicKey ? (
              <div className="mb-4">
                <p className="text-dim mb-1.5 block text-xs font-medium">
                  Your public key — paste this into Hetzner's "SSH Keys" section
                </p>
                <CodeBlock code={sshKey.publicKey} />
              </div>
            ) : null}

            <button
              type="button"
              onClick={() => handleOpenExternal(HETZNER_CLOUD_URL)}
              className="bg-signal hover:bg-signal-dim mb-4 flex w-full items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold text-primary-foreground transition active:scale-[0.97]"
            >
              <ExternalLink size={14} />
              Open Hetzner Cloud
            </button>

            <div className="mb-6">
              <label htmlFor="server-ip" className="text-dim mb-1.5 block text-xs font-medium">
                Server IP address
              </label>
              <input
                id="server-ip"
                ref={inputRef}
                value={serverIp}
                onChange={(e) => setServerIp(e.target.value)}
                placeholder="e.g. 142.93.123.45"
                className="text-text placeholder:text-ghost bg-void w-full rounded-xl border border-white/[0.08] px-3 py-2.5 text-sm focus:border-signal/40 focus:outline-none focus:ring-1 focus:ring-signal/20 transition"
              />
              <p className="text-ghost mt-1 text-[11px]">
                Once the server is created, Hetzner shows its IP address in the server details. Wait
                until the server status is "Running" before continuing.
              </p>
            </div>

            {error && (
              <div className="mb-4 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-xs text-red-400">
                {error}
              </div>
            )}

            <StepNav
              onBack={() => setStep("ssh-key")}
              continueDisabled={!serverIp.trim()}
              continueLoading={isSaving}
              onContinue={handleContinueFromServer}
            />
          </motion.div>
        )}

        {/* Step 4: Herman installs Coolify */}
        {step === "coolify-install" && (
          <motion.div
            key="coolify-install"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
          >
            <StepHeader
              icon={Terminal}
              title="Step 3: Install Coolify"
              subtitle="Herman connects to your server and installs Coolify for you."
            />

            <InfoBox>
              Coolify is a free platform that manages deployments, SSL certificates, and environment
              variables on your server — like having your own Vercel. Installing it takes one
              command; Herman runs it over SSH so you don't need a terminal.
            </InfoBox>

            {/* Idle: offer the auto install */}
            {install.kind === "idle" && (
              <>
                <SignalButton size="lg" fullWidth glow onClick={handleInstall}>
                  <Wand2 size={16} />
                  Install Coolify for me
                </SignalButton>

                <button
                  type="button"
                  onClick={() => setShowManualInstall((v) => !v)}
                  className="text-ghost hover:text-dim mt-4 flex w-full items-center justify-center gap-1.5 text-xs transition"
                >
                  <ChevronDown
                    size={12}
                    className={cn("transition", showManualInstall && "rotate-180")}
                  />
                  Prefer to run it yourself?
                </button>

                {showManualInstall && (
                  <div className="mt-3">
                    <ol className="text-dim space-y-1.5 mb-3 text-sm list-decimal list-inside">
                      <li>
                        SSH into your server:{" "}
                        <code className="text-text bg-white/[0.04] rounded px-1.5 py-0.5 text-xs">
                          ssh root@{serverIp || "<your-server-ip>"}
                        </code>
                      </li>
                      <li>Run the command below</li>
                      <li>Wait 2-3 minutes for the installation to finish</li>
                    </ol>
                    <CodeBlock code={COOLIFY_INSTALL_CMD} />
                  </div>
                )}
              </>
            )}

            {/* Running / done / failed: show the live log */}
            {install.kind !== "idle" && (
              <div
                ref={logRef}
                className="bg-void mb-4 max-h-56 overflow-y-auto rounded-xl border border-white/[0.08] p-4"
              >
                {installLog.length === 0 ? (
                  <p className="text-ghost text-xs font-mono">Starting…</p>
                ) : (
                  <pre className="text-dim text-xs font-mono whitespace-pre-wrap break-all">
                    {installLog.join("\n")}
                  </pre>
                )}
              </div>
            )}

            {install.kind === "running" && (
              <div className="text-dim mb-4 flex items-center justify-center gap-2 text-sm">
                <Loader2 size={14} className="text-signal animate-spin" />
                Installing Coolify — this takes 2-3 minutes…
              </div>
            )}

            {install.kind === "done" && (
              <div className="mb-4 rounded-xl border border-signal/20 bg-signal/[0.06] px-4 py-3">
                <div className="text-signal flex items-center gap-2 text-sm font-medium">
                  <Check size={14} />
                  Coolify is installed
                </div>
                <p className="text-dim mt-1 text-xs">
                  {install.verified
                    ? "The dashboard is up and answering requests."
                    : "The installer finished. The dashboard may take another minute to come up."}
                </p>
              </div>
            )}

            {install.kind === "failed" && (
              <div className="mb-4 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3">
                <p className="text-xs text-red-400">{install.error}</p>
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    onClick={handleInstall}
                    className="text-dim hover:text-text rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-1.5 text-xs transition"
                  >
                    Retry
                  </button>
                  <button
                    type="button"
                    onClick={() => setShowManualInstall((v) => !v)}
                    className="text-ghost hover:text-dim rounded-lg px-3 py-1.5 text-xs transition"
                  >
                    Show manual steps
                  </button>
                </div>
                {showManualInstall && (
                  <div className="mt-3">
                    <CodeBlock code={COOLIFY_INSTALL_CMD} />
                  </div>
                )}
              </div>
            )}

            <StepNav
              onBack={() => setStep("server")}
              continueLabel={
                install.kind === "done" ? "Continue" : "Skip — Coolify is already installed"
              }
              continueDisabled={install.kind === "running"}
              onContinue={() => setStep("coolify-setup")}
            />
          </motion.div>
        )}

        {/* Step 5: Coolify URL + API token */}
        {step === "coolify-setup" && (
          <motion.div
            key="coolify-setup"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
          >
            <StepHeader
              icon={Shield}
              title="Step 4: Connect Coolify"
              subtitle="Create an API token so Herman can deploy your project."
            />

            <InfoBox>
              <p className="mb-2">
                Coolify has a web dashboard where you manage your projects. Herman needs an API
                token to create projects, configure domains, and deploy your site automatically.
              </p>
              <ol className="text-dim space-y-1 text-sm list-decimal list-inside">
                <li>
                  Open your Coolify dashboard at{" "}
                  <code className="text-text bg-white/[0.04] rounded px-1.5 py-0.5 text-xs">
                    {coolifyUrl || `http://${serverIp || "<ip>"}:8000`}
                  </code>
                </li>
                <li>Create your admin account on first visit</li>
                <li>
                  Go to <span className="text-text font-medium">Settings → API</span> and click{" "}
                  <span className="text-text font-medium">Create New Token</span>
                </li>
                <li>
                  Name it "Herman", give it{" "}
                  <span className="text-text font-medium">read + write + deploy</span> permissions,
                  and copy the token
                </li>
              </ol>
            </InfoBox>

            <button
              type="button"
              onClick={() => handleOpenExternal(COOLIFY_API_DOCS_URL)}
              className="bg-signal hover:bg-signal-dim mb-4 flex w-full items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold text-primary-foreground transition active:scale-[0.97]"
            >
              <ExternalLink size={14} />
              Open Coolify API docs
            </button>

            <div className="mb-4">
              <label htmlFor="coolify-url" className="text-dim mb-1.5 block text-xs font-medium">
                Coolify dashboard URL
              </label>
              <input
                id="coolify-url"
                ref={inputRef}
                value={coolifyUrl}
                onChange={(e) => setCoolifyUrl(e.target.value)}
                placeholder={`http://${serverIp || "your-server-ip"}:8000`}
                className="text-text placeholder:text-ghost bg-void w-full rounded-xl border border-white/[0.08] px-3 py-2.5 text-sm focus:border-signal/40 focus:outline-none focus:ring-1 focus:ring-signal/20 transition"
              />
            </div>

            <div className="mb-6">
              <label htmlFor="coolify-token" className="text-dim mb-1.5 block text-xs font-medium">
                Coolify API token
              </label>
              <input
                id="coolify-token"
                value={coolifyToken}
                onChange={(e) => setCoolifyToken(e.target.value)}
                type="password"
                placeholder={
                  hasSavedToken ? "Already saved — leave blank to keep it" : "Paste your API token…"
                }
                className="text-text placeholder:text-ghost bg-void w-full rounded-xl border border-white/[0.08] px-3 py-2.5 text-sm focus:border-signal/40 focus:outline-none focus:ring-1 focus:ring-signal/20 transition"
              />
              <p className="text-ghost mt-1 text-[11px]">
                Your token is stored encrypted on your computer and never sent anywhere else.
              </p>
            </div>

            {error && (
              <div className="mb-4 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-xs text-red-400">
                {error}
              </div>
            )}

            <StepNav
              onBack={() => setStep("coolify-install")}
              continueDisabled={!canContinueToReview}
              onContinue={() => setStep("review")}
            />
          </motion.div>
        )}

        {/* Step 6: Review & save */}
        {step === "review" && (
          <motion.div
            key="review"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
          >
            <StepHeader
              icon={Check}
              title="Ready to go"
              subtitle="Here's what we'll save. You can change this anytime."
            />

            <div className="bg-void mb-6 space-y-3 rounded-xl border border-white/[0.08] p-4">
              <ReviewRow label="Server IP" value={serverIp} />
              <ReviewRow
                label="SSH Key"
                value={sshKey.publicKey ? `${sshKey.publicKey.slice(0, 40)}…` : "—"}
              />
              <ReviewRow label="Coolify URL" value={coolifyUrl} />
              <ReviewRow
                label="API Token"
                value={coolifyToken.trim() || hasSavedToken ? "••••••••" : "—"}
              />
            </div>

            <InfoBox>
              <p>
                Next, ask Herman to deploy your project. The agent will use your Coolify credentials
                to create a project, configure the app, set environment variables, and assign a
                domain — all automatically. Just say <strong>"Deploy my project"</strong> in a
                session.
              </p>
            </InfoBox>

            {error && (
              <div className="mb-4 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-xs text-red-400">
                {error}
              </div>
            )}

            <StepNav
              onBack={() => setStep("coolify-setup")}
              continueLabel={isSaving ? "Saving…" : "Save & finish"}
              continueDisabled={!canContinueToReview}
              continueLoading={isSaving}
              onContinue={handleFinish}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function StepCard({
  num,
  title,
  done,
  children,
}: {
  num: number;
  title: string;
  done: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "bg-void flex items-start gap-3 rounded-xl border p-4 transition",
        done ? "border-signal/20" : "border-white/[0.06]",
      )}
    >
      <div
        className={cn(
          "mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold",
          done ? "bg-signal/20 text-signal" : "bg-signal/10 text-signal",
        )}
      >
        {done ? <Check size={12} strokeWidth={3} /> : num}
      </div>
      <div>
        <div className="text-text text-sm font-medium">{title}</div>
        <div className="text-dim mt-0.5 text-xs">{children}</div>
      </div>
    </div>
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-dim shrink-0 text-xs">{label}</span>
      <span className="text-text truncate text-right text-sm font-mono">{value || "—"}</span>
    </div>
  );
}
