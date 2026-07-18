import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearHermantAppDir,
  createTestTempDir,
  setHermantAppDir,
} from "../helpers/temp-dir.js";
import {
  ModelCatalogService,
  type ModelCatalogSnapshot,
} from "../../src/bun/model-catalog.js";

const SERVER = "http://herman.test";

let tempDir: string;
let catalogPath: string;
let legacyPath: string;

beforeEach(() => {
  tempDir = createTestTempDir("herman-model-catalog-");
  setHermantAppDir(tempDir);
  catalogPath = join(tempDir, "model-catalog.json");
  legacyPath = join(tempDir, "herman-models-cache.json");
});

afterEach(() => {
  clearHermantAppDir(tempDir);
});

type FetchBehavior =
  | { ok: true; models: { id: string; name?: string; contextWindow?: number }[] }
  | { ok: false; status?: number }
  | { throws: true };

function mockFetch(sequence: FetchBehavior[]): {
  fetchImpl: typeof fetch;
  calls: string[];
} {
  const calls: string[] = [];
  let index = 0;
  const fetchImpl = (async (url: unknown) => {
    calls.push(String(url));
    const behavior = sequence[Math.min(index, sequence.length - 1)]!;
    index += 1;
    if ("throws" in behavior) throw new Error("network down");
    if (!behavior.ok) {
      return {
        ok: false,
        status: behavior.status ?? 500,
        json: async () => ({}),
      } as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ models: behavior.models }),
    } as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function createService(overrides?: {
  fetchImpl?: typeof fetch;
  hermanEnabled?: boolean;
  serverUrl?: string;
  onChange?: (snapshot: ModelCatalogSnapshot, info: { hermanListChanged: boolean }) => void;
}): ModelCatalogService {
  return new ModelCatalogService({
    getServerUrl: () => overrides?.serverUrl ?? SERVER,
    getToken: async () => "token",
    isHermanEnabled: () => overrides?.hermanEnabled ?? true,
    fetchImpl: overrides?.fetchImpl,
    catalogFilePath: () => catalogPath,
    legacyCacheFilePath: () => legacyPath,
    onChange: overrides?.onChange,
  });
}

function writeCatalogFile(contents: unknown): void {
  writeFileSync(catalogPath, JSON.stringify(contents));
}

function readCatalogFile(): Record<string, unknown> {
  return JSON.parse(readFileSync(catalogPath, "utf-8")) as Record<string, unknown>;
}

describe("ModelCatalogService.loadFromDisk", () => {
  it("seeds the catalog from the disk cache (instant, fromCache)", () => {
    writeCatalogFile({
      version: 1,
      serverUrl: SERVER,
      fetchedAt: "2024-01-01T00:00:00Z",
      herman: [{ id: "kimi", name: "Kimi", contextWindow: 200_000 }],
      custom: { openai: ["gpt-4o"] },
    });
    const service = createService();

    service.loadFromDisk();
    const snapshot = service.getSnapshot();

    expect(snapshot.models).toEqual(["herman/kimi", "openai/gpt-4o"]);
    expect(snapshot.hermanFromCache).toBe(true);
    expect(snapshot.fetchedAt).toBe("2024-01-01T00:00:00Z");
    expect(snapshot.modelMetadata["herman/kimi"]).toEqual({ contextWindow: 200_000 });
  });

  it("ignores the herman section cached from a different server", () => {
    writeCatalogFile({
      version: 1,
      serverUrl: "http://other-server",
      herman: [{ id: "kimi" }],
      custom: { openai: ["gpt-4o"] },
    });
    const service = createService();

    service.loadFromDisk();
    const snapshot = service.getSnapshot();

    // Custom providers survive; stale herman models from another server do not.
    expect(snapshot.models).toEqual(["openai/gpt-4o"]);
  });

  it("migrates the legacy agent-extension cache when no catalog file exists", () => {
    writeFileSync(
      legacyPath,
      JSON.stringify({
        serverUrl: SERVER,
        fetchedAt: "2024-01-01T00:00:00Z",
        models: [{ id: "legacy-model" }],
      }),
    );
    const service = createService();

    service.loadFromDisk();

    expect(service.getSnapshot().models).toEqual(["herman/legacy-model"]);
  });

  it("treats a corrupt catalog file as empty without throwing", () => {
    writeFileSync(catalogPath, "{not json");
    const service = createService();

    expect(() => service.loadFromDisk()).not.toThrow();
    expect(service.getSnapshot().models).toEqual([]);
  });
});

describe("ModelCatalogService.refresh", () => {
  it("fetches models and persists them to disk", async () => {
    const { fetchImpl, calls } = mockFetch([
      { ok: true, models: [{ id: "kimi", contextWindow: 256_000 }] },
    ]);
    const service = createService({ fetchImpl });

    const { snapshot, hermanListChanged } = await service.refresh();

    expect(calls).toEqual([`${SERVER}/api/agent/models`]);
    expect(hermanListChanged).toBe(true);
    expect(snapshot.models).toEqual(["herman/kimi"]);
    expect(snapshot.hermanFromCache).toBe(false);
    const file = readCatalogFile();
    expect((file.herman as { id: string }[]).map((m) => m.id)).toEqual(["kimi"]);
    expect(file.serverUrl).toBe(SERVER);
  });

  it("never removes cached models when the server errors", async () => {
    const { fetchImpl } = mockFetch([
      { ok: true, models: [{ id: "kimi" }] },
      { ok: false, status: 500 },
    ]);
    const service = createService({ fetchImpl });

    await service.refresh();
    const diskAfterSuccess = readFileSync(catalogPath, "utf-8");

    const { snapshot } = await service.refresh();

    // In-memory and on-disk state survive the failed refresh, byte-identical.
    expect(snapshot.models).toEqual(["herman/kimi"]);
    expect(readFileSync(catalogPath, "utf-8")).toBe(diskAfterSuccess);
  });

  it("keeps serving the disk cache when the server is unreachable after a restart", async () => {
    // Simulate: previous run cached models; new process starts offline.
    writeCatalogFile({
      version: 1,
      serverUrl: SERVER,
      fetchedAt: "2024-01-01T00:00:00Z",
      herman: [{ id: "cached-model" }],
      custom: {},
    });
    const { fetchImpl } = mockFetch([{ throws: true }]);
    const service = createService({ fetchImpl });

    service.loadFromDisk();
    const { snapshot } = await service.refresh();

    expect(snapshot.models).toEqual(["herman/cached-model"]);
    expect(snapshot.hermanFromCache).toBe(true);
  });

  it("treats an empty server model list as an error and keeps the cache", async () => {
    writeCatalogFile({
      version: 1,
      serverUrl: SERVER,
      fetchedAt: "2024-01-01T00:00:00Z",
      herman: [{ id: "cached-model" }],
      custom: {},
    });
    const { fetchImpl } = mockFetch([{ ok: true, models: [] }]);
    const service = createService({ fetchImpl });

    service.loadFromDisk();
    const { snapshot } = await service.refresh();

    expect(snapshot.models).toEqual(["herman/cached-model"]);
    expect((readCatalogFile().herman as { id: string }[])[0]?.id).toBe("cached-model");
  });

  it("reports hermanListChanged=false when the list is unchanged", async () => {
    const { fetchImpl } = mockFetch([
      { ok: true, models: [{ id: "kimi" }] },
      { ok: true, models: [{ id: "kimi" }] },
    ]);
    const service = createService({ fetchImpl });

    await service.refresh();
    const second = await service.refresh();

    expect(second.hermanListChanged).toBe(false);
  });

  it("does not fetch when the herman provider is disabled", async () => {
    const { fetchImpl, calls } = mockFetch([{ ok: true, models: [{ id: "kimi" }] }]);
    const service = createService({ fetchImpl, hermanEnabled: false });

    const { snapshot } = await service.refresh();

    expect(calls).toEqual([]);
    expect(snapshot.models).toEqual([]);
  });
});

describe("ModelCatalogService.ingestAgentModels", () => {
  it("merges custom-provider models and persists them", () => {
    const service = createService();

    service.ingestAgentModels(
      ["herman/kimi", "openai/gpt-4o", "openai/gpt-4o-mini"],
      { "openai/gpt-4o": { contextWindow: 128_000 } },
    );
    const snapshot = service.getSnapshot();

    // herman entries from agents are ignored — the server list owns herman.
    expect(snapshot.models).toEqual(["openai/gpt-4o", "openai/gpt-4o-mini"]);
    expect(snapshot.modelMetadata["openai/gpt-4o"]).toEqual({ contextWindow: 128_000 });
    expect((readCatalogFile().custom as Record<string, string[]>).openai).toEqual([
      "gpt-4o",
      "gpt-4o-mini",
    ]);
  });

  it("is idempotent — no change event when nothing new arrived", () => {
    const changes: ModelCatalogSnapshot[] = [];
    const service = createService({ onChange: (snapshot) => changes.push(snapshot) });

    service.ingestAgentModels(["openai/gpt-4o"]);
    service.ingestAgentModels(["openai/gpt-4o"]);

    expect(changes).toHaveLength(1);
  });

  it("round-trips custom models through a restart (disk)", () => {
    const first = createService();
    first.ingestAgentModels(["openai/gpt-4o"]);

    const second = createService();
    second.loadFromDisk();

    expect(second.getSnapshot().models).toEqual(["openai/gpt-4o"]);
  });
});

describe("ModelCatalogService change notifications", () => {
  it("emits on refresh only when the snapshot actually changes", async () => {
    const changes: ModelCatalogSnapshot[] = [];
    const { fetchImpl } = mockFetch([
      { ok: true, models: [{ id: "kimi" }] },
      { ok: true, models: [{ id: "kimi" }] },
    ]);
    const service = createService({ fetchImpl, onChange: (s) => changes.push(s) });

    await service.refresh();
    await service.refresh();

    expect(changes).toHaveLength(1);
  });

  it("excludes herman models from the snapshot when the provider is disabled", () => {
    writeCatalogFile({
      version: 1,
      serverUrl: SERVER,
      herman: [{ id: "kimi" }],
      custom: { openai: ["gpt-4o"] },
    });
    const service = createService({ hermanEnabled: false });

    service.loadFromDisk();

    expect(service.getSnapshot().models).toEqual(["openai/gpt-4o"]);
  });

  it("pushes an updated catalog when the provider is toggled off", async () => {
    let enabled = true;
    const changes: ModelCatalogSnapshot[] = [];
    const { fetchImpl } = mockFetch([{ ok: true, models: [{ id: "kimi" }] }]);
    const service = new ModelCatalogService({
      getServerUrl: () => SERVER,
      getToken: async () => "token",
      isHermanEnabled: () => enabled,
      fetchImpl,
      catalogFilePath: () => catalogPath,
      legacyCacheFilePath: () => legacyPath,
      onChange: (snapshot) => changes.push(snapshot),
    });

    await service.refresh();
    expect(changes.at(-1)?.models).toEqual(["herman/kimi"]);

    // Disable the provider and refresh again — herman models drop out and the
    // change is pushed, even though no fetch happened.
    enabled = false;
    await service.refresh();

    expect(changes.at(-1)?.models).toEqual([]);
    // The disk cache is untouched — re-enabling restores the list instantly.
    expect((readCatalogFile().herman as { id: string }[])[0]?.id).toBe("kimi");
  });
});
