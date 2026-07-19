import { getLogger } from "@logtape/logtape";
import { create } from "zustand";

import type { DevServer, ProjectManifestView } from "../../../shared/herman-manifest.js";
import type { PreviewLogEvent, PreviewServerSnapshot } from "../../../shared/preview.js";
import { folderScope, tabScope } from "../../../shared/preview.js";
import type { DesktopRpc, SessionSetupState } from "../../../shared/rpc.js";
import type { PreviewRuntimeError } from "../components/preview-error-banner.js";
import { useAgentStore } from "./agent-store.js";
import { desktopRpc as realDesktopRpc } from "./desktop-rpc.js";

const logger = getLogger(["herman-desktop", "view", "preview-store"]);
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
};

const defaultRpcDeps: PreviewRpcDeps = {
  desktopRpc: realDesktopRpc,
};

export type DeviceMode = "desktop" | "tablet" | "mobile";

export const DEVICE_WIDTHS: Record<DeviceMode, string> = {
  desktop: "100%",
  tablet: "768px",
  mobile: "375px",
};

type ManifestState =
  | { phase: "idle"; value: null }
  | { phase: "loading"; value: ProjectManifestView | null }
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
  projectRoot: string;
  tabId: string | undefined;
  isWorktree: boolean;
  /** The session's setup phase — previews wait for "ready". */
  setupPhase: SessionSetupState["phase"] | undefined;
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
  /** Full URL currently shown in the preview (may differ from server root after in-app nav). */
  currentUrl: string | null;
  canGoBack: boolean;
};

type PreviewActivateContext = {
  folderPath: string;
  projectRoot?: string;
  tabId?: string;
  isWorktree?: boolean;
  setupPhase?: SessionSetupState["phase"];
};

type PreviewStoreActions = {
  activate: (ctx: PreviewActivateContext) => void;
  loadManifest: (generation: number) => Promise<void>;
  acceptStatus: (snapshot: PreviewServerSnapshot) => void;
  acceptLog: (event: PreviewLogEvent) => void;
  acceptClientError: (err: { message: string; stack?: string }) => void;
  restart: () => Promise<void>;
  switchServer: (server: DevServer) => Promise<void>;
  refreshDraft: () => Promise<void>;
  applyDraft: () => Promise<void>;
  discardDraft: () => Promise<void>;
  askHermanToFix: (error: string, context: "preview" | "save" | "runtime") => void;
  dismissRuntimeErrors: () => void;
  setDeviceMode: (mode: DeviceMode) => void;
  setDiscardDialogOpen: (open: boolean) => void;
  setCurrentUrl: (url: string) => void;
  setCanGoBack: (can: boolean) => void;
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
  projectRoot: "",
  tabId: undefined,
  isWorktree: false,
  setupPhase: undefined,
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
  currentUrl: null,
  canGoBack: false,
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

/** The preview scope this store instance renders: the tab's own scope when
 *  a tab is active, otherwise the folder scope (tab-less callers). */
function expectedScope(state: PreviewStoreState): string {
  if (state.tabId) return tabScope(state.tabId);
  return state.folderPath ? folderScope(state.folderPath) : "";
}

function matchesScope(
  state: PreviewStoreState,
  scope: string,
  folderPath: string,
): boolean {
  const expected = expectedScope(state);
  if (expected && scope === expected) return true;
  // Folder-scoped events are a fallback for stores without a tab.
  if (!state.tabId && state.folderPath && folderPath === state.folderPath) return true;
  return false;
}

export type PreviewStore = PreviewStoreState & PreviewStoreActions;

export function createPreviewStore(rpcDeps: PreviewRpcDeps = defaultRpcDeps) {
  const { desktopRpc } = rpcDeps;
  return create<PreviewStore>((set, get) => ({
    ...initialState(),

    activate: (ctx) => {
      const state = get();
      const folderPath = ctx.folderPath;
      const projectRoot = ctx.projectRoot ?? "";
      const tabId = ctx.tabId;
      const isWorktree = Boolean(ctx.isWorktree);
      const setupPhase = ctx.setupPhase;
      const sameIdentity =
        state.folderPath === folderPath &&
        state.projectRoot === projectRoot &&
        state.tabId === tabId &&
        state.isWorktree === isWorktree &&
        state.setupPhase === setupPhase;
      const generation = sameIdentity ? state.generation : state.generation + 1;
      if (sameIdentity) {
        if (folderPath && folderPath.length >= 3 && state.manifest.phase === "idle") {
          void get().loadManifest(generation);
        }
        if (tabId && isWorktree) {
          void get().refreshDraft();
        }
        return;
      }

      set({
        ...initialState(),
        generation,
        folderPath,
        projectRoot,
        tabId,
        isWorktree,
        setupPhase,
        deviceMode: get().deviceMode, // preserve across folders
        manifest:
          folderPath && folderPath.length >= 3
            ? {
                phase: "loading",
                value:
                  state.manifest.phase === "loaded" && state.manifest.value
                    ? state.manifest.value
                    : null,
              }
            : { phase: "idle", value: null },
      });

      if (folderPath && folderPath.length >= 3) {
        void get().loadManifest(generation);
      }
      if (tabId && isWorktree) {
        void get().refreshDraft();
      }
    },

    // Loads the project manifest only. Servers are started by the main
    // process once the session is ready — the renderer never triggers
    // setup side effects; it only renders state and subscribes to events.
    loadManifest: async (generation) => {
      const { folderPath, projectRoot, manifest } = get();
      if (!folderPath || folderPath.length < 3) return;

      set({
        manifest: {
          phase: "loading",
          value: manifest.phase === "loaded" && manifest.value ? manifest.value : null,
        },
      });

      try {
        let m = await desktopRpc.request.getProjectManifest({ folderPath, projectRoot });
        if (!m && projectRoot && projectRoot !== folderPath) {
          m = await desktopRpc.request.getProjectManifest({ folderPath: projectRoot, projectRoot });
        }
        if (!isCurrent(get(), generation, folderPath)) return;

        if (!m) {
          set({
            manifest: {
              phase: "failed",
              value: null,
              error: "Couldn't find a valid herman.yaml or HERMAN.md for this project.",
            },
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
      if (!matchesScope(state, snapshot.scope, snapshot.folderPath)) return;

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
        if (snapshot.url) {
          next.currentUrl = snapshot.url;
          next.canGoBack = false;
        }
        // When server becomes ready and we have accumulated runtime errors,
        // ensure the banner is explicitly undismissed so it shows immediately.
        if (state.runtimeErrors.length > 0 && state.bannerDismissed) {
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
      if (!matchesScope(state, event.scope, event.folderPath)) {
        logger.debug("Ignoring preview log — scope mismatch", {
          storeScope: expectedScope(state) || "(empty)",
          eventScope: event.scope,
        });
        return;
      }
      const labeled =
        event.serverId && state.activeServerId && event.serverId !== state.activeServerId
          ? `[${event.serverId}] ${event.line}`
          : event.line;
      const { errors, nextId, changed } = appendRuntimeError(
        state.runtimeErrors,
        { source: "server", message: labeled, ts: event.ts },
        state.errorIdCounter,
      );
      if (!changed) {
        logger.debug("Ignoring preview log — duplicate or capped", {
          source: event.source,
          line: event.line.slice(0, 100),
        });
        return;
      }
      logger.info("Preview log accepted — updating runtimeErrors", {
        source: event.source,
        line: event.line.slice(0, 200),
        errorCount: errors.length,
        serverPhase: state.server?.phase,
      });
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
      const { folderPath, tabId, generation, manifest } = state;
      if (manifest.phase !== "loaded" || !manifest.value) return;

      set({
        operation: "restart",
        server: state.server
          ? { ...state.server, phase: "starting", error: undefined }
          : {
              scope: expectedScope(state),
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
          ...(tabId ? { tabId } : { folderPath }),
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
            scope: result.scope,
            folderPath: result.folderPath,
            serverId: result.serverId,
            phase: result.phase,
            url: result.url,
            port: result.port,
            error: result.error,
          },
          activeServerId: result.serverId ?? state.activeServerId,
          operation: result.starting ? "restart" : "none",
          ...(result.phase === "ready"
            ? { reloadRevision: get().reloadRevision + 1, currentUrl: result.url ?? null, canGoBack: false }
            : {}),
        });
      } catch (err) {
        if (!isCurrent(get(), generation, folderPath)) return;
        set({
          operation: "none",
          server: {
            scope: expectedScope(state),
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
      const { folderPath, tabId, generation } = state;
      set({
        activeServerId: server.id,
        operation: "switch",
        runtimeErrors: [],
        bannerDismissed: false,
        currentUrl: null,
        canGoBack: false,
        server: {
          scope: expectedScope(state),
          folderPath,
          serverId: server.id,
          phase: "starting",
        },
      });

      try {
        const result = await desktopRpc.request.startPreview({
          ...(tabId ? { tabId } : { folderPath }),
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
            scope: result.scope,
            folderPath: result.folderPath,
            serverId: result.serverId,
            phase: result.phase,
            url: result.url,
            port: result.port,
            error: result.error,
          },
          operation: result.starting ? "switch" : "none",
          ...(result.url ? { currentUrl: result.url, canGoBack: false } : {}),
        });
      } catch (err) {
        if (!isCurrent(get(), generation, folderPath)) return;
        if (get().activeServerId !== server.id) return;
        set({
          operation: "none",
          server: {
            scope: expectedScope(state),
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

    askHermanToFix: (error, context) => {
      const { tabId } = get();
      if (!tabId || !error) return;
      const promptText = buildAskHermanPrompt(error, context);
      useAgentStore.getState().setComposerValue(tabId, promptText);
      useAgentStore.getState().setView("session");
    },

    dismissRuntimeErrors: () => set({ bannerDismissed: true }),
    setDeviceMode: (mode) => set({ deviceMode: mode }),
    setDiscardDialogOpen: (open) => set({ discardDialogOpen: open }),
    setCurrentUrl: (url) => set({ currentUrl: url }),
    setCanGoBack: (can) => set({ canGoBack: can }),

    __resetForTests: (partial) => set({ ...initialState(), ...partial }),
  }));
}

export const usePreviewStore = createPreviewStore();

// ── Selectors ──────────────────────────────────────────────────────────────

export type PreviewStage =
  | "manifest_loading"
  | "manifest_failed"
  | "waiting_for_setup"
  | "server_starting"
  | "server_failed"
  | "ready"
  | "no_manifest"
  | "waiting";

export function selectPreviewStage(state: PreviewStoreState): PreviewStage {
  if (!state.folderPath) return "no_manifest";
  // The session's workspace is still being set up — never start (or show)
  // a server against the temporary main-tree folder.
  if (state.setupPhase === "pending") return "waiting_for_setup";
  if (state.manifest.phase === "loading") return "manifest_loading";
  if (state.manifest.phase === "failed") return "manifest_failed";

  const phase = state.server?.phase;
  const op = state.operation;

  if (phase === "failed") return "server_failed";
  if (
    op === "start" ||
    op === "restart" ||
    op === "switch" ||
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

export function selectSaveTooltip(state: PreviewStoreState): string {
  if (selectIsSaving(state)) return "Saving to your project…";
  if (selectIsSynced(state)) return "All changes saved";
  const count = state.draft.changedFiles;
  if (count > 0) {
    return `Changes in this tab are not saved yet. ${count} file${count === 1 ? "" : "s"} to save.`;
  }
  return "Changes in this tab are not saved yet.";
}

export { formatRuntimeErrors };
