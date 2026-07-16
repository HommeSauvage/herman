import { create } from "zustand";

import type { DevServer, ProjectManifestView } from "../../../shared/herman-manifest.js";
import type { PreviewLogEvent, PreviewServerSnapshot } from "../../../shared/preview.js";
import type { DesktopRpc, TabId } from "../../../shared/rpc.js";
import type { PreviewRuntimeError } from "../components/preview-error-banner.js";
import { sendPrompt as realSendPrompt } from "./agent-actions.js";
import { desktopRpc as realDesktopRpc } from "./desktop-rpc.js";
import {
  appendRuntimeError,
  buildAskHermanPrompt,
  formatRuntimeErrors,
  truncateMessage,
} from "./preview-errors.js";

/**
 * RPC surface the preview store depends on. Injectable so tests can supply
 * fake implementations without reaching for `mock.module`.
 */
export type PreviewRpcDeps = {
  desktopRpc: {
    request: Pick<
      DesktopRpc["request"],
      | "getProjectManifest"
      | "startPreview"
      | "restartPreview"
      | "getSessionChanges"
      | "applySession"
      | "discardSession"
    >;
  };
  sendPrompt: (
    tabId: TabId,
    text: string,
    options?: { keepComposer?: boolean; skipAttachments?: boolean },
  ) => Promise<void>;
};

const defaultRpcDeps: PreviewRpcDeps = {
  desktopRpc: realDesktopRpc,
  sendPrompt: realSendPrompt,
};

export type DeviceMode = "desktop" | "tablet" | "mobile";

export const DEVICE_WIDTHS: Record<DeviceMode, string> = {
  desktop: "100%",
  tablet: "768px",
  mobile: "375px",
};

type ManifestState =
  | { phase: "idle"; value: null }
  | { phase: "loading"; value: null }
  | { phase: "loaded"; value: ProjectManifestView | null }
  | { phase: "failed"; value: null; error: string };

type DraftState = {
  changedFiles: number;
  canApply: boolean;
  operation: "none" | "apply" | "discard";
  error: string | null;
};

type PreviewStoreState = {
  folderPath: string;
  tabId: string | undefined;
  isWorktree: boolean;
  generation: number;
  manifest: ManifestState;
  server: PreviewServerSnapshot | null;
  activeServerId: string | null;
  operation: "none" | "start" | "restart" | "switch";
  reloadRevision: number;
  draft: DraftState;
  runtimeErrors: PreviewRuntimeError[];
  bannerDismissed: boolean;
  errorIdCounter: number;
  deviceMode: DeviceMode;
  discardDialogOpen: boolean;
  askInFlight: boolean;
};

type PreviewActivateContext = {
  folderPath: string;
  tabId?: string;
  isWorktree?: boolean;
};

type PreviewStoreActions = {
  activate: (ctx: PreviewActivateContext) => void;
  loadAndStart: (generation: number) => Promise<void>;
  acceptStatus: (snapshot: PreviewServerSnapshot) => void;
  acceptLog: (event: PreviewLogEvent) => void;
  acceptClientError: (err: { message: string; stack?: string }) => void;
  restart: () => Promise<void>;
  switchServer: (server: DevServer) => Promise<void>;
  refreshDraft: () => Promise<void>;
  applyDraft: () => Promise<void>;
  discardDraft: () => Promise<void>;
  askHermanToFix: (error: string, context: "preview" | "save" | "runtime") => Promise<void>;
  dismissRuntimeErrors: () => void;
  setDeviceMode: (mode: DeviceMode) => void;
  setDiscardDialogOpen: (open: boolean) => void;
  /** Test helper: replace state slices. */
  __resetForTests: (partial?: Partial<PreviewStoreState>) => void;
};

const emptyDraft = (): DraftState => ({
  changedFiles: 0,
  canApply: false,
  operation: "none",
  error: null,
});

const initialState = (): PreviewStoreState => ({
  folderPath: "",
  tabId: undefined,
  isWorktree: false,
  generation: 0,
  manifest: { phase: "idle", value: null },
  server: null,
  activeServerId: null,
  operation: "none",
  reloadRevision: 0,
  draft: emptyDraft(),
  runtimeErrors: [],
  bannerDismissed: false,
  errorIdCounter: 0,
  deviceMode: "desktop",
  discardDialogOpen: false,
  askInFlight: false,
});

function isCurrent(
  state: PreviewStoreState,
  generation: number,
  folderPath: string,
  tabId?: string,
): boolean {
  if (state.generation !== generation) return false;
  if (state.folderPath !== folderPath) return false;
  if (tabId !== undefined && state.tabId !== tabId) return false;
  return true;
}

export type PreviewStore = PreviewStoreState & PreviewStoreActions;

export function createPreviewStore(rpcDeps: PreviewRpcDeps = defaultRpcDeps) {
  const { desktopRpc, sendPrompt } = rpcDeps;
  return create<PreviewStore>((set, get) => ({
    ...initialState(),

    activate: (ctx) => {
      const generation = get().generation + 1;
      const folderPath = ctx.folderPath;
      const tabId = ctx.tabId;
      const isWorktree = Boolean(ctx.isWorktree);

      set({
        ...initialState(),
        generation,
        folderPath,
        tabId,
        isWorktree,
        deviceMode: get().deviceMode, // preserve across folders
        manifest:
          folderPath && folderPath.length >= 3
            ? { phase: "loading", value: null }
            : { phase: "idle", value: null },
      });

      if (folderPath && folderPath.length >= 3) {
        void get().loadAndStart(generation);
      }
      if (tabId && isWorktree) {
        void get().refreshDraft();
      }
    },

    loadAndStart: async (generation) => {
      const { folderPath } = get();
      if (!folderPath || folderPath.length < 3) return;

      set({ manifest: { phase: "loading", value: null }, operation: "start" });

      try {
        const m = await desktopRpc.request.getProjectManifest({ folderPath });
        if (!isCurrent(get(), generation, folderPath)) return;

        if (!m) {
          set({
            manifest: { phase: "loaded", value: null },
            operation: "none",
            server: null,
            activeServerId: null,
          });
          return;
        }

        const activeServerId = m.primary?.id ?? m.servers?.[0]?.id ?? null;
        set({
          manifest: { phase: "loaded", value: m },
          activeServerId,
        });

        const result = await desktopRpc.request.startPreview({
          folderPath,
          all: true,
          ...(m.primary
            ? {
                serverId: m.primary.id,
                devCommand: m.primary.command,
                devPort: m.primary.port,
              }
            : {}),
        });

        if (!isCurrent(get(), generation, folderPath)) return;

        // Event snapshots are authoritative; only apply if we don't already
        // have a newer ready/failed from push events.
        const current = get().server;
        if (current && (current.phase === "ready" || current.phase === "failed")) {
          if (get().operation === "start") set({ operation: "none" });
          return;
        }

        set({
          server: {
            folderPath: result.folderPath,
            serverId: result.serverId,
            phase: result.phase,
            url: result.url,
            port: result.port,
            error: result.error,
          },
          activeServerId: result.serverId ?? activeServerId,
          operation: result.starting ? "start" : "none",
        });
      } catch (err) {
        if (!isCurrent(get(), generation, folderPath)) return;
        const message = err instanceof Error ? err.message : "Failed to load project manifest";
        set({
          manifest: { phase: "failed", value: null, error: message },
          operation: "none",
        });
      }
    },

    acceptStatus: (snapshot) => {
      const state = get();
      if (!state.folderPath || snapshot.folderPath !== state.folderPath) return;

      // Fleet sibling errors: record as runtime log-style failures when not active.
      if (
        state.activeServerId &&
        snapshot.serverId !== state.activeServerId &&
        snapshot.phase === "failed" &&
        snapshot.error
      ) {
        const { errors, nextId, changed } = appendRuntimeError(
          state.runtimeErrors,
          {
            source: "server",
            message: `[${snapshot.serverId}] ${snapshot.error}`,
            ts: Date.now(),
          },
          state.errorIdCounter,
        );
        if (changed) {
          set({ runtimeErrors: errors, errorIdCounter: nextId, bannerDismissed: false });
        }
        return;
      }

      if (state.activeServerId && snapshot.serverId !== state.activeServerId) {
        // Ignore non-active ready/starting noise.
        if (snapshot.phase !== "failed") return;
      }

      const prevUrl = state.server?.url ?? null;
      const next: Partial<PreviewStoreState> = {
        server: snapshot,
      };

      if (snapshot.serverId) {
        next.activeServerId = snapshot.serverId;
      }

      if (snapshot.phase === "ready" || snapshot.phase === "failed" || snapshot.phase === "stopped") {
        next.operation = "none";
      }

      if (snapshot.phase === "ready") {
        if (state.operation === "restart" || (prevUrl && prevUrl === snapshot.url)) {
          // Same URL after restart — bump reload revision once.
          if (state.operation === "restart") {
            next.reloadRevision = state.reloadRevision + 1;
          }
        }
        // Clear runtime errors when URL changes (server switch).
        if (prevUrl !== null && snapshot.url && prevUrl !== snapshot.url) {
          next.runtimeErrors = [];
          next.bannerDismissed = false;
        }
      }

      if (snapshot.phase === "failed") {
        next.runtimeErrors = [];
        next.bannerDismissed = false;
      }

      if (snapshot.phase === "stopped" && !snapshot.error) {
        // Clear ready state without treating as failure.
        next.server = snapshot;
      }

      set(next);
    },

    acceptLog: (event) => {
      const state = get();
      if (!state.folderPath || event.folderPath !== state.folderPath) return;
      const labeled =
        event.serverId && state.activeServerId && event.serverId !== state.activeServerId
          ? `[${event.serverId}] ${event.line}`
          : event.line;
      const { errors, nextId, changed } = appendRuntimeError(
        state.runtimeErrors,
        { source: "server", message: labeled, ts: event.ts },
        state.errorIdCounter,
      );
      if (!changed) return;
      set({ runtimeErrors: errors, errorIdCounter: nextId, bannerDismissed: false });
    },

    acceptClientError: (err) => {
      const message = err.stack
        ? `${truncateMessage(err.message)}\n${truncateMessage(err.stack)}`
        : truncateMessage(err.message);
      const { errors, nextId, changed } = appendRuntimeError(
        get().runtimeErrors,
        { source: "client", message, ts: Date.now() },
        get().errorIdCounter,
      );
      if (!changed) return;
      set({ runtimeErrors: errors, errorIdCounter: nextId, bannerDismissed: false });
    },

    restart: async () => {
      const state = get();
      const { folderPath, generation, manifest } = state;
      if (manifest.phase !== "loaded" || !manifest.value) return;

      set({
        operation: "restart",
        server: state.server
          ? { ...state.server, phase: "starting", error: undefined }
          : {
              folderPath,
              serverId: state.activeServerId ?? "web",
              phase: "starting",
            },
        runtimeErrors: [],
        bannerDismissed: false,
      });

      try {
        const m = manifest.value;
        const result = await desktopRpc.request.restartPreview({
          folderPath,
          all: true,
          ...(m.primary
            ? {
                serverId: m.primary.id,
                devCommand: m.primary.command,
                devPort: m.primary.port,
              }
            : {}),
        });
        if (!isCurrent(get(), generation, folderPath)) return;
        const current = get().server;
        if (current && (current.phase === "ready" || current.phase === "failed")) return;
        set({
          server: {
            folderPath: result.folderPath,
            serverId: result.serverId,
            phase: result.phase,
            url: result.url,
            port: result.port,
            error: result.error,
          },
          activeServerId: result.serverId ?? state.activeServerId,
          operation: result.starting ? "restart" : "none",
          ...(result.phase === "ready" ? { reloadRevision: get().reloadRevision + 1 } : {}),
        });
      } catch (err) {
        if (!isCurrent(get(), generation, folderPath)) return;
        set({
          operation: "none",
          server: {
            folderPath,
            serverId: state.activeServerId ?? "web",
            phase: "failed",
            error: err instanceof Error ? err.message : "Failed to restart preview",
          },
        });
      }
    },

    switchServer: async (server) => {
      const state = get();
      const { folderPath, generation } = state;
      set({
        activeServerId: server.id,
        operation: "switch",
        runtimeErrors: [],
        bannerDismissed: false,
        server: {
          folderPath,
          serverId: server.id,
          phase: "starting",
        },
      });

      try {
        const result = await desktopRpc.request.startPreview({
          folderPath,
          serverId: server.id,
          devCommand: server.command,
          devPort: server.port,
        });
        if (!isCurrent(get(), generation, folderPath)) return;
        if (get().activeServerId !== server.id) return;
        const current = get().server;
        if (current && current.serverId === server.id && current.phase === "ready") return;
        set({
          server: {
            folderPath: result.folderPath,
            serverId: result.serverId,
            phase: result.phase,
            url: result.url,
            port: result.port,
            error: result.error,
          },
          operation: result.starting ? "switch" : "none",
        });
      } catch (err) {
        if (!isCurrent(get(), generation, folderPath)) return;
        if (get().activeServerId !== server.id) return;
        set({
          operation: "none",
          server: {
            folderPath,
            serverId: server.id,
            phase: "failed",
            error: err instanceof Error ? err.message : "Failed to start preview server",
          },
        });
      }
    },

    refreshDraft: async () => {
      const { tabId, isWorktree, generation, folderPath } = get();
      if (!tabId || !isWorktree) {
        set({ draft: emptyDraft() });
        return;
      }
      try {
        const result = await desktopRpc.request.getSessionChanges({ tabId });
        if (!isCurrent(get(), generation, folderPath, tabId)) return;
        set({
          draft: {
            ...get().draft,
            changedFiles: result.changedFiles,
            canApply: result.canApply,
          },
        });
      } catch {
        if (!isCurrent(get(), generation, folderPath, tabId)) return;
        // Leave prior draft counts; transport failure is non-fatal.
      }
    },

    applyDraft: async () => {
      const { tabId, draft, generation, folderPath } = get();
      if (!tabId || !draft.canApply) return;
      set({ draft: { ...draft, operation: "apply", error: null } });
      try {
        const result = await desktopRpc.request.applySession({ tabId });
        if (!isCurrent(get(), generation, folderPath, tabId)) return;
        if (result.status === "error") {
          set({
            draft: {
              ...get().draft,
              operation: "none",
              error: result.error ?? "Could not save to your project. Try again.",
            },
          });
        } else {
          set({ draft: { ...get().draft, operation: "none", error: null } });
        }
        await get().refreshDraft();
      } catch {
        if (!isCurrent(get(), generation, folderPath, tabId)) return;
        set({
          draft: {
            ...get().draft,
            operation: "none",
            error: "Could not save to your project. Try again.",
          },
        });
      }
    },

    discardDraft: async () => {
      const { tabId, generation, folderPath } = get();
      if (!tabId) return;
      set({
        draft: { ...get().draft, operation: "discard" },
        discardDialogOpen: false,
      });
      try {
        await desktopRpc.request.discardSession({ tabId });
      } finally {
        if (!isCurrent(get(), generation, folderPath, tabId)) return;
        set({ draft: { ...get().draft, operation: "none" } });
      }
    },

    askHermanToFix: async (error, context) => {
      const { tabId, generation, folderPath } = get();
      if (!tabId || !error) return;
      set({ askInFlight: true });
      try {
        await sendPrompt(tabId, buildAskHermanPrompt(error, context), {
          keepComposer: true,
          skipAttachments: true,
        });
      } finally {
        if (!isCurrent(get(), generation, folderPath, tabId)) return;
        set({ askInFlight: false });
      }
    },

    dismissRuntimeErrors: () => set({ bannerDismissed: true }),
    setDeviceMode: (mode) => set({ deviceMode: mode }),
    setDiscardDialogOpen: (open) => set({ discardDialogOpen: open }),

    __resetForTests: (partial) => set({ ...initialState(), ...partial }),
  }));
}

export const usePreviewStore = createPreviewStore();

// ── Selectors ──────────────────────────────────────────────────────────────

export type PreviewStage =
  | "manifest_loading"
  | "manifest_failed"
  | "server_starting"
  | "server_failed"
  | "ready"
  | "no_manifest"
  | "waiting";

export function selectPreviewStage(state: PreviewStoreState): PreviewStage {
  if (state.manifest.phase === "loading") return "manifest_loading";
  if (state.manifest.phase === "failed") return "manifest_failed";

  const phase = state.server?.phase;
  const op = state.operation;

  if (phase === "failed") return "server_failed";
  if (
    op === "start" ||
    op === "restart" ||
    op === "switch" ||
    phase === "installing" ||
    phase === "starting"
  ) {
    return "server_starting";
  }
  if (phase === "ready" && state.server?.url) return "ready";
  if (state.manifest.phase === "loaded" && state.manifest.value) return "waiting";
  return "no_manifest";
}

export function selectShowRuntimeBanner(state: PreviewStoreState): boolean {
  return (
    Boolean(state.server?.url) &&
    state.server?.phase === "ready" &&
    state.runtimeErrors.length > 0 &&
    !state.bannerDismissed
  );
}

export function selectIsSaving(state: PreviewStoreState): boolean {
  return state.draft.operation === "apply" || state.draft.operation === "discard";
}

export function selectIsSynced(state: PreviewStoreState): boolean {
  return !state.draft.canApply && !selectIsSaving(state);
}

export function selectStatusCopy(state: PreviewStoreState): string {
  if (selectIsSaving(state)) return "Saving to your project…";
  if (selectIsSynced(state)) return "Working in a safe draft copy · Up to date";
  return `Working in a safe draft copy · Unsaved changes${
    state.draft.changedFiles > 0 ? ` · ${state.draft.changedFiles} file(s) changed` : ""
  }`;
}

export { formatRuntimeErrors };
