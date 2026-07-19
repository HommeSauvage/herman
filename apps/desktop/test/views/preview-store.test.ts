import { beforeEach, describe, expect, it, mock } from "bun:test";

import type { PreviewServerSnapshot } from "../../src/shared/preview.js";
import { useAgentStore } from "../../src/views/main/lib/agent-store.js";
import {
  createPreviewStore,
  type PreviewRpcDeps,
  selectPreviewStage,
  selectShowRuntimeBanner,
} from "../../src/views/main/lib/preview-store.js";

const getProjectManifest = mock(() => Promise.resolve(undefined));
const startPreview = mock(() =>
  Promise.resolve({
    folderPath: "/a",
    serverId: "web",
    phase: "starting" as const,
    starting: true,
  }),
);
const restartPreview = mock(() =>
  Promise.resolve({
    folderPath: "/a",
    serverId: "web",
    phase: "starting" as const,
    starting: true,
  }),
);
const getSessionChanges = mock(() =>
  Promise.resolve({ isWorktree: true, changedFiles: 0, canApply: false }),
);
const applySession = mock(() => Promise.resolve({ status: "applied" as const }));
const discardSession = mock(() => Promise.resolve(undefined));

function makeFakeDeps(): PreviewRpcDeps {
  return {
    desktopRpc: {
      request: {
        getProjectManifest,
        startPreview,
        restartPreview,
        getSessionChanges,
        applySession,
        discardSession,
      },
    },
  } as unknown as PreviewRpcDeps;
}

function createStore() {
  return createPreviewStore(makeFakeDeps());
}

describe("preview-store", () => {
  let store: ReturnType<typeof createStore>;

  beforeEach(() => {
    store = createStore();
    getProjectManifest.mockClear();
    startPreview.mockClear();
    restartPreview.mockClear();
    getSessionChanges.mockClear();
    applySession.mockClear();
    discardSession.mockClear();
  });

  it("ignores stale folder-A manifest responses after switching to folder B", async () => {
    let resolveA!: (v: unknown) => void;
    getProjectManifest.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveA = resolve;
        }),
    );

    store.getState().activate({ folderPath: "/proj-a", tabId: "t1" });
    const genA = store.getState().generation;
    expect(typeof resolveA).toBe("function");

    store.getState().activate({ folderPath: "/proj-b", tabId: "t2" });
    expect(store.getState().folderPath).toBe("/proj-b");
    expect(store.getState().generation).toBeGreaterThan(genA);

    // Folder B's own (default-mocked) manifest fetch resolves first.
    await new Promise((r) => setTimeout(r, 10));
    expect(store.getState().manifest.phase).toBe("failed");
    expect(store.getState().manifest.value).toBeNull();

    // Folder A's stale response arrives late — it must be ignored because
    // the store has since moved on to a newer generation/folder.
    resolveA({
      primary: { id: "web", label: "Web", command: "npm run dev" },
      servers: [{ id: "web", label: "Web", command: "npm run dev", primary: true }],
    });
    await new Promise((r) => setTimeout(r, 10));

    expect(store.getState().folderPath).toBe("/proj-b");
    expect(store.getState().manifest.value).toBeNull();
  });

  it("keeps preview state when activate is called with the same identity", () => {
    store.getState().__resetForTests({
      folderPath: "/proj-a",
      projectRoot: "/proj-a",
      tabId: "t1",
      isWorktree: true,
      generation: 3,
      manifest: {
        phase: "loaded",
        value: {
          primary: { id: "web", label: "Web", command: "npm run dev" },
          servers: [{ id: "web", label: "Web", command: "npm run dev", primary: true }],
        },
      },
      server: {
        folderPath: "/proj-a",
        serverId: "web",
        phase: "ready",
        url: "http://localhost:3000",
        port: 3000,
      },
    });

    store.getState().activate({
      folderPath: "/proj-a",
      projectRoot: "/proj-a",
      tabId: "t1",
      isWorktree: true,
    });

    expect(store.getState().generation).toBe(3);
    expect(store.getState().server?.phase).toBe("ready");
    expect(store.getState().manifest.phase).toBe("loaded");
    expect(selectPreviewStage(store.getState())).toBe("ready");
  });

  it("keeps ready when a ready event lands before the in-flight start RPC resolves (ready-before-RPC)", async () => {
    // Simulates activate()'s async flow: operation is "start" (startPreview
    // RPC still in flight) while a previewStatusChanged "ready" push event
    // races ahead of the RPC response.
    store.getState().__resetForTests({
      folderPath: "/a",
      generation: 1,
      operation: "start",
      manifest: {
        phase: "loaded",
        value: {
          primary: { id: "web", label: "Web", command: "x" },
          servers: [{ id: "web", label: "Web", command: "x", primary: true }],
        },
      },
      activeServerId: "web",
    });

    store.getState().acceptStatus({
      folderPath: "/a",
      serverId: "web",
      phase: "ready",
      url: "http://localhost:3000",
      port: 3000,
    });

    expect(store.getState().operation).toBe("none");
    expect(selectPreviewStage(store.getState())).toBe("ready");
    expect(store.getState().server?.url).toBe("http://localhost:3000");
  });

  it("clears ready state on stopped without error", () => {
    store.getState().__resetForTests({
      folderPath: "/a",
      generation: 1,
      server: {
        folderPath: "/a",
        serverId: "web",
        phase: "ready",
        url: "http://localhost:3000",
        port: 3000,
      },
      activeServerId: "web",
    });

    store.getState().acceptStatus({
      folderPath: "/a",
      serverId: "web",
      phase: "stopped",
      url: "http://localhost:3000",
      port: 3000,
    });

    expect(store.getState().server?.phase).toBe("stopped");
    expect(selectPreviewStage(store.getState())).not.toBe("ready");
  });

  it("increments reloadRevision once on restart ready", async () => {
    store.getState().__resetForTests({
      folderPath: "/a",
      generation: 1,
      operation: "restart",
      reloadRevision: 0,
      activeServerId: "web",
      server: {
        folderPath: "/a",
        serverId: "web",
        phase: "starting",
        url: "http://localhost:3000",
        port: 3000,
      },
      manifest: {
        phase: "loaded",
        value: {
          primary: { id: "web", label: "Web", command: "x" },
          servers: [{ id: "web", label: "Web", command: "x", primary: true }],
        },
      },
    });

    store.getState().acceptStatus({
      folderPath: "/a",
      serverId: "web",
      phase: "ready",
      url: "http://localhost:3000",
      port: 3000,
    });

    expect(store.getState().reloadRevision).toBe(1);
    expect(store.getState().operation).toBe("none");
  });

  it("restart() itself drives reloadRevision when the RPC reports ready directly", async () => {
    restartPreview.mockImplementationOnce(() =>
      Promise.resolve({
        folderPath: "/a",
        serverId: "web",
        phase: "ready" as const,
        url: "http://localhost:3000",
        port: 3000,
        starting: false,
      }),
    );
    store.getState().__resetForTests({
      folderPath: "/a",
      generation: 1,
      reloadRevision: 0,
      activeServerId: "web",
      manifest: {
        phase: "loaded",
        value: {
          primary: { id: "web", label: "Web", command: "x" },
          servers: [{ id: "web", label: "Web", command: "x", primary: true }],
        },
      },
    });

    await store.getState().restart();

    expect(restartPreview).toHaveBeenCalledTimes(1);
    expect(store.getState().reloadRevision).toBe(1);
    expect(store.getState().operation).toBe("none");
  });

  it("records labeled sibling errors and ignores sibling ready", () => {
    store.getState().__resetForTests({
      folderPath: "/a",
      generation: 1,
      activeServerId: "web",
      server: {
        folderPath: "/a",
        serverId: "web",
        phase: "ready",
        url: "http://localhost:3000",
        port: 3000,
      },
    });

    store.getState().acceptStatus({
      folderPath: "/a",
      serverId: "api",
      phase: "ready",
      url: "http://localhost:3010",
      port: 3010,
    });
    expect(store.getState().server?.serverId).toBe("web");

    store.getState().acceptStatus({
      folderPath: "/a",
      serverId: "api",
      phase: "failed",
      error: "api crashed",
    });
    expect(store.getState().runtimeErrors[0]?.message).toContain("[api]");
    expect(store.getState().bannerDismissed).toBe(false);
  });

  it("truncates, dedupes adjacent, caps errors, and reopens banner", () => {
    store.getState().__resetForTests({ folderPath: "/a", generation: 1 });

    store.getState().acceptClientError({ message: "x".repeat(3000) });
    expect(store.getState().runtimeErrors[0]?.message.length).toBe(2000);

    store.getState().acceptClientError({ message: "same" });
    store.getState().acceptClientError({ message: "same" });
    expect(store.getState().runtimeErrors.filter((e) => e.message === "same").length).toBe(1);

    store.getState().dismissRuntimeErrors();
    expect(store.getState().bannerDismissed).toBe(true);

    for (let i = 0; i < 40; i++) {
      store.getState().acceptLog({
        folderPath: "/a",
        serverId: "web",
        source: "stderr",
        line: `err-${i}`,
        ts: i,
      });
    }
    expect(store.getState().runtimeErrors.length).toBe(30);
    expect(store.getState().bannerDismissed).toBe(false);
    expect(
      selectShowRuntimeBanner({
        ...store.getState(),
        server: {
          folderPath: "/a",
          serverId: "web",
          phase: "ready",
          url: "http://localhost:1",
          port: 1,
        },
      }),
    ).toBe(true);
  });

  it("ends in stable state after rejected manifest load", async () => {
    getProjectManifest.mockImplementationOnce(() => Promise.reject(new Error("boom")));
    store.getState().activate({ folderPath: "/fail" });
    await new Promise((r) => setTimeout(r, 20));
    expect(store.getState().manifest.phase).toBe("failed");
    expect(store.getState().operation).toBe("none");
    expect(selectPreviewStage(store.getState())).toBe("manifest_failed");
  });

  it("shows a recoverable manifest failure when no manifest exists in an open folder", async () => {
    store.getState().activate({ folderPath: "/project", projectRoot: "/project" });
    await new Promise((r) => setTimeout(r, 20));
    expect(store.getState().manifest.phase).toBe("failed");
    expect(selectPreviewStage(store.getState())).toBe("manifest_failed");
  });

  it("populates composer and switches to session view", () => {
    // Spy on the agent-store singleton methods so we can assert
    // askHermanToFix calls them correctly.
    const state = useAgentStore.getState();
    const origSetComposerValue = state.setComposerValue;
    const origSetView = state.setView;
    const mockSetComposerValue = mock(() => {});
    const mockSetView = mock(() => {});
    try {
      // biome-ignore lint/suspicious/noExplicitAny: test mock override
      (state as any).setComposerValue = mockSetComposerValue;
      // biome-ignore lint/suspicious/noExplicitAny: test mock override
      (state as any).setView = mockSetView;

      store.getState().__resetForTests({
        folderPath: "/a",
        generation: 1,
        tabId: "t1",
      });

      store.getState().askHermanToFix("boom", "runtime");

      expect(mockSetComposerValue).toHaveBeenCalledTimes(1);
      expect(mockSetComposerValue.mock.calls[0]?.[0]).toBe("t1");
      expect(mockSetComposerValue.mock.calls[0]?.[1]).toContain("boom");
      expect(mockSetView).toHaveBeenCalledTimes(1);
      expect(mockSetView.mock.calls[0]?.[0]).toBe("session");
    } finally {
      // biome-ignore lint/suspicious/noExplicitAny: test mock restore
      (state as any).setComposerValue = origSetComposerValue;
      // biome-ignore lint/suspicious/noExplicitAny: test mock restore
      (state as any).setView = origSetView;
    }
  });

  it("refreshDraft uses the injected getSessionChanges dependency", async () => {
    getSessionChanges.mockImplementationOnce(() =>
      Promise.resolve({ isWorktree: true, changedFiles: 3, canApply: true }),
    );
    store.getState().__resetForTests({
      folderPath: "/a",
      generation: 1,
      tabId: "t1",
      isWorktree: true,
    });

    await store.getState().refreshDraft();

    expect(getSessionChanges).toHaveBeenCalledTimes(1);
    expect(store.getState().draft.changedFiles).toBe(3);
    expect(store.getState().draft.canApply).toBe(true);
  });
});

describe("preview-store acceptStatus typing", () => {
  it("accepts a complete snapshot", () => {
    const snap: PreviewServerSnapshot = {
      scope: "folder:/x",
      folderPath: "/x",
      serverId: "web",
      phase: "ready",
      url: "http://localhost:1",
      port: 1,
    };
    const store = createStore();
    store.getState().__resetForTests({ folderPath: "/x", generation: 1, activeServerId: "web" });
    store.getState().acceptStatus(snap);
    expect(store.getState().server).toEqual(snap);
  });
});

describe("preview-store session setup integration", () => {
  let store: ReturnType<typeof createStore>;

  beforeEach(() => {
    store = createStore();
    getProjectManifest.mockClear();
    startPreview.mockClear();
    restartPreview.mockClear();
  });

  it("never calls startPreview on activate — servers are main-driven", async () => {
    getProjectManifest.mockImplementationOnce(() =>
      Promise.resolve({
        primary: { id: "web", label: "Web", command: "npm run dev" },
        servers: [{ id: "web", label: "Web", command: "npm run dev", primary: true }],
      }),
    );

    store.getState().activate({ folderPath: "/proj-a", tabId: "t1", setupPhase: "ready" });
    await new Promise((r) => setTimeout(r, 20));

    expect(store.getState().manifest.phase).toBe("loaded");
    expect(startPreview).not.toHaveBeenCalled();
  });

  it("shows waiting_for_setup while the session setup is pending", () => {
    store.getState().activate({
      folderPath: "/proj-a",
      tabId: "t1",
      setupPhase: "pending",
    });
    expect(selectPreviewStage(store.getState())).toBe("waiting_for_setup");

    // Setup finishing re-activates and moves past the waiting stage.
    store.getState().activate({
      folderPath: "/proj-a",
      tabId: "t1",
      setupPhase: "ready",
    });
    expect(selectPreviewStage(store.getState())).not.toBe("waiting_for_setup");
  });

  it("matches status events by tab scope and ignores other scopes", () => {
    store.getState().__resetForTests({
      folderPath: "/proj-a",
      generation: 1,
      tabId: "t1",
      activeServerId: "web",
    });

    // Another tab's ready event must not leak into this store.
    store.getState().acceptStatus({
      scope: "tab:other-tab",
      folderPath: "/proj-a",
      serverId: "web",
      phase: "ready",
      url: "http://localhost:9999",
      port: 9999,
    });
    expect(store.getState().server).toBeNull();

    // Our tab's event is accepted.
    store.getState().acceptStatus({
      scope: "tab:t1",
      folderPath: "/proj-a",
      serverId: "web",
      phase: "ready",
      url: "http://localhost:3000",
      port: 3000,
    });
    expect(store.getState().server?.url).toBe("http://localhost:3000");
  });

  it("passes tabId (not folderPath) when manually restarting", async () => {
    store.getState().__resetForTests({
      folderPath: "/proj-a",
      generation: 1,
      tabId: "t1",
      manifest: {
        phase: "loaded",
        value: {
          primary: { id: "web", label: "Web", command: "npm run dev" },
          servers: [{ id: "web", label: "Web", command: "npm run dev", primary: true }],
        },
      },
    });
    restartPreview.mockImplementationOnce(() =>
      Promise.resolve({
        scope: "tab:t1",
        folderPath: "/proj-a",
        serverId: "web",
        phase: "starting" as const,
        starting: true,
      }),
    );

    await store.getState().restart();
    expect(restartPreview).toHaveBeenCalledTimes(1);
    expect(restartPreview.mock.calls[0]?.[0]).toMatchObject({ tabId: "t1" });
    expect(restartPreview.mock.calls[0]?.[0]).not.toHaveProperty("folderPath");
  });
});
