import { getLogger } from "@logtape/logtape";

import type { TabId } from "../shared/rpc.js";

const logger = getLogger(["herman-desktop", "agent-runtime"]);

const MAX_CONCURRENT_STARTS = 3;

export type EnsureAgentFn = (tabId: TabId) => Promise<void>;

/**
 * Background agent startup queue with bounded concurrency.
 * Tab open paths call `schedule()` — never await it.
 */
export class AgentRuntime {
  private pending = new Map<TabId, Promise<void>>();
  private queue: TabId[] = [];
  private active = 0;

  constructor(private ensureAgent: EnsureAgentFn) {}

  schedule(tabId: TabId): void {
    if (this.pending.has(tabId)) return;
    this.queue.push(tabId);
    void this.pump();
  }

  scheduleMany(tabIds: TabId[]): void {
    for (const tabId of tabIds) {
      this.schedule(tabId);
    }
  }

  /** Wait for all in-flight background agent starts (tests only). */
  async waitForIdle(): Promise<void> {
    while (this.queue.length > 0 || this.active > 0 || this.pending.size > 0) {
      const jobs = [...this.pending.values()];
      if (jobs.length > 0) {
        await Promise.allSettled(jobs);
      }
      if (this.queue.length > 0 || this.active > 0) {
        await delay(10);
      }
    }
  }

  private pump(): void {
    while (this.active < MAX_CONCURRENT_STARTS && this.queue.length > 0) {
      const tabId = this.queue.shift();
      if (!tabId || this.pending.has(tabId)) continue;
      this.active++;
      const job = this.run(tabId).finally(() => {
        this.active--;
        this.pending.delete(tabId);
        this.pump();
      });
      this.pending.set(tabId, job);
    }
  }

  private async run(tabId: TabId): Promise<void> {
    try {
      await this.ensureAgent(tabId);
    } catch (error) {
      logger.warning("Background agent ensure failed", {
        tabId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
