import { existsSync, readFileSync } from "node:fs";

/** Design spec written by the design phase; coding/QA consume it. */
export const WIZARD_DESIGN_FILENAME = "HERMAN_DESIGN.md";

export type PlanMilestone = {
  index: number;
  title: string;
  /** Full markdown including the `## Milestone N:` heading. */
  body: string;
};

const MILESTONE_HEADING_RE = /^## Milestone \d+:[^\n]*/gm;
const MILESTONE_TITLE_RE = /^## Milestone \d+:\s*(.*)$/;
const UNCHECKED_CHECKBOX_RE = /(^|\n)\s*-\s*\[\s\]\s+/;
const ACCEPTANCE_RE = /acceptance/i;
const PAGE_INVENTORY_HEADING_RE = /^## Page inventory\s*$/im;
const ROUTE_LINE_RE = /^[-*] `(\/[^\s`]*)`/;

/**
 * Split a milestone-sectioned HERMAN_PLAN.md into milestones.
 * Content before the first `## Milestone N:` heading is ignored (preamble).
 * `index` is 0-based; `title` is the text after `## Milestone N: `;
 * `body` includes the heading line through the line before the next milestone.
 */
export function parsePlanMilestones(planMd: string): PlanMilestone[] {
  const normalized = planMd.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const matches: { start: number; endOfHeading: number; headingLine: string }[] = [];
  for (const match of normalized.matchAll(MILESTONE_HEADING_RE)) {
    matches.push({
      start: match.index,
      endOfHeading: match.index + match[0].length,
      headingLine: match[0],
    });
  }

  return matches.map((m, index) => {
    const nextStart = matches[index + 1]?.start ?? normalized.length;
    const body = normalized.slice(m.start, nextStart).replace(/\n+$/, "\n");
    const titleMatch = m.headingLine.match(MILESTONE_TITLE_RE);
    const title = (titleMatch?.[1] ?? "").trim();
    return { index, title, body };
  });
}

/**
 * Validate milestone plan structure. Returns undefined when ok, or corrective
 * text for the model when the plan should be rejected.
 */
export function validatePlanStructure(planMd: string): string | undefined {
  const milestones = parsePlanMilestones(planMd);
  if (milestones.length < 2 || milestones.length > 8) {
    return (
      `Plan structure invalid: HERMAN_PLAN.md must have between 2 and 8 milestones ` +
      `(## Milestone N: …). Found ${milestones.length}. Rewrite the plan with ` +
      `milestone sections, then call herman_complete_design again.`
    );
  }

  for (const milestone of milestones) {
    if (!UNCHECKED_CHECKBOX_RE.test(milestone.body)) {
      return (
        `Plan structure invalid: Milestone "${milestone.title || milestone.index + 1}" ` +
        `has no unchecked task checkboxes (\`- [ ]\`). Add checkbox tasks, then call ` +
        `herman_complete_design again.`
      );
    }
    if (!ACCEPTANCE_RE.test(milestone.body)) {
      return (
        `Plan structure invalid: Milestone "${milestone.title || milestone.index + 1}" ` +
        `is missing an Acceptance / Acceptance criteria block. Add one (e.g. ` +
        `"Acceptance:" or "**Acceptance criteria**"), then call herman_complete_design again.`
      );
    }
  }

  return undefined;
}

/**
 * Parse routes from the `## Page inventory` section of HERMAN_DESIGN.md.
 * Lines must match `- \`/route\`` or `* \`/route\`` at the start of the line.
 * Returns unique routes in first-seen order; [] when the section is missing.
 */
export function extractRouteInventory(designMd: string): string[] {
  const normalized = designMd.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const headingMatch = PAGE_INVENTORY_HEADING_RE.exec(normalized);
  if (!headingMatch) return [];

  const sectionStart = headingMatch.index + headingMatch[0].length;
  const rest = normalized.slice(sectionStart);
  const nextHeading = rest.search(/^## /m);
  const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);

  const routes: string[] = [];
  const seen = new Set<string>();
  for (const line of section.split("\n")) {
    const routeMatch = line.match(ROUTE_LINE_RE);
    if (!routeMatch) continue;
    const route = routeMatch[1];
    if (seen.has(route)) continue;
    seen.add(route);
    routes.push(route);
  }
  return routes;
}

/**
 * Validate design-phase outputs before advancing to coding.
 * Returns undefined when ok, or corrective text (same style as validatePlanningOutputs).
 */
export function validateDesignOutputs(
  projectPath: string,
  designPath: string,
  planPath: string,
): string | undefined {
  if (!projectPath) {
    return (
      "Design incomplete: projectPath is missing. Write HERMAN_DESIGN.md and " +
      "HERMAN_PLAN.md, then call herman_complete_design again."
    );
  }
  if (!existsSync(projectPath)) {
    return (
      `Design incomplete: project path does not exist (${projectPath}). ` +
      `Fix the path, then call herman_complete_design again.`
    );
  }
  if (!designPath) {
    return (
      "Design incomplete: designPath is missing. Write HERMAN_DESIGN.md with a " +
      "Page inventory, then call herman_complete_design again."
    );
  }
  if (!existsSync(designPath)) {
    return (
      `Design incomplete: design file not found (${designPath}). Write ` +
      `HERMAN_DESIGN.md with a Page inventory, then call herman_complete_design again.`
    );
  }
  if (!planPath) {
    return (
      "Design incomplete: planPath is missing. Write HERMAN_PLAN.md as a " +
      "milestone plan, then call herman_complete_design again."
    );
  }
  if (!existsSync(planPath)) {
    return (
      `Design incomplete: plan file not found (${planPath}). Write HERMAN_PLAN.md ` +
      `as a milestone plan with checkboxes and acceptance criteria, then call ` +
      `herman_complete_design again.`
    );
  }

  const planMd = readFileSync(planPath, "utf-8");
  const planError = validatePlanStructure(planMd);
  if (planError) return planError;

  const designMd = readFileSync(designPath, "utf-8");
  if (extractRouteInventory(designMd).length < 1) {
    return (
      "Design incomplete: HERMAN_DESIGN.md has no Page inventory routes " +
      "(expected lines like `- `/path` — Page Name: …` under `## Page inventory`). " +
      "Add at least one route, then call herman_complete_design again."
    );
  }

  return undefined;
}
