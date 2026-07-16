import { existsSync } from "node:fs";
import { unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { getLogger } from "@logtape/logtape";

import { hermanDir } from "./app-paths.js";
import { writeFileAtomically } from "./fs-utils.js";

const logger = getLogger(["herman-desktop", "wizard-checkpoint"]);

export type WizardCheckpointPhase = "planning" | "coding" | "qa";

/** Disk snapshot of an incomplete wizard so cold start / crash can offer Continue. */
export type WizardCheckpoint = {
  id: string;
  templateId: string;
  description: string;
  preferredModel?: string;
  phase: WizardCheckpointPhase;
  projectPath?: string;
  planPath?: string;
  codingSummary?: string;
  capturedPiSessionId?: string;
  /** Goal objective text (without `/goal ` prefix) for resilience verification. */
  phaseGoal?: string;
  lastError?: string;
  /** Last progress lines for the recovery UI. */
  progressLines?: string[];
  updatedAt: number;
};

export function wizardCheckpointPath(): string {
  return join(hermanDir(), "wizard-checkpoint.json");
}

export async function loadWizardCheckpoint(): Promise<WizardCheckpoint | null> {
  const path = wizardCheckpointPath();
  if (!existsSync(path)) return null;
  try {
    const raw = await Bun.file(path).text();
    const parsed = JSON.parse(raw) as unknown;
    if (!isWizardCheckpoint(parsed)) {
      logger.warning("Invalid wizard checkpoint on disk; discarding", { path });
      await clearWizardCheckpoint();
      return null;
    }
    return parsed;
  } catch (error) {
    logger.warning("Failed to load wizard checkpoint", { error });
    return null;
  }
}

export async function saveWizardCheckpoint(checkpoint: WizardCheckpoint): Promise<void> {
  const path = wizardCheckpointPath();
  try {
    await mkdir(hermanDir(), { recursive: true });
    writeFileAtomically(path, JSON.stringify({ ...checkpoint, updatedAt: Date.now() }, null, 2));
  } catch (error) {
    logger.warning("Failed to save wizard checkpoint", { error, id: checkpoint.id });
  }
}

export async function clearWizardCheckpoint(): Promise<void> {
  const path = wizardCheckpointPath();
  try {
    if (existsSync(path)) await unlink(path);
  } catch (error) {
    logger.warning("Failed to clear wizard checkpoint", { error });
  }
}

/**
 * A checkpoint is cold-resumable when we have a pi session id, and for
 * coding/QA the project directory still exists.
 * Mid-planning without a pi session (or stuck on an unanswered ask) is not
 * cold-resumed — those checkpoints should be discarded.
 */
export function evaluateWizardCheckpoint(checkpoint: WizardCheckpoint): {
  resumable: boolean;
  reason?: string;
} {
  if (!checkpoint.capturedPiSessionId) {
    return { resumable: false, reason: "Missing pi session id" };
  }
  if (checkpoint.phase === "coding" || checkpoint.phase === "qa") {
    if (!checkpoint.projectPath) {
      return { resumable: false, reason: "Missing project path" };
    }
    if (!existsSync(checkpoint.projectPath)) {
      return { resumable: false, reason: "Project folder no longer exists" };
    }
  }
  return { resumable: true };
}

function isWizardCheckpoint(value: unknown): value is WizardCheckpoint {
  if (!value || typeof value !== "object") return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.id === "string" &&
    typeof c.templateId === "string" &&
    typeof c.description === "string" &&
    (c.phase === "planning" || c.phase === "coding" || c.phase === "qa") &&
    typeof c.updatedAt === "number"
  );
}
