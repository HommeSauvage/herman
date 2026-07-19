import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PlanMilestone } from "../../src/bun/wizard-plan.js";
import {
  buildCodingGoal,
  buildDesignGoal,
  buildDocsGoal,
  buildPlanningPrompt,
  buildQaGoal,
  DEFAULT_SETUP_GOAL,
  formatExportUrlContract,
  validatePlanningOutputs,
  WIZARD_DESIGN_FILENAME,
  WIZARD_PLAN_FILENAME,
} from "../../src/bun/wizard-session.js";
import type { ResolvedManifest } from "../../src/shared/herman-manifest.js";

function makeManifest(
  overrides: {
    frontmatter?: Partial<ResolvedManifest["frontmatter"]>;
    sections?: Partial<ResolvedManifest["sections"]>;
  } = {},
): ResolvedManifest {
  return {
    id: "blog",
    frontmatter: {
      version: 2,
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

function makeMilestone(overrides: Partial<PlanMilestone> = {}): PlanMilestone {
  return {
    index: 0,
    title: "Foundation",
    body: `## Milestone 1: Foundation
- [ ] Install deps
Acceptance: App boots
`,
    ...overrides,
  };
}

describe("buildPlanningPrompt", () => {
  it("instructs planning-only discovery digest and HERMAN_PLAN.md completion", () => {
    const prompt = buildPlanningPrompt(makeManifest(), "A cooking blog");

    expect(prompt).toContain("planning phase");
    expect(prompt).toContain("herman_wizard_ask");
    expect(prompt).toContain("herman_complete_planning");
    expect(prompt).toContain(WIZARD_PLAN_FILENAME);
    expect(prompt).toContain("PLANNING ONLY");
    expect(prompt).toContain("interview digest");
    expect(prompt).toContain("A cooking blog");
    expect(prompt).toContain("What topics do they write about?");
    expect(prompt).not.toContain("herman_complete_wizard");
    expect(prompt).not.toMatch(/Set up the project \(install deps/);
    expect(prompt).toContain("Do NOT write a complete checkbox task list");
  });

  it("includes setup as plan context without requiring execution", () => {
    const prompt = buildPlanningPrompt(makeManifest(), "Blog");
    expect(prompt).toContain("Setup (context for the plan — do not execute yet)");
    expect(prompt).toContain("Install deps with bun install");
  });
});

describe("buildDesignGoal", () => {
  it("requires design file, milestone plan rewrite, and herman_complete_design", () => {
    const goal = buildDesignGoal(makeManifest(), "/tmp/my-blog", "/tmp/my-blog/HERMAN_PLAN.md");
    expect(goal).toContain("design phase");
    expect(goal).toContain(WIZARD_DESIGN_FILENAME);
    expect(goal).toContain("## Page inventory");
    expect(goal).toContain("herman_complete_design");
    expect(goal).toContain("Do NOT install");
    expect(goal).toContain("Prefer simple content models.");
    expect(goal).toContain("Notes");
    expect(goal).not.toContain("herman_complete_wizard");
  });
});

describe("formatExportUrlContract", () => {
  it("returns empty when no exportUrlAs is declared", () => {
    expect(formatExportUrlContract(undefined)).toBe("");
    expect(
      formatExportUrlContract([
        { id: "web", label: "Web", command: "bun run dev", port: 3000, primary: true },
      ]),
    ).toBe("");
  });

  it("lists server ids and alias names", () => {
    const text = formatExportUrlContract([
      {
        id: "api",
        label: "API",
        command: "bun run dev:api",
        exportUrlAs: ["API_SERVER", "API_URL"],
      },
      { id: "web", label: "Web", command: "bun run dev:web", primary: true },
    ]);
    expect(text).toContain("exportUrlAs");
    expect(text).toContain("`api`");
    expect(text).toContain("`API_SERVER`");
    expect(text).toContain("`API_URL`");
    expect(text).toContain("do not hardcode");
  });
});

describe("buildCodingGoal", () => {
  it("scopes to one milestone and requires herman_complete_wizard", () => {
    const goal = buildCodingGoal(
      makeManifest(),
      "/tmp/my-blog",
      "/tmp/my-blog/HERMAN_PLAN.md",
      "/tmp/my-blog/HERMAN_DESIGN.md",
      makeMilestone(),
      0,
      2,
      [],
    );
    expect(goal).toContain("HERMAN WIZARD MODE");
    expect(goal).toContain("rookie");
    expect(goal).toContain("Do NOT call herman_wizard_ask");
    expect(goal).toContain("Homepage loads and posts list works");
    expect(goal).toContain("Milestone 1 of 2");
    expect(goal).toContain("ONLY this milestone");
    expect(goal).toContain("/tmp/my-blog/HERMAN_PLAN.md");
    expect(goal).toContain("/tmp/my-blog/HERMAN_DESIGN.md");
    expect(goal).toContain("Install deps with bun install");
    expect(goal).toContain("herman_complete_wizard");
  });

  it("falls back to the default setup goal when omitted", () => {
    const goal = buildCodingGoal(
      makeManifest({ frontmatter: { setup_goal: undefined } }),
      "/tmp/x",
      "/tmp/x/HERMAN_PLAN.md",
      "/tmp/x/HERMAN_DESIGN.md",
      makeMilestone(),
      0,
      1,
      [],
    );
    expect(goal).toContain(DEFAULT_SETUP_GOAL);
  });

  it("includes exportUrlAs contract when declared on servers", () => {
    const goal = buildCodingGoal(
      makeManifest({
        frontmatter: {
          servers: [
            {
              id: "api",
              label: "API",
              command: "bun run dev:api",
              exportUrlAs: "API_SERVER",
            },
            {
              id: "web",
              label: "Web",
              command: "bun run dev:web",
              primary: true,
            },
          ],
        },
      }),
      "/tmp/x",
      "/tmp/x/HERMAN_PLAN.md",
      "/tmp/x/HERMAN_DESIGN.md",
      makeMilestone(),
      0,
      1,
      [],
    );
    expect(goal).toContain("Preview URL env contract");
    expect(goal).toContain("API_SERVER");
  });

  it("includes the workspace setup recipe only on milestone 1", () => {
    const manifest = makeManifest({
      frontmatter: {
        env: {
          files: [
            {
              path: ".env",
              from_example: ".env.example",
              vars: { APP_KEY: { generate: "php artisan key:generate --show" } },
            },
          ],
        },
        setup: [{ id: "deps", label: "Installing dependencies", run: "composer install" }],
      },
    });
    const first = buildCodingGoal(
      manifest,
      "/tmp/x",
      "/tmp/x/HERMAN_PLAN.md",
      "/tmp/x/HERMAN_DESIGN.md",
      makeMilestone(),
      0,
      2,
      [],
    );
    expect(first).toContain("Workspace setup recipe");
    expect(first).toContain("composer install");
    expect(first).toContain(".env.example");
    expect(first).toContain("APP_KEY");

    const second = buildCodingGoal(
      manifest,
      "/tmp/x",
      "/tmp/x/HERMAN_PLAN.md",
      "/tmp/x/HERMAN_DESIGN.md",
      makeMilestone({ index: 1, title: "UI" }),
      1,
      2,
      ["Foundation done"],
    );
    expect(second).not.toContain("Workspace setup recipe");
    expect(second).toContain("Prior milestone summaries");
    expect(second).toContain("Foundation done");
  });
});

describe("buildQaGoal", () => {
  it("embeds plan, design, routes, and prior milestone summaries", () => {
    const goal = buildQaGoal({
      projectPath: "/tmp/my-blog",
      planPath: "/tmp/my-blog/HERMAN_PLAN.md",
      designPath: "/tmp/my-blog/HERMAN_DESIGN.md",
      milestoneSummaries: ["Installed deps and applied the blog name."],
      gateWarnings: [],
      previewUrl: "http://localhost:3000",
      routes: ["/", "/posts"],
    });
    expect(goal).toContain("Do NOT call herman_wizard_ask");
    expect(goal).toContain("/tmp/my-blog/HERMAN_PLAN.md");
    expect(goal).toContain("/tmp/my-blog/HERMAN_DESIGN.md");
    expect(goal).toContain("Installed deps and applied the blog name.");
    expect(goal).toContain("ALREADY RUNNING");
    expect(goal).toContain("http://localhost:3000");
    expect(goal).toContain("`/posts`");
    expect(goal).toContain("console errors");
    expect(goal).toContain("herman_complete_wizard");
  });

  it("includes exportUrlAs checklist when servers declare it", () => {
    const goal = buildQaGoal({
      projectPath: "/tmp/x",
      planPath: "/tmp/x/HERMAN_PLAN.md",
      designPath: "/tmp/x/HERMAN_DESIGN.md",
      milestoneSummaries: ["done"],
      gateWarnings: ["forced: lint skipped"],
      servers: [
        {
          id: "api",
          label: "API",
          command: "bun run dev:api",
          exportUrlAs: ["API_SERVER", "API_URL"],
        },
      ],
      routes: ["/"],
    });
    expect(goal).toContain("exportUrlAs");
    expect(goal).toContain("API_SERVER");
    expect(goal).toContain("hardcoded");
    expect(goal).toContain("forced: lint skipped");
  });
});

describe("buildDocsGoal", () => {
  it("embeds the project path, seeded docs, structure rules, and completion contract", () => {
    const goal = buildDocsGoal("/tmp/my-blog");
    expect(goal).toContain("Do NOT call herman_wizard_ask");
    expect(goal).toContain("/tmp/my-blog");
    expect(goal).toContain("herman-docs");
    expect(goal).toContain("notions-and-terminology.md");
    expect(goal).toContain("herman-agent-quickstart.md");
    expect(goal).toContain("database.md");
    expect(goal).toContain("01-start-here.md");
    expect(goal).toContain("herman_complete_wizard");
    // Seeds may only be renamed to add a 2-digit ordering prefix.
    expect(goal).toContain("RENAME seeded files only to add a 2-digit ordering prefix");
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
      expect(validatePlanningOutputs(dir, join(dir, WIZARD_PLAN_FILENAME))).toMatch(
        /plan file not found/,
      );
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
