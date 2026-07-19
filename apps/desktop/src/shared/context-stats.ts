/**
 * Formatting helpers for context-window display.
 *
 * The actual `ContextStats` numbers are now produced by the agent's
 * `herman/context_report` event (see `packages/pi-context-reporter`).
 * This file used to host a chars/4 fallback estimator + a 60-entry
 * `MODEL_CONTEXT_LIMITS` table; both have been removed in favor of
 * the live stream.
 */

export type { ContextStats } from "./rpc.js";

/** Format a token count with k/M suffixes (e.g. 12345 -> "12.3k"). */
export function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

/** Format a USD cost value (e.g. 0.0042 -> "$0.0042", 1.23 -> "$1.23"). */
export function formatCost(value: number): string {
  if (value === 0) return "$0.00";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

/** Clamp a 0–1 ratio to a 0–100 percentage and round. */
export function clampPercentage(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 100;
  return Math.round(value * 100);
}
