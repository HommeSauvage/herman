/**
 * RewindManager — checkpoint integration for the revert feature.
 *
 * pi-rewind (installed as a pi-agent extension) creates git checkpoints
 * automatically at turn boundaries.  This manager loads those checkpoints
 * from the git ref store and maps them to message positions so the
 * desktop UI can restore files on revert.
 */

import { randomUUIDv7 } from "bun";
import { getLogger } from "@logtape/logtape";

import type { FileDiff, Message, TabId } from "../shared/rpc.js";
import {
  ZEROS,
  EMPTY_TREE,
  isGitRepo,
  createCheckpoint,
  restoreCheckpoint,
  diffCheckpoints,
  deleteCheckpoint,
  loadAllCheckpoints,
  git,
  parseUnifiedDiff,
  type CheckpointData,
  type ParsedFileDiff,
} from "./rewind-core.js";

const logger = getLogger(["herman-desktop", "rewind-manager"]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract ordered user message IDs from a messages array. */
export function getUserMessageIds(messages: Message[]): string[] {
  const ids: string[] = [];
  for (const m of messages) {
    if (m.role === "user") ids.push(m.id);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Per-tab rewind state. */
type TabRewindState = {
  /** Whether the tab's project directory is a git repo. */
  gitAvailable: boolean;
  /** Absolute path to the git repo root. */
  repoRoot: string;
  /** Cached checkpoints for this repo, sorted oldest-first by timestamp. */
  checkpoints: CheckpointData[];
  /**
   * Turn index → checkpoint lookup.
   * pi-rewind stores pi-agent's turnIndex on each checkpoint, so we can
   * map user-message positions (which correspond to turns) to file states.
   */
  byTurn: Map<number, CheckpointData>;
};

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class RewindManager {
  private states = new Map<TabId, TabRewindState>();

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /** Initialize rewind for a tab. Returns true if git is available. */
  async init(tabId: TabId, folderPath: string): Promise<boolean> {
    try {
      const gitAvailable = await isGitRepo(folderPath);
      if (!gitAvailable) {
        logger.debug("Git not available for rewind", { tabId, folderPath });
        return false;
      }

      const { getRepoRoot } = await import("./rewind-core.js");
      const repoRoot = await getRepoRoot(folderPath);

      const { checkpoints, byTurn } = this.indexCheckpoints(
        await loadAllCheckpoints(repoRoot),
      );

      this.states.set(tabId, { gitAvailable: true, repoRoot, checkpoints, byTurn });

      logger.info("Rewind initialized", {
        tabId,
        repoRoot,
        checkpointCount: checkpoints.length,
      });
      return true;
    } catch (err) {
      logger.debug("Rewind init failed (non-git project?)", {
        tabId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /** Clean up rewind state for a tab. */
  dispose(tabId: TabId): void {
    this.states.delete(tabId);
  }

  /** Reload checkpoints from git refs.  Must be awaited before find/diff. */
  async reload(tabId: TabId): Promise<void> {
    const state = this.states.get(tabId);
    if (!state?.gitAvailable) return;

    try {
      const { checkpoints, byTurn } = this.indexCheckpoints(
        await loadAllCheckpoints(state.repoRoot),
      );
      state.checkpoints = checkpoints;
      state.byTurn = byTurn;
    } catch (err) {
      logger.warning("Failed to reload checkpoints", {
        tabId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Find the checkpoint representing the file state BEFORE a given message.
   *
   * Uses pi-rewind's turnIndex metadata stored on each checkpoint.
   * The boundary message's "turn index" is its position among user messages
   * (0-based).  We look up the checkpoint whose turnIndex equals
   * (boundaryTurn - 1), falling back to the closest earlier checkpoint when
   * pi-rewind deduplicated turns with no file mutations.
   *
   * @param messageId  The boundary message ID (revert point).
   * @param userMessageIds  Ordered list of all user message IDs in the tab.
   */
  findCheckpointBefore(
    tabId: TabId,
    messageId: string,
    userMessageIds: string[],
  ): CheckpointData | undefined {
    const state = this.states.get(tabId);
    if (!state || state.checkpoints.length === 0) return undefined;

    const boundaryTurn = userMessageIds.indexOf(messageId);
    if (boundaryTurn < 0) return undefined;

    // Reverting to the very first user message → restore to the resume
    // checkpoint (the state before any agent work happened).
    if (boundaryTurn === 0) {
      return state.checkpoints[0];
    }

    // Target: the checkpoint for the turn just before the boundary.
    const targetTurn = boundaryTurn - 1;

    // Exact match via pi-rewind's turnIndex metadata.
    const exact = state.byTurn.get(targetTurn);
    if (exact) return exact;

    // Fallback: find the checkpoint with the highest turnIndex still < targetTurn.
    let best: CheckpointData | undefined;
    for (const cp of state.checkpoints) {
      if (cp.turnIndex < targetTurn && (!best || cp.turnIndex > best.turnIndex)) {
        best = cp;
      }
    }
    return best ?? state.checkpoints[0];
  }

  /**
   * Restore files to a checkpoint's state, with a safety snapshot first.
   */
  async restoreToCheckpoint(tabId: TabId, cp: CheckpointData): Promise<void> {
    const state = this.states.get(tabId);
    if (!state?.gitAvailable) return;

    // Create a safety checkpoint before restoring.
    try {
      await createCheckpoint({
        root: state.repoRoot,
        id: `before-restore-${randomUUIDv7()}`,
        sessionId: "herman-desktop",
        trigger: "before-restore",
        turnIndex: 0,
        description: "Safety snapshot before revert",
      });
    } catch (err) {
      logger.warning("Failed to create safety checkpoint", {
        tabId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    await restoreCheckpoint(state.repoRoot, cp);

    logger.info("Files restored to checkpoint", {
      tabId,
      checkpointId: cp.id,
    });
  }

  /**
   * Get a diff summary between the current state and a checkpoint.
   */
  async getDiff(tabId: TabId, cp: CheckpointData): Promise<string> {
    const state = this.states.get(tabId);
    if (!state?.gitAvailable) return "";

    try {
      return await diffCheckpoints(state.repoRoot, cp.worktreeTreeSha, "HEAD");
    } catch {
      return "";
    }
  }

  /**
   * Get a human-readable summary of file changes for the revert dock.
   */
  async getRevertDiffSummary(
    tabId: TabId,
    revertMessageId: string,
    userMessageIds: string[],
  ): Promise<string> {
    const cp = this.findCheckpointBefore(tabId, revertMessageId, userMessageIds);
    if (!cp) return "";
    return this.getDiff(tabId, cp);
  }

  /**
   * Remove checkpoints after a given message (used when committing a revert).
   */
  async pruneAfterMessage(
    tabId: TabId,
    messageId: string,
    userMessageIds: string[],
  ): Promise<void> {
    const state = this.states.get(tabId);
    if (!state || state.checkpoints.length === 0) return;

    const boundaryTurn = userMessageIds.indexOf(messageId);
    if (boundaryTurn < 0) return;

    // Remove checkpoints whose turnIndex is >= the boundary turn.
    const toRemove: CheckpointData[] = [];
    const kept: CheckpointData[] = [];
    for (const cp of state.checkpoints) {
      if (cp.turnIndex >= boundaryTurn) {
        toRemove.push(cp);
      } else {
        kept.push(cp);
      }
    }

    state.checkpoints = kept;
    state.byTurn = this.buildTurnIndex(kept);

    for (const cp of toRemove) {
      await deleteCheckpoint(state.repoRoot, cp.id).catch(() => {});
    }
  }

  // -----------------------------------------------------------------------
  // Diff methods for the changes panel
  // -----------------------------------------------------------------------

  /** Return the correct baseline ref for diffing, falling back to the empty tree on fresh repos. */
  private baselineRef(state: TabRewindState): string {
    // If the earliest checkpoint was created when the repo had no commits,
    // HEAD doesn't exist yet — use the empty tree SHA as the baseline.
    const first = state.checkpoints[0];
    if (first && first.headSha === ZEROS) return EMPTY_TREE;
    return "HEAD";
  }

  /** Diff for changes introduced in the last turn. */
  async getTurnDiff(tabId: TabId): Promise<FileDiff[]> {
    await this.reload(tabId);
    const state = this.states.get(tabId);
    if (!state?.gitAvailable || state.checkpoints.length === 0) return [];

    const last = state.checkpoints[state.checkpoints.length - 1]!;
    // Diff between the penultimate checkpoint and the last one.
    // For the very first turn, diff the baseline (HEAD or empty tree) against the first checkpoint.
    const prev = state.checkpoints.length >= 2
      ? state.checkpoints[state.checkpoints.length - 2]
      : undefined;

    return this.diffTrees(
      state.repoRoot,
      prev ? prev.worktreeTreeSha : this.baselineRef(state),
      last.worktreeTreeSha,
    );
  }

  /** Diff for all changes since the session started. */
  async getFullDiff(tabId: TabId): Promise<FileDiff[]> {
    await this.reload(tabId);
    const state = this.states.get(tabId);
    if (!state?.gitAvailable || state.checkpoints.length === 0) return [];

    const last = state.checkpoints[state.checkpoints.length - 1]!;
    return this.diffTrees(state.repoRoot, this.baselineRef(state), last.worktreeTreeSha);
  }

  /** Diff for working-tree changes (staged + unstaged vs HEAD or empty tree). */
  async getWorkingTreeDiff(tabId: TabId): Promise<FileDiff[]> {
    const state = this.states.get(tabId);
    if (!state?.gitAvailable) return [];

    return this.diffTrees(state.repoRoot, this.baselineRef(state), "");
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  /** Sort checkpoints and build the turn index lookup. */
  private indexCheckpoints(raw: CheckpointData[]): {
    checkpoints: CheckpointData[];
    byTurn: Map<number, CheckpointData>;
  } {
    raw.sort((a, b) => a.timestamp - b.timestamp);
    return { checkpoints: raw, byTurn: this.buildTurnIndex(raw) };
  }

  private buildTurnIndex(checkpoints: CheckpointData[]): Map<number, CheckpointData> {
    const map = new Map<number, CheckpointData>();
    for (const cp of checkpoints) {
      map.set(cp.turnIndex, cp);
    }
    return map;
  }

  /**
   * Run `git diff` between two refs (or working tree if `to` is empty),
   * then parse into structured FileDiff objects with patches.
   */
  private async diffTrees(
    root: string,
    from: string,
    to: string,
  ): Promise<FileDiff[]> {
    try {
      const args = to
        ? `diff --unified=3 ${from} ${to}`
        : `diff --unified=3 ${from}`;
      const diffText = await git(args, root);
      if (!diffText) return [];

      const parsed = parseUnifiedDiff(diffText);
      return parsed.map(toFileDiff);
    } catch {
      return [];
    }
  }
}

/** Adapter: convert ParsedFileDiff (from rewind-core) to FileDiff (shared RPC type). */
function toFileDiff(p: ParsedFileDiff): FileDiff {
  return {
    path: p.path,
    status: p.status,
    additions: p.additions,
    deletions: p.deletions,
    patch: p.patch,
  };
}

/** Singleton — one manager for the entire process. */
export const rewindManager = new RewindManager();
