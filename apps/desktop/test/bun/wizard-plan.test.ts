import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  extractRouteInventory,
  parsePlanMilestones,
  validateDesignOutputs,
  validatePlanStructure,
  WIZARD_DESIGN_FILENAME,
} from "../../src/bun/wizard-plan.js";
import { createTestTempDir, removeTestTempDir } from "../helpers/temp-dir.js";

function validMilestone(n: number, title: string, extras = ""): string {
  return (
    `## Milestone ${n}: ${title}\n` +
    `- [ ] Do the ${title.toLowerCase()} work\n` +
    `Acceptance: ${title} is usable end-to-end.\n` +
    extras
  );
}

function validTwoMilestonePlan(): string {
  return (
    `# Interview digest\n\nSome preamble before milestones.\n\n` +
    validMilestone(1, "Setup") +
    `\n` +
    validMilestone(2, "Polish")
  );
}

describe("WIZARD_DESIGN_FILENAME", () => {
  it("is HERMAN_DESIGN.md", () => {
    expect(WIZARD_DESIGN_FILENAME).toBe("HERMAN_DESIGN.md");
  });
});

describe("parsePlanMilestones", () => {
  it("splits on ## Milestone N: headings and ignores preamble", () => {
    const plan = validTwoMilestonePlan();
    const milestones = parsePlanMilestones(plan);

    expect(milestones).toHaveLength(2);
    expect(milestones[0]).toMatchObject({
      index: 0,
      title: "Setup",
    });
    expect(milestones[0]?.body).toMatch(/^## Milestone 1: Setup\n/);
    expect(milestones[0]?.body).toContain("- [ ] Do the setup work");
    expect(milestones[0]?.body).not.toContain("## Milestone 2:");

    expect(milestones[1]).toMatchObject({
      index: 1,
      title: "Polish",
    });
    expect(milestones[1]?.body).toMatch(/^## Milestone 2: Polish\n/);
    expect(milestones[1]?.body).toContain("Acceptance: Polish is usable");
  });

  it("returns an empty array when there are no milestone headings", () => {
    expect(parsePlanMilestones("# Just a plan\n\n- [ ] task\n")).toEqual([]);
  });

  it("uses 0-based index regardless of the heading numbers", () => {
    const plan = `${validMilestone(3, "Third-labeled")}\n${validMilestone(9, "Ninth-labeled")}`;
    const milestones = parsePlanMilestones(plan);
    expect(milestones.map((m) => m.index)).toEqual([0, 1]);
    expect(milestones.map((m) => m.title)).toEqual(["Third-labeled", "Ninth-labeled"]);
  });

  it("does not treat ## headings inside code fences as milestones", () => {
    const plan = [
      "## Milestone 1: Setup",
      "- [ ] Install deps",
      "Acceptance: app boots.",
      "",
      "Example markdown in a fence:",
      "```md",
      "## Not a milestone",
      "## Heading inside fence",
      "- [ ] fake checkbox",
      "```",
      "",
      "## Milestone 2: Features",
      "- [ ] Build features",
      "**Acceptance criteria**",
      "- Home page renders",
      "",
    ].join("\n");

    const milestones = parsePlanMilestones(plan);
    expect(milestones).toHaveLength(2);
    expect(milestones[0]?.title).toBe("Setup");
    expect(milestones[0]?.body).toContain("## Not a milestone");
    expect(milestones[0]?.body).toContain("```md");
    expect(milestones[1]?.title).toBe("Features");
    expect(milestones[1]?.body).toContain("**Acceptance criteria**");
  });

  it("keeps milestone body content that includes indented ##-looking text", () => {
    const plan = [
      "## Milestone 1: Docs",
      "- [ ] Write README",
      "Acceptance: README explains setup.",
      "  ## this indented line is not a milestone",
      "",
      "## Milestone 2: Ship",
      "- [ ] Deploy",
      "Acceptance: deploy succeeds.",
      "",
    ].join("\n");

    const milestones = parsePlanMilestones(plan);
    expect(milestones).toHaveLength(2);
    expect(milestones[0]?.body).toContain("  ## this indented line is not a milestone");
  });
});

describe("validatePlanStructure", () => {
  it("returns undefined for a valid 2–8 milestone plan", () => {
    expect(validatePlanStructure(validTwoMilestonePlan())).toBeUndefined();
  });

  it("rejects fewer than 2 milestones", () => {
    const plan = validMilestone(1, "Only one");
    expect(validatePlanStructure(plan)).toMatch(/between 2 and 8 milestones/i);
    expect(validatePlanStructure(plan)).toMatch(/Found 1/);
  });

  it("rejects more than 8 milestones", () => {
    const plan = Array.from({ length: 9 }, (_, i) => validMilestone(i + 1, `M${i + 1}`)).join("\n");
    expect(validatePlanStructure(plan)).toMatch(/between 2 and 8 milestones/i);
    expect(validatePlanStructure(plan)).toMatch(/Found 9/);
  });

  it("rejects a milestone with no unchecked checkboxes", () => {
    const plan = [
      "## Milestone 1: Setup",
      "- [x] Already done (checked only)",
      "Acceptance: boots.",
      "",
      "## Milestone 2: Build",
      "- [ ] Real task",
      "Acceptance: works.",
      "",
    ].join("\n");

    const error = validatePlanStructure(plan);
    expect(error).toMatch(/no unchecked task checkboxes/i);
    expect(error).toMatch(/Setup/);
  });

  it("rejects a milestone missing an acceptance block", () => {
    const plan = [
      "## Milestone 1: Setup",
      "- [ ] Install",
      "",
      "## Milestone 2: Build",
      "- [ ] Code",
      "Acceptance: pages load.",
      "",
    ].join("\n");

    const error = validatePlanStructure(plan);
    expect(error).toMatch(/missing an Acceptance/i);
    expect(error).toMatch(/Setup/);
  });

  it("accepts **Acceptance criteria** as the acceptance marker", () => {
    const plan = [
      "## Milestone 1: Setup",
      "- [ ] Install",
      "**Acceptance criteria**",
      "- Server starts",
      "",
      "## Milestone 2: Build",
      "- [ ] Features",
      "Acceptance: features work.",
      "",
    ].join("\n");

    expect(validatePlanStructure(plan)).toBeUndefined();
  });

  it("accepts case-insensitive acceptance wording", () => {
    const plan = [
      "## Milestone 1: Setup",
      "- [ ] Install",
      "acceptance criteria for setup",
      "",
      "## Milestone 2: Build",
      "- [ ] Features",
      "ACCEPTANCE: done",
      "",
    ].join("\n");

    expect(validatePlanStructure(plan)).toBeUndefined();
  });
});

describe("extractRouteInventory", () => {
  it("extracts unique routes from the Page inventory section", () => {
    const design = [
      "# Design",
      "",
      "## Design tokens",
      "- color: #111",
      "",
      "## Page inventory",
      "- `/` — Home: landing page",
      "  - empty: welcome CTA",
      "- `/posts` — Posts list",
      "* `/posts/:id` — Post detail",
      "- `/posts` — duplicate ignored",
      "- not a route",
      "- `posts` — missing leading slash, ignored",
      "",
      "## Layout system",
      "- `/should-not-appear` — outside inventory",
      "",
    ].join("\n");

    expect(extractRouteInventory(design)).toEqual(["/", "/posts", "/posts/:id"]);
  });

  it("returns [] when the Page inventory section is missing", () => {
    expect(extractRouteInventory("# Design\n\n## Design tokens\n")).toEqual([]);
  });

  it("returns [] when the section has no matching route lines", () => {
    const design = ["## Page inventory", "- Home page (no backticks)", ""].join("\n");
    expect(extractRouteInventory(design)).toEqual([]);
  });
});

describe("validateDesignOutputs", () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) removeTestTempDir(tempDir);
  });

  function writeProject(files: Record<string, string>): {
    projectPath: string;
    designPath: string;
    planPath: string;
  } {
    tempDir = createTestTempDir("herman-wizard-plan-");
    const designPath = join(tempDir, WIZARD_DESIGN_FILENAME);
    const planPath = join(tempDir, "HERMAN_PLAN.md");
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(tempDir, name), content);
    }
    return { projectPath: tempDir, designPath, planPath };
  }

  const goodDesign = ["## Page inventory", "- `/` — Home: landing", "- `/about` — About", ""].join(
    "\n",
  );

  it("rejects missing projectPath", () => {
    expect(validateDesignOutputs("", "/tmp/x/HERMAN_DESIGN.md", "/tmp/x/HERMAN_PLAN.md")).toMatch(
      /projectPath is missing/,
    );
  });

  it("rejects a missing project directory", () => {
    expect(
      validateDesignOutputs("/tmp/herman-no-such-project", "/tmp/x/d.md", "/tmp/x/p.md"),
    ).toMatch(/does not exist/);
  });

  it("rejects a missing design file", () => {
    const { projectPath, designPath, planPath } = writeProject({
      "HERMAN_PLAN.md": validTwoMilestonePlan(),
    });
    expect(validateDesignOutputs(projectPath, designPath, planPath)).toMatch(
      /design file not found/,
    );
  });

  it("rejects a missing plan file", () => {
    const { projectPath, designPath, planPath } = writeProject({
      [WIZARD_DESIGN_FILENAME]: goodDesign,
    });
    expect(validateDesignOutputs(projectPath, designPath, planPath)).toMatch(/plan file not found/);
  });

  it("rejects plans that fail structure validation", () => {
    const { projectPath, designPath, planPath } = writeProject({
      [WIZARD_DESIGN_FILENAME]: goodDesign,
      "HERMAN_PLAN.md": validMilestone(1, "Only one"),
    });
    expect(validateDesignOutputs(projectPath, designPath, planPath)).toMatch(
      /between 2 and 8 milestones/i,
    );
  });

  it("rejects designs with no Page inventory routes", () => {
    const { projectPath, designPath, planPath } = writeProject({
      [WIZARD_DESIGN_FILENAME]: "## Design tokens\n- color: red\n",
      "HERMAN_PLAN.md": validTwoMilestonePlan(),
    });
    expect(validateDesignOutputs(projectPath, designPath, planPath)).toMatch(
      /no Page inventory routes/i,
    );
  });

  it("accepts existing project with valid design and plan", () => {
    const { projectPath, designPath, planPath } = writeProject({
      [WIZARD_DESIGN_FILENAME]: goodDesign,
      "HERMAN_PLAN.md": validTwoMilestonePlan(),
    });
    expect(validateDesignOutputs(projectPath, designPath, planPath)).toBeUndefined();
  });

  it("rejects empty designPath", () => {
    tempDir = createTestTempDir("herman-wizard-plan-empty-design-");
    expect(validateDesignOutputs(tempDir, "", join(tempDir, "HERMAN_PLAN.md"))).toMatch(
      /designPath is missing/,
    );
  });

  it("rejects empty planPath", () => {
    const { projectPath, designPath } = writeProject({
      [WIZARD_DESIGN_FILENAME]: goodDesign,
    });
    expect(validateDesignOutputs(projectPath, designPath, "")).toMatch(/planPath is missing/);
  });
});
