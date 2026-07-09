import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearHermantAppDir,
  createTestTempDir,
  setHermantAppDir,
} from "../helpers/temp-dir.js";

let tempDir: string;

beforeEach(() => {
  tempDir = createTestTempDir("herman-composer-drafts-");
  setHermantAppDir(tempDir);
});

afterEach(() => {
  clearHermantAppDir(tempDir);
});

async function importComposerDrafts() {
  return import("../../src/bun/composer-drafts.js");
}

describe("saveComposerDraft / loadComposerDraft", () => {
  it("round-trips drafts", async () => {
    const { saveComposerDraft, loadComposerDraft } = await importComposerDrafts();

    await saveComposerDraft("tab-1", "hello world");
    const loaded = await loadComposerDraft("tab-1");

    expect(loaded).toBe("hello world");
  });

  it("overwrites existing drafts", async () => {
    const { saveComposerDraft, loadComposerDraft } = await importComposerDrafts();

    await saveComposerDraft("tab-1", "first");
    await saveComposerDraft("tab-1", "second");

    const loaded = await loadComposerDraft("tab-1");
    expect(loaded).toBe("second");
  });

  it("persists multiline drafts", async () => {
    const { saveComposerDraft, loadComposerDraft } = await importComposerDrafts();
    const draft = "line one\nline two\nline three";

    await saveComposerDraft("tab-1", draft);
    const loaded = await loadComposerDraft("tab-1");

    expect(loaded).toBe(draft);
  });
});

describe("loadComposerDraft", () => {
  it("returns an empty string when the file is missing", async () => {
    const { loadComposerDraft } = await importComposerDrafts();
    const loaded = await loadComposerDraft("missing-tab");
    expect(loaded).toBe("");
  });
});

describe("deleteComposerDraft", () => {
  it("removes the persisted draft file", async () => {
    const { saveComposerDraft, loadComposerDraft, deleteComposerDraft } =
      await importComposerDrafts();
    await saveComposerDraft("tab-1", "hello");
    await deleteComposerDraft("tab-1");

    const loaded = await loadComposerDraft("tab-1");
    expect(loaded).toBe("");
  });

  it("does not throw when the file is missing", async () => {
    const { deleteComposerDraft } = await importComposerDrafts();
    await expect(deleteComposerDraft("missing-tab")).resolves.toBeUndefined();
  });
});

describe("clearAllComposerDrafts", () => {
  it("removes all draft files", async () => {
    const { saveComposerDraft, loadComposerDraft, clearAllComposerDrafts } =
      await importComposerDrafts();
    await saveComposerDraft("tab-1", "one");
    await saveComposerDraft("tab-2", "two");

    await clearAllComposerDrafts();

    expect(await loadComposerDraft("tab-1")).toBe("");
    expect(await loadComposerDraft("tab-2")).toBe("");
  });
});
