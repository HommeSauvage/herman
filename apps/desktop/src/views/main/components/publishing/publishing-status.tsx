import { cn } from "@herman/ui/lib/utils";
import {
  AlertCircle,
  Check,
  ExternalLink,
  Globe,
  Loader2,
  Pencil,
  Rocket,
  Server,
  Shield,
  Trash2,
} from "lucide-react";
import { motion } from "motion/react";
import { useCallback, useState } from "react";

import type { PublishingConfigView } from "../../../../shared/publishing.js";
import { desktopRpc } from "../../lib/desktop-rpc.js";
import { SignalButton } from "../ui/index.js";

const STATUS_LABELS: Record<string, { label: string; icon: React.ElementType }> = {
  none: { label: "Setup started", icon: AlertCircle },
  server_ready: { label: "Server connected", icon: Server },
  coolify_installed: { label: "Coolify connected", icon: Shield },
  project_created: { label: "Project created", icon: Check },
  deployed: { label: "Deployed", icon: Globe },
};

function StatusBadge({ status }: { status: string }) {
  const info = STATUS_LABELS[status] ?? STATUS_LABELS.none;
  const Icon = info.icon;
  const isLive = status === "deployed";

  return (
    <div
      className={cn(
        "flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium",
        isLive
          ? "bg-signal/10 text-signal border border-signal/20"
          : "bg-white/[0.04] text-dim border border-white/[0.06]",
      )}
    >
      <Icon size={12} className={isLive ? "text-signal" : undefined} />
      {info.label}
    </div>
  );
}

function ConfigRow({
  label,
  value,
  mono = true,
  secret = false,
}: {
  label: string;
  value?: string;
  mono?: boolean;
  secret?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-3 py-2.5">
      <span className="text-dim shrink-0 text-xs pt-0.5">{label}</span>
      <span
        className={cn(
          "text-text text-right text-sm break-all",
          mono && value && !secret && "font-mono",
          !value && "text-ghost italic",
        )}
      >
        {secret ? "••••••••" : value || "Not set"}
      </span>
    </div>
  );
}

export function PublishingStatus({
  projectPath,
  config,
  onConfigDeleted,
  onEdit,
  onDeploy,
}: {
  projectPath: string;
  config: PublishingConfigView;
  onConfigDeleted: () => void;
  onEdit: () => void;
  onDeploy: () => void;
}) {
  const [isDeleting, setIsDeleting] = useState(false);
  const [showConfirmDelete, setShowConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDelete = useCallback(async () => {
    setIsDeleting(true);
    setError(null);
    try {
      await desktopRpc.request.deletePublishingConfig({ projectPath });
      onConfigDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete config");
      setIsDeleting(false);
      setShowConfirmDelete(false);
    }
  }, [projectPath, onConfigDeleted]);

  const handleOpenUrl = useCallback((url: string) => {
    void desktopRpc.request.openExternal({ url });
  }, []);

  const liveUrl = config.domain
    ? config.domain.startsWith("http")
      ? config.domain
      : `https://${config.domain}`
    : undefined;

  return (
    <div>
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
        <div className="mb-6 text-center">
          <div
            className={cn(
              "mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl",
              config.status === "deployed"
                ? "bg-signal/10 text-signal"
                : "bg-white/[0.04] text-dim",
            )}
          >
            <Globe size={24} strokeWidth={1.5} />
          </div>
          <div className="flex items-center justify-center gap-3">
            <h2 className="text-text text-xl font-semibold">Publishing</h2>
            <StatusBadge status={config.status} />
          </div>
          <p className="text-dim mt-1.5 text-sm">
            {config.status === "deployed"
              ? `Your project is live${config.domain ? ` at ${config.domain}` : ""}`
              : "Your publishing setup is ready. Ask Herman to deploy your project."}
          </p>
        </div>

        {/* Server section */}
        <div className="bg-void mb-4 rounded-xl border border-white/[0.08]">
          <div className="flex items-center gap-2 border-b border-white/[0.06] px-4 py-3">
            <Server size={14} className="text-signal" />
            <span className="text-text text-sm font-medium">Server</span>
          </div>
          <div className="px-4 py-1">
            <ConfigRow label="IP address" value={config.serverIp} />
            <ConfigRow
              label="SSH key"
              value={config.hasSshKey ? "Configured" : undefined}
              mono={false}
            />
          </div>
        </div>

        {/* Coolify section */}
        <div className="bg-void mb-4 rounded-xl border border-white/[0.08]">
          <div className="flex items-center gap-2 border-b border-white/[0.06] px-4 py-3">
            <Shield size={14} className="text-signal" />
            <span className="text-text text-sm font-medium">Coolify</span>
          </div>
          <div className="px-4 py-1">
            <ConfigRow label="Dashboard URL" value={config.coolifyUrl} />
            <ConfigRow
              label="API token"
              value={config.hasApiToken ? "Configured" : undefined}
              mono={false}
              secret
            />
            <ConfigRow label="Project ID" value={config.coolifyProjectId} />
            <ConfigRow label="Application ID" value={config.coolifyApplicationId} />
          </div>
        </div>

        {/* Domain section */}
        {config.domain && (
          <div className="bg-void mb-4 rounded-xl border border-white/[0.08]">
            <div className="flex items-center gap-2 border-b border-white/[0.06] px-4 py-3">
              <Globe size={14} className="text-signal" />
              <span className="text-text text-sm font-medium">Domain</span>
            </div>
            <div className="px-4 py-1">
              <ConfigRow label="Domain" value={config.domain} />
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="mb-4 space-y-2">
          <SignalButton size="md" fullWidth glow onClick={onDeploy}>
            <Rocket size={14} />
            {config.status === "deployed" ? "Ask Herman to redeploy" : "Ask Herman to deploy"}
          </SignalButton>

          <div className="flex gap-2">
            {config.coolifyUrl && (
              <button
                type="button"
                onClick={() => config.coolifyUrl && handleOpenUrl(config.coolifyUrl)}
                className="text-dim hover:text-text flex flex-1 items-center justify-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.02] px-4 py-2.5 text-sm transition hover:bg-white/[0.04]"
              >
                <ExternalLink size={14} />
                Coolify dashboard
              </button>
            )}
            {liveUrl && (
              <button
                type="button"
                onClick={() => handleOpenUrl(liveUrl)}
                className="text-dim hover:text-text flex flex-1 items-center justify-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.02] px-4 py-2.5 text-sm transition hover:bg-white/[0.04]"
              >
                <Globe size={14} />
                Open site
              </button>
            )}
            <button
              type="button"
              onClick={onEdit}
              className="text-dim hover:text-text flex items-center justify-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.02] px-4 py-2.5 text-sm transition hover:bg-white/[0.04]"
            >
              <Pencil size={14} />
              Edit
            </button>
          </div>
        </div>

        {/* Danger zone */}
        <div className="border-t border-white/[0.06] pt-4">
          {!showConfirmDelete ? (
            <button
              type="button"
              onClick={() => setShowConfirmDelete(true)}
              className="text-ghost hover:text-red-400 flex items-center gap-1.5 text-xs transition mx-auto"
            >
              <Trash2 size={12} />
              Reset publishing setup
            </button>
          ) : (
            <div className="flex flex-col items-center gap-3">
              <p className="text-dim text-xs text-center">
                This removes your publishing configuration. Your server and Coolify setup won't be
                affected.
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setShowConfirmDelete(false)}
                  className="text-dim hover:text-text rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-1.5 text-xs transition"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleDelete}
                  disabled={isDeleting}
                  className="flex items-center gap-1.5 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-1.5 text-xs text-red-400 transition hover:bg-red-500/20 disabled:opacity-50"
                >
                  {isDeleting ? <Loader2 size={12} className="animate-spin" /> : null}
                  Yes, reset
                </button>
              </div>
            </div>
          )}

          {error && (
            <div className="mt-3 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-xs text-red-400 text-center">
              {error}
            </div>
          )}
        </div>
      </motion.div>
    </div>
  );
}
