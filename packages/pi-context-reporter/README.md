# @herman/pi-context-reporter

A [Pi coding agent](https://github.com/mariozechner/pi-coding-agent) extension
that streams live context-window and token-usage data to the Herman desktop
app via `ui.notify`.

## What it does

The extension subscribes to the full set of session/message events exposed by
Pi and emits a single throttled event — `herman/context_report` — that the
Herman desktop can adopt as the source of truth for its context gauge.

| Event (Pi) | Used for |
|---|---|
| `session_start` | Set the baseline model key + context window. |
| `model_select` | Update the model key + context window on model switches. |
| `session_compact` | Mark context as unknown until the next pre-LLM anchor. |
| `session_shutdown` | Cancel pending emits. |
| `context` (pre-LLM) | Adopt `getContextUsage()` as the gauge anchor. |
| `agent_start` / `agent_end` | Mark the streaming flag. |
| `message_start` | Begin a new current-turn estimate. |
| `message_update` | Accumulate streaming output (chars/4 of deltas). |
| `message_end` | Update cumulative totals from the LLM-reported `usage`. |

## Wire format

The extension emits a JSON-stringified `ContextReportPayload` (see
[`src/payload.ts`](./src/payload.ts)) via `ui.notify`, which the desktop
parses and applies to `tab.contextStats`.

```ts
{
  type: "herman/context_report",
  schema: 1,
  modelKey: "anthropic/claude-sonnet-4.6",
  context: { tokens: 12_345, contextWindow: 200_000, percent: 6.17 },
  totals: {
    input: 1000, output: 200, cacheRead: 50, cacheWrite: 25,
    reasoning: 30, cost: 0.0123,
  },
  lastUsage: { /* final usage from the most recent message_end */ },
  currentTurn: { output: 42, startedAt: 1700000000000 },
  isCompacted: false,
  isStreaming: true,
  updatedAt: 1700000001000,
}
```

## Throttling

`ui.notify` is fire-and-forget over RPC. Calling it per-token during
assistant streaming would saturate the IPC. The extension coalesces
streaming updates within a 200ms window (see `REPORT_THROTTLE_MS`) but
flushes immediately on lifecycle events (`agent_end`, `message_end`,
`session_compact`) so the desktop sees the final state without lag.

## Tests

```sh
bun test            # uses bun's test runner
bun x vitest run    # uses vitest
```

The integration tests use real timers (not fake timers) so they work
under both runners.
