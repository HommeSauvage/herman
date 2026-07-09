import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearHermantAppDir,
  createTestTempDir,
  setHermantAppDir,
} from "../helpers/temp-dir.js";

let tempDir: string;

beforeEach(() => {
  tempDir = createTestTempDir("herman-tab-history-");
  setHermantAppDir(tempDir);
});

afterEach(() => {
  clearHermantAppDir(tempDir);
});

async function importTabHistory() {
  return import("../../src/bun/tab-history.js");
}

describe("saveTabHistory / loadTabHistory", () => {
  it("round-trips messages", async () => {
    const { saveTabHistory, loadTabHistory } = await importTabHistory();
    const messages = [
      { id: "m1", role: "user" as const, content: "hello" },
      { id: "m2", role: "assistant" as const, content: "hi there" },
    ];

    await saveTabHistory("tab-1", messages);
    const loaded = await loadTabHistory("tab-1");

    expect(loaded).toEqual(messages);
  });

  it("round-trips extended cache metadata", async () => {
    const { saveTabHistory, loadTabHistoryCache } = await importTabHistory();
    const messages = [{ id: "m1", role: "user" as const, content: "hello" }];
    await saveTabHistory("tab-1", messages, {
      piSessionId: "sess-1",
      contextStats: {
        totalTokens: 10,
        inputTokens: 5,
        outputTokens: 5,
        reasoningTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCost: 0,
        contextLimit: 1000,
        messageCount: 1,
        userMessageCount: 1,
        assistantMessageCount: 0,
        toolMessageCount: 0,
        updatedAt: 1,
      },
    });

    const cache = await loadTabHistoryCache("tab-1");
    expect(cache?.messages).toEqual(messages);
    expect(cache?.piSessionId).toBe("sess-1");
    expect(cache?.contextStats?.totalTokens).toBe(10);
  });

  it("overwrites existing history", async () => {
    const { saveTabHistory, loadTabHistory } = await importTabHistory();
    const first = [{ id: "m1", role: "user" as const, content: "first" }];
    const second = [{ id: "m2", role: "user" as const, content: "second" }];

    await saveTabHistory("tab-1", first);
    await saveTabHistory("tab-1", second);

    const loaded = await loadTabHistory("tab-1");
    expect(loaded).toEqual(second);
  });
});

describe("loadTabHistory", () => {
  it("returns an empty array when the file is missing", async () => {
    const { loadTabHistory } = await importTabHistory();
    const loaded = await loadTabHistory("missing-tab");
    expect(loaded).toEqual([]);
  });
});

describe("deleteTabHistory", () => {
  it("removes the persisted history file", async () => {
    const { saveTabHistory, loadTabHistory, deleteTabHistory } = await importTabHistory();
    await saveTabHistory("tab-1", [{ id: "m1", role: "user" as const, content: "hello" }]);
    await deleteTabHistory("tab-1");

    const loaded = await loadTabHistory("tab-1");
    expect(loaded).toEqual([]);
  });

  it("does not throw when the file is missing", async () => {
    const { deleteTabHistory } = await importTabHistory();
    await expect(deleteTabHistory("missing-tab")).resolves.toBeUndefined();
  });
});
