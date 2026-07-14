import { describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ResolvedManifest } from "../../src/shared/herman-manifest.js";
import {
  buildCodingGoal,
  buildPlanningPrompt,
  buildQaGoal,
  DEFAULT_SETUP_GOAL,
  validatePlanningOutputs,
  WIZARD_PLAN_FILENAME,
} from "../../src/bun/wizard-session.js";

function makeManifest(
  overrides: {
    frontmatter?: Partial<ResolvedManifest["frontmatter"]>;
    sections?: Partial<ResolvedManifest["sections"]>;
  } = {},
): ResolvedManifest {
  return {
    id: "blog",
    frontmatter: {
      version: 1,
      name: "Blog",
      description: "A personal blog",
      source: { repo: "https://github.com/example/blog.git", ref: "main" },
      setup_goal: "Homepage loads and posts list works",
      ...overrides.frontmatter,
    },
    sections: {
      setup: "Install deps with bun install. Run migrations.",
      questions: "- What topics do they write about?",
      guidance: "Prefer simple content models.",
      ...overrides.sections,
    },
    serialized: "",
  };
}

describe("buildPlanningPrompt", () => {
  it("instructs planning-only work and HERMAN_PLAN.md completion", () => {
    const prompt = buildPlanningPrompt(makeManifest(), "A cooking blog");

    expect(prompt).toContain("planning phase");
    expect(prompt).toContain("herman_wizard_ask");
    expect(prompt).toContain("herman_complete_planning");
    expect(prompt).toContain(WIZARD_PLAN_FILENAME);
    expect(prompt).toContain("PLANNING ONLY");
    expect(prompt).toContain("A cooking blog");
    expect(prompt).toContain("What topics do they write about?");
    expect(prompt).not.toContain("herman_complete_wizard");
    expect(prompt).not.toMatch(/Set up the project \(install deps/);
  });

  it("includes setup as plan context without requiring execution", () => {
    const prompt = buildPlanningPrompt(makeManifest(), "Blog");
    expect(prompt).toContain("Setup (context for the plan — do not execute yet)");
    expect(prompt).toContain("Install deps with bun install");
  });
});

describe("buildCodingGoal", () => {
  it("includes framing, setup_goal, setup section, and tick-all-boxes rule in one goal", () => {
    const goal = buildCodingGoal(
      makeManifest(),
      "/tmp/my-blog",
      "/tmp/my-blog/HERMAN_PLAN.md",
    );
    expect(goal).toContain("HERMAN WIZARD MODE");
    expect(goal).toContain("rookie");
    expect(goal).toContain("Do NOT call herman_wizard_ask");
    expect(goal).toContain("Homepage loads and posts list works");
    expect(goal).toContain("all the checkboxes in the plan are ticked");
    expect(goal).toContain("/tmp/my-blog/HERMAN_PLAN.md");
    expect(goal).toContain("Install deps with bun install");
    expect(goal).toContain("AGENTS.md");
    expect(goal).toContain("herman_complete_wizard");
  });

  it("falls back to the default setup goal when omitted", () => {
    const goal = buildCodingGoal(
      makeManifest({ frontmatter: { setup_goal: undefined } }),
      "/tmp/x",
      "/tmp/x/HERMAN_PLAN.md",
    );
    expect(goal).toContain(DEFAULT_SETUP_GOAL);
  });
});

describe("buildQaGoal", () => {
  it("embeds the plan path and prior coding summary", () => {
    const goal = buildQaGoal(
      "/tmp/my-blog",
      "/tmp/my-blog/HERMAN_PLAN.md",
      "Installed deps and applied the blog name.",
    );
    expect(goal).toContain("Do NOT call herman_wizard_ask");
    expect(goal).toContain("/tmp/my-blog/HERMAN_PLAN.md");
    expect(goal).toContain("Installed deps and applied the blog name.");
    expect(goal).toContain("Start the server and navigate the website");
    expect(goal).toContain("console errors");
    expect(goal).toContain("herman_complete_wizard");
  });
});

describe("validatePlanningOutputs", () => {
  it("rejects missing project path", () => {
    expect(validatePlanningOutputs("", "/tmp/x/HERMAN_PLAN.md")).toMatch(/projectPath is missing/);
  });

  it("rejects missing project directory", () => {
    expect(validatePlanningOutputs("/tmp/herman-no-such-project", "/tmp/x/HERMAN_PLAN.md")).toMatch(
      /does not exist/,
    );
  });

  it("rejects missing plan file", () => {
    const dir = join(tmpdir(), `herman-wizard-validate-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    try {
      expect(validatePlanningOutputs(dir, join(dir, WIZARD_PLAN_FILENAME))).toMatch(/plan file not found/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts existing project dir and plan file", () => {
    const dir = join(tmpdir(), `herman-wizard-validate-ok-${Date.now()}`);
    const plan = join(dir, WIZARD_PLAN_FILENAME);
    mkdirSync(dir, { recursive: true });
    writeFileSync(plan, "- [ ] do the thing\n");
    try {
      expect(validatePlanningOutputs(dir, plan)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
