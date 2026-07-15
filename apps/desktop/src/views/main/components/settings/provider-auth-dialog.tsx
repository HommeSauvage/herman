import { Button } from "@herman/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@herman/ui/components/dialog";
import { Input } from "@herman/ui/components/input";
import { Label } from "@herman/ui/components/label";
import { getLogger } from "@logtape/logtape";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import type { AuthMethod, ProviderMetadata } from "../../../../shared/rpc.js";
import { useAgentStore } from "../../lib/agent-store.js";
import { desktopRpc } from "../../lib/desktop-rpc.js";

const logger = getLogger(["herman-desktop", "view", "provider-auth"]);

type ProviderAuthDialogProps = {
  provider: ProviderMetadata;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function ProviderAuthDialog({ provider, open, onOpenChange }: ProviderAuthDialogProps) {
  const settings = useAgentStore((s) => s.settings);
  const setSettings = useAgentStore((s) => s.setSettings);
  const [selectedMethod, setSelectedMethod] = useState<AuthMethod | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [promptInputs, setPromptInputs] = useState<Record<string, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [oauthState, setOauthState] = useState<{
    state: string;
    authUrl: string;
    status: "idle" | "waiting" | "error";
    error?: string;
  } | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const oauthStateRef = useRef(oauthState);
  oauthStateRef.current = oauthState;

  function reset() {
    setSelectedMethod(null);
    setApiKey("");
    setPromptInputs({});
    setIsSubmitting(false);
    setOauthState(null);
    if (pollTimer.current) {
      clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
  }

  function handleClose(open: boolean) {
    if (!open) {
      if (oauthState?.state) {
        void desktopRpc.request.cancelOAuthLogin({ providerId: provider.id });
      }
      reset();
    }
    onOpenChange(open);
  }

  async function handleSubmit() {
    if (!selectedMethod || selectedMethod.type !== "apiKey") return;
    setIsSubmitting(true);

    const prevSettings = settings;
    let credentialSaved = false;
    try {
      await desktopRpc.request.saveProviderCredentials({
        providerId: provider.id,
        credential: { type: "apiKey", key: apiKey, metadata: promptInputs },
        skipRefresh: true,
      });
      credentialSaved = true;

      const next = buildConnectedSettings();
      setSettings(next);
      await desktopRpc.request.saveSettings({ settings: next });
      handleClose(false);
    } catch {
      if (credentialSaved) {
        await desktopRpc.request
          .removeProviderCredentials({ providerId: provider.id })
          .catch((error) => {
            logger.warning("Failed to roll back provider credentials", {
              providerId: provider.id,
              error: error instanceof Error ? error.message : String(error),
            });
          });
      }
      setSettings(prevSettings);
      toast.error("Failed to save provider credentials.");
    } finally {
      setIsSubmitting(false);
    }
  }

  const buildConnectedSettings = useCallback(() => {
    return {
      ...settings,
      credentialStoreError: undefined,
      providers: {
        ...settings.providers,
        custom: {
          ...settings.providers.custom,
          [provider.id]: {
            enabled: true,
            authMethod: selectedMethod?.type,
            options: promptInputs,
          },
        },
      },
    };
  }, [provider.id, promptInputs, selectedMethod?.type, settings]);

  async function handleDisconnect() {
    const prevSettings = settings;
    const next = {
      ...settings,
      providers: {
        ...settings.providers,
        custom: {
          ...settings.providers.custom,
          [provider.id]: {
            enabled: false,
            authMethod: undefined,
            options: undefined,
          },
        },
      },
    };
    setSettings(next);
    try {
      await desktopRpc.request.saveSettings({ settings: next });
      await desktopRpc.request.removeProviderCredentials({ providerId: provider.id, skipRefresh: true });
      handleClose(false);
    } catch {
      setSettings(prevSettings);
      toast.error("Failed to disconnect provider.");
    }
  }

  async function selectOAuthMethod(method: AuthMethod) {
    setSelectedMethod(method);
    setOauthState({ state: "", authUrl: "", status: "idle" });
    try {
      const { authUrl, state } = await desktopRpc.request.startOAuthLogin({
        providerId: provider.id,
      });
      setOauthState({ state, authUrl, status: "waiting" });
      await desktopRpc.request.openExternal({ url: authUrl });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start OAuth login.";
      setOauthState({ state: "", authUrl: "", status: "error", error: message });
    }
  }

  useEffect(() => {
    if (oauthState?.status !== "waiting") return;

    const poll = async () => {
      try {
        const result = await desktopRpc.request.pollOAuthLogin({
          providerId: provider.id,
          state: oauthState.state,
        });
        if (result.status === "pending") {
          pollTimer.current = setTimeout(poll, 1500);
          return;
        }
        if (result.status === "error") {
          setOauthState((prev) =>
            prev ? { ...prev, status: "error", error: result.error } : null,
          );
          return;
        }
        await desktopRpc.request.saveProviderCredentials({
          providerId: provider.id,
          credential: result.credential,
          skipRefresh: true,
        });
        const next = buildConnectedSettings();
        setSettings(next);
        await desktopRpc.request.saveSettings({ settings: next });
        handleClose(false);
      } catch {
        setOauthState((prev) =>
          prev ? { ...prev, status: "error", error: "Authentication failed." } : null,
        );
      }
    };

    void poll();

    return () => {
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, [oauthState?.status, oauthState?.state, provider.id, buildConnectedSettings]);

  useEffect(() => {
    return () => {
      if (oauthStateRef.current?.state) {
        void desktopRpc.request.cancelOAuthLogin({ providerId: provider.id });
      }
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, [provider.id]);

  const isConnected = settings.providers.custom[provider.id]?.enabled ?? false;

  if (isConnected) {
    return (
      <Dialog open={open} onOpenChange={handleClose}>
        <DialogContent className="bg-surface text-text border-white/[0.06] sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{provider.name}</DialogTitle>
            <DialogDescription className="text-dim">
              This provider is connected. You can disconnect it to remove stored credentials.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => handleClose(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void handleDisconnect()}>
              Disconnect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  if (!selectedMethod) {
    return (
      <Dialog open={open} onOpenChange={handleClose}>
        <DialogContent className="bg-surface text-text border-white/[0.06] sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Connect {provider.name}</DialogTitle>
            <DialogDescription className="text-dim">
              Choose how you want to authenticate.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {provider.authMethods.map((method) => (
              <button
                key={method.type}
                onClick={() =>
                  method.type === "oauth"
                    ? void selectOAuthMethod(method)
                    : setSelectedMethod(method)
                }
                className="w-full rounded-lg border border-white/[0.06] p-3 text-left transition hover:bg-white/[0.04] focus-visible:ring-1 focus-visible:ring-white/20 focus-visible:outline-none"
              >
                <div className="text-text font-medium">{method.label}</div>
                <div className="text-ghost text-xs">
                  {method.type === "oauth" ? "Authorize through your browser" : "Enter an API key"}
                </div>
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="bg-surface text-text border-white/[0.06] sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{selectedMethod.label}</DialogTitle>
          <DialogDescription className="text-dim">
            {selectedMethod.type === "oauth"
              ? "Complete authentication in your browser. Herman will save the token automatically."
              : `Enter your ${provider.name} credentials. They are encrypted and stored locally.`}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {selectedMethod.prompts?.map((prompt) => {
            if (prompt.type === "select") {
              return (
                <div key={prompt.key} className="space-y-1.5">
                  <Label className="text-ghost text-xs">{prompt.label}</Label>
                  <select
                    value={promptInputs[prompt.key] ?? ""}
                    onChange={(e) =>
                      setPromptInputs((prev) => ({ ...prev, [prompt.key]: e.target.value }))
                    }
                    className="bg-void text-text w-full rounded-md border border-white/[0.06] px-3 py-2 text-sm focus:ring-1 focus:ring-white/10 focus:outline-none"
                  >
                    {prompt.options.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
              );
            }
            return (
              <div key={prompt.key} className="space-y-1.5">
                <Label className="text-ghost text-xs">{prompt.label}</Label>
                <Input
                  value={promptInputs[prompt.key] ?? ""}
                  onChange={(e) =>
                    setPromptInputs((prev) => ({ ...prev, [prompt.key]: e.target.value }))
                  }
                  placeholder={prompt.placeholder}
                  className="bg-void text-text placeholder:text-ghost border-white/[0.06]"
                />
              </div>
            );
          })}
          {selectedMethod.type === "apiKey" && (
            <div className="space-y-1.5">
              <Label className="text-ghost text-xs">API key</Label>
              <Input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-..."
                className="bg-void text-text placeholder:text-ghost border-white/[0.06]"
              />
            </div>
          )}
          {selectedMethod.type === "oauth" && (
            <div className="space-y-3">
              {oauthState?.status === "waiting" ? (
                <div className="text-dim text-sm">
                  Waiting for browser authentication…
                  <span className="ml-2 inline-block animate-pulse">●</span>
                </div>
              ) : oauthState?.status === "error" ? (
                <div className="text-sm text-red-400">
                  {oauthState.error || "Authentication failed."}
                </div>
              ) : (
                <div className="text-dim text-sm">Opening browser for authentication…</div>
              )}
              {oauthState?.authUrl && (
                <button
                  type="button"
                  onClick={() => void desktopRpc.request.openExternal({ url: oauthState.authUrl })}
                  className="text-ghost hover:text-text text-xs underline"
                >
                  Open browser again
                </button>
              )}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              if (selectedMethod.type === "oauth" && oauthState?.state) {
                void desktopRpc.request.cancelOAuthLogin({ providerId: provider.id });
                setOauthState(null);
              }
              setSelectedMethod(null);
            }}
          >
            Back
          </Button>
          <Button
            disabled={selectedMethod.type === "oauth" || !apiKey || isSubmitting}
            onClick={() => void handleSubmit()}
          >
            {isSubmitting ? "Saving…" : "Connect"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
