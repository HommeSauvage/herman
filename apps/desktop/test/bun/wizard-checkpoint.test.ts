import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  clearHermantAppDir,
  createTestTempDir,
  setHermantAppDir,
} from "../helpers/temp-dir.js";
import {
  clearWizardCheckpoint,
  evaluateWizardCheckpoint,
  loadWizardCheckpoint,
  saveWizardCheckpoint,
  type WizardCheckpoint,
} from "../../src/bun/wizard-checkpoint.js";

let tempDir: string;

beforeEach(() => {
  tempDir = createTestTempDir("herman-wizard-checkpoint-");
  setHermantAppDir(tempDir);
});

afterEach(async () => {
  await clearWizardCheckpoint();
  clearHermantAppDir(tempDir);
});

function baseCheckpoint(overrides: Partial<WizardCheckpoint> = {}): WizardCheckpoint {
  return {
    id: "wizard-1",
    templateId: "blog",
    description: "A cooking blog",
    phase: "coding",
    capturedPiSessionId: "pi-sess-1",
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe("wizard-checkpoint", () => {
  it("round-trips save and load", async () => {
    const checkpoint = baseCheckpoint({
      projectPath: join(tempDir, "my-blog"),
      progressLines: ["Reading: README.md"],
      lastError: "timed out",
    });
    await saveWizardCheckpoint(checkpoint);
    const loaded = await loadWizardCheckpoint();
    expect(loaded).toMatchObject({
      id: "wizard-1",
      templateId: "blog",
      phase: "coding",
      capturedPiSessionId: "pi-sess-1",
      lastError: "timed out",
      progressLines: ["Reading: README.md"],
    });
  });

  it("clearWizardCheckpoint removes the file", async () => {
    await saveWizardCheckpoint(baseCheckpoint());
    expect(await loadWizardCheckpoint()).not.toBeNull();
    await clearWizardCheckpoint();
    expect(await loadWizardCheckpoint()).toBeNull();
  });

  it("evaluateWizardCheckpoint requires pi session id", () => {
    const result = evaluateWizardCheckpoint(
      baseCheckpoint({ capturedPiSessionId: undefined }),
    );
    expect(result.resumable).toBe(false);
    expect(result.reason).toMatch(/pi session/i);
  });

  it("evaluateWizardCheckpoint rejects missing project folder for coding", () => {
    const result = evaluateWizardCheckpoint(
      baseCheckpoint({ projectPath: join(tempDir, "missing-project") }),
    );
    expect(result.resumable).toBe(false);
    expect(result.reason).toMatch(/no longer exists/i);
  });

  it("evaluateWizardCheckpoint accepts coding phase with existing project", () => {
    const projectPath = join(tempDir, "ok-blog");
    mkdirSync(projectPath, { recursive: true });
    writeFileSync(join(projectPath, "HERMAN_PLAN.md"), "- [ ] x\n");
    const result = evaluateWizardCheckpoint(baseCheckpoint({ projectPath }));
    expect(result.resumable).toBe(true);
  });

  it("evaluateWizardCheckpoint accepts planning with pi session only", () => {
    const result = evaluateWizardCheckpoint(
      baseCheckpoint({ phase: "planning", projectPath: undefined }),
    );
    expect(result.resumable).toBe(true);
  });
});
