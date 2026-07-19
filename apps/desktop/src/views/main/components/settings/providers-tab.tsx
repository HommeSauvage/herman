import { Button } from "@herman/ui/components/button";
import { Switch } from "@herman/ui/components/switch";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import type { ProviderMetadata } from "../../../../shared/rpc.js";
import { signOut } from "../../lib/agent-actions.js";
import { useAgentStore } from "../../lib/agent-store.js";
import { desktopRpc } from "../../lib/desktop-rpc.js";
import { ProviderAuthDialog } from "./provider-auth-dialog.js";

export function ProvidersTab() {
  const settings = useAgentStore((s) => s.settings);
  const setSettings = useAgentStore((s) => s.setSettings);
  const [providers, setProviders] = useState<ProviderMetadata[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<ProviderMetadata | null>(null);

  useEffect(() => {
    void desktopRpc.request.getAvailableProviders().then(setProviders);
  }, []);

  async function toggleHerman(enabled: boolean) {
    const prev = settings;
    const next = {
      ...settings,
      providers: {
        ...settings.providers,
        herman: { ...settings.providers.herman, enabled },
      },
    };
    setSettings(next);
    try {
      await desktopRpc.request.saveSettings({ settings: next });
      if (!enabled) {
        await signOut();
      }
    } catch {
      setSettings(prev);
      toast.error("Failed to save provider settings.");
    }
  }

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-text mb-6 text-xl font-semibold">Providers</h1>

      <div className="space-y-3">
        {providers.map((provider) => {
          const isHerman = provider.isHerman;
          const config = isHerman ? undefined : settings.providers.custom[provider.id];
          const enabled = isHerman ? settings.providers.herman.enabled : (config?.enabled ?? false);

          return (
            <div
              key={provider.id}
              className="bg-surface flex items-center justify-between rounded-xl border border-white/[0.06] p-4"
            >
              <div className="min-w-0 flex-1">
                <div className="text-text truncate font-medium">{provider.name}</div>
                <div className="text-ghost text-xs">
                  {isHerman ? "Clique-managed models" : provider.source}
                </div>
              </div>

              {isHerman ? (
                <div className="flex items-center gap-3">
                  <span className="text-ghost text-xs">{enabled ? "Enabled" : "Disabled"}</span>
                  <Switch
                    checked={enabled}
                    onCheckedChange={(checked) => void toggleHerman(checked)}
                  />
                </div>
              ) : (
                <Button
                  variant={enabled ? "outline" : "default"}
                  size="sm"
                  onClick={() => setSelectedProvider(provider)}
                >
                  {enabled ? "Disconnect" : "Connect"}
                </Button>
              )}
            </div>
          );
        })}
      </div>

      {selectedProvider && (
        <ProviderAuthDialog
          provider={selectedProvider}
          open={selectedProvider !== null}
          onOpenChange={(open) => {
            if (!open) setSelectedProvider(null);
          }}
        />
      )}
    </div>
  );
}
