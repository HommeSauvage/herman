# Refactor: Preview ↔ Agent Communication Layer ("Host Bridge")

> Status: DRAFT — ready for implementation
> Owner: agent
> Started: 2026-07-18

## Goal

Give the rookie-mode agent first-class awareness of the running preview:

1. **Base information, always fresh** — the agent knows the preview's live URL,
   port, phase, and the page currently open in the preview pane, refreshed on
   every turn. When the server restarts on a new port, the next turn's context
   reflects it. No more guessing ports.
2. **Logs on demand** — a tool to fetch recent **browser console** output and
   **dev-server terminal** output, with error-context windows
   (`herman_get_preview_logs(environment: "console" | "server", maxLinesBeforeAfter = 25)`).

…built on a **rethought, coherent architecture** that replaces the current
patchwork of sentinel-in-editor hacks and one-off interceptions with a single,
extensible communication layer.

## Why the current state is a problem

The last commit (`b5803ce`) added `herman_get_session_info` by smuggling a JSON
envelope through pi's `ctx.ui.editor()` dialog and intercepting it in the event
pipeline. It works, but it crystalized a pattern that does not scale:

| Pain | Evidence |
|---|---|
| Wire protocol smuggled through a UI dialog | `ctx.ui.editor(title, prefill=JSON)` round-trip; sentinel string `__herman_session_info__` (`apps/desktop/src/shared/session-info-protocol.ts`) |
| Protocol shapes duplicated across packages | `session-info-protocol.ts` carries a "keep them in sync" NOTE; the agent extension inlines its own copy (`packages/agent/src/extensions/herman-extension.ts:394-470`) |
| Interception sprinkled in the hot event path | `AgentProcessManager.startBridge` calls `tryRespondSessionInfo` before forwarding events (`agent-process-manager.ts:978`, method at `:1172`); parser lives in `shared/agent-protocol.ts` |
| Preview knowledge has no single owner | fleet status in `bun/preview/`, error-context lines forwarded to renderer only, console errors trapped in the renderer store (`preview-store.ts`), `stderrTail` (8 KB) is the only bun-side log retention and dies with the instance |
| Agent has no log/console access at all | `PREVIEW_CONSOLE_PRELOAD` forwards `console.error` only, and only as far as the renderer toast pipeline (`preview-webview-bridge.ts`) |
| Agent has no proactive awareness | rookie.md tells the agent to *poll* `herman_get_session_info` before every link; nothing pushes state into context |
| Wizard QA phase already needs this | `buildQaGoal` instructs the agent to "Start the server and navigate the website. Notice any errors on the server side or the web page's console errors." — no such tooling exists (`wizard-session.ts:1482`) |

Adding "console access" with today's patterns would mean a second sentinel, a
second interception, and new renderer plumbing per capability. Instead we build
one channel that makes every future capability a new route, not a new hack.

## Target architecture

```
┌────────────────────────┐         stdin/stdout JSONL (pi RPC)
│  agent subprocess      │ ◄──────────────────────────────► (unchanged:
│  (packages/agent)      │   commands, agent events,       wizard ask dialogs,
│                        │   extension_ui_request/response ads, models_sync…)
│  preview-context-      │
│  extension.ts          │
│    • herman_get_       │         HTTP 127.0.0.1:<ephemeral>, Bearer token
│      session_info      │ ◄──────────────────────────────► ┌─────────────────┐
│    • herman_get_       │   GET /v1/health                │  desktop (bun)  │
│      preview_logs      │   GET /v1/tabs/:tabId/          │                 │
│    • preview state     │        session-info             │  HostBridge     │
│      prompt injection  │   GET /v1/tabs/:tabId/          │  Server         │
│                        │        preview/state            │  (new, generic) │
└────────────────────────┘   GET /v1/tabs/:tabId/          └───────┬─────────┘
        ▲                           preview/logs                   │
        │ env: HERMAN_HOST_BRIDGE_URL / _TOKEN                     ▼
        │ (injected by AgentBridge at spawn)         PreviewContextService (new)
        │                                            single owner of "what the
        │                                            agent knows about previews"
        │                                            • fleet status (PreviewManager)
        │                                            • server log rings (per folder+server)
        │                                            • console rings (per tab)
        │                                            • current pane URL (per tab)
        │                                            • session info assembly
        │                                                   ▲                ▲
┌───────┴──────────────┐    electrobun RPC messages        │                │
│  renderer (React)    │ ──────────────────────────────────┘                │
│  preview-webview     │  previewConsoleBatch / previewNavigated            │
│  (preload captures   │                                                    │
│   ALL console levels)│         every stdout/stderr line                   │
└──────────────────────┘ ───────────────────────────────────────────────────┘
                              PreviewManager new optional dep: emitLine
```

**Key decisions (do not relitigate during implementation):**

1. **Transport: localhost HTTP, not a generalized sentinel.** `Bun.serve` on
   `127.0.0.1`, OS-assigned ephemeral port, per-app-launch random Bearer token.
   Precedent in-repo: the OAuth callback server (`bun/oauth.ts:247`). The
   sentinel-editor channel stays only for what it genuinely is — an
   *interactive user dialog* (wizard ask). Host-answered silent RPC moves to
   HTTP entirely.
2. **Wire types live in `packages/rpc`** (`@herman/rpc/host-bridge`), the
   existing shared package imported by both the desktop and the agent
   (precedent: `HERMAN_REFRESH_MODELS_MESSAGE`, `ModelCatalogFile` in
   `packages/rpc/src/agent.ts`). Single source of truth — kills the
   "keep in sync" duplication.
3. **One owner for agent-facing preview state: `PreviewContextService`** (bun).
   Rings live here (not on `PreviewInstance`), so logs survive server crashes
   and restarts. `PreviewManager` only *emits* lines via a new optional dep.
4. **Agent-side: a dedicated extension** `preview-context-extension.ts` owns
   the host-bridge client, both tools, and the per-turn prompt injection.
   `herman-extension.ts` shrinks back to provider/models/ads concerns.
5. **Host formats, agent embeds.** Log text and error-context windows are
   computed on the host; the agent tool returns the formatted string. The
   compact `<herman_preview_state>` prompt block is formatted agent-side from
   structured state (token-budget control lives with the prompt owners).
6. **Tool names follow the `herman_*` convention.** The requested
   `get_running_preview_info(environment, max_lines_before_after)` ships as
   `herman_get_preview_logs(environment, maxLinesBeforeAfter, …)` — "logs" to
   disambiguate from `herman_get_session_info` (status/URLs), same signature
   otherwise.

---

## Component specs

### A. Shared wire types — `packages/rpc/src/host-bridge.ts` (NEW)

Export from `packages/rpc/package.json` as `"./host-bridge": "./src/host-bridge.ts"`.

```ts
/** Wire protocol for the Herman host bridge (desktop bun ↔ agent, HTTP JSON). */

export const HOST_BRIDGE_PROTOCOL_VERSION = 1;
export const HOST_BRIDGE_AUTH_SCHEME = "Bearer";

/** Route builders — both sides construct URLs through these, never by hand. */
export const HOST_BRIDGE_ROUTES = {
  health: "/v1/health",
  sessionInfo: (tabId: string) => `/v1/tabs/${encodeURIComponent(tabId)}/session-info`,
  previewState: (tabId: string) => `/v1/tabs/${encodeURIComponent(tabId)}/preview/state`,
  previewLogs: (tabId: string) => `/v1/tabs/${encodeURIComponent(tabId)}/preview/logs`,
} as const;

export type HostBridgeErrorCode =
  | "unauthorized" | "not_found" | "bad_request"
  | "tab_not_found" | "no_preview" | "internal";

export type HostBridgeErrorBody = { error: string; code: HostBridgeErrorCode };

/** Mirrors apps/desktop/src/shared/preview.ts PreviewPhase (kept as a literal
 *  union here because @herman/rpc must stay desktop-independent). */
export type HostBridgePreviewPhase = "stopped" | "installing" | "starting" | "ready" | "failed";

export type HostBridgePreviewServer = {
  serverId: string;
  phase: HostBridgePreviewPhase;
  url?: string;
  port?: number;
  error?: string;
};

/** GET /v1/tabs/:tabId/session-info — superset of the legacy sentinel payload
 *  (same fields minus the sentinel/version ceremony, plus currentUrl). */
export type HostBridgeSessionInfo = {
  version: 1;
  projectPath: string;
  projectRoot?: string;
  worktree?: { folderPath: string; mainFolderPath: string; branch: string; baseBranch?: string };
  mode?: "rookie" | "normal";
  preview: {
    phase: HostBridgePreviewPhase;
    primaryUrl?: string;
    servers: HostBridgePreviewServer[];
  };
  /** Page currently shown in the preview pane (post-navigation). */
  currentUrl?: string;
  error?: string;
};

/** GET /v1/tabs/:tabId/preview/state — compact structured state for the
 *  agent's per-turn prompt injection. */
export type HostBridgePreviewState = {
  version: 1;
  /** false when the tab is unknown / has no project. */
  available: boolean;
  phase: HostBridgePreviewPhase;
  primaryServerId?: string;
  primaryUrl?: string;
  port?: number;
  servers: HostBridgePreviewServer[];
  currentUrl?: string;
  /** Errors observed in the last RECENT_ERRORS_WINDOW_MS, per environment. */
  recentErrors: { server: number; console: number };
  /** First line of the failure when phase === "failed". */
  error?: string;
};

export type PreviewLogEnvironment = "console" | "server";

/** Query params for GET …/preview/logs (all optional except environment). */
export type PreviewLogsQuery = {
  environment: PreviewLogEnvironment;
  /** env=server only; defaults to the primary server. */
  serverId?: string;
  /** Tail size cap. Default 50, max 200. */
  maxEntries?: number;
  /** Lines of context around each detected error. Default 25, max 100. */
  maxLinesBeforeAfter?: number;
};

export type PreviewLogEntry = {
  ts: number;
  /** "stdout"|"stderr" for env=server; "console" for env=console. */
  source: "stdout" | "stderr" | "console";
  /** Console level (env=console only). */
  level?: "error" | "warn" | "info" | "log" | "debug";
  line: string;
  stack?: string;
  /** Page URL the console entry was logged on (env=console only). */
  url?: string;
  /** Line matched the server-error heuristic / console level === "error". */
  isError: boolean;
};

export type HostBridgePreviewLogs = {
  version: 1;
  environment: PreviewLogEnvironment;
  /** Resolved server id (env=server). */
  serverId?: string;
  phase: HostBridgePreviewPhase;
  /** Live server URL at answer time. */
  url?: string;
  currentUrl?: string;
  /** Pre-formatted, pre-truncated log text, ready to embed in a tool result. */
  text: string;
  entries: PreviewLogEntry[];
  /** Entries dropped by ring overflow / rate limiting since process start. */
  droppedEntries: number;
  truncated: boolean;
};

/** A console entry as captured by the preview webview preload and forwarded
 *  renderer → bun. Also the console ring element. */
export type PreviewConsoleEntry = {
  level: "error" | "warn" | "info" | "log" | "debug";
  message: string;   // ≤ 2000 chars
  stack?: string;    // ≤ 2000 chars
  url: string;
  ts: number;
};

/** Defaults shared by both sides (client fills them; host clamps them). */
export const PREVIEW_LOGS_DEFAULT_MAX_ENTRIES = 50;
export const PREVIEW_LOGS_MAX_ENTRIES = 200;
export const PREVIEW_LOGS_DEFAULT_CONTEXT = 25;   // == ERROR_CONTEXT_LINES precedent
export const PREVIEW_LOGS_MAX_CONTEXT = 100;
export const PREVIEW_TOOL_TEXT_MAX_CHARS = 12_000; // matches preview-errors.ts MAX_FORMATTED_ERRORS_CHARS
export const RECENT_ERRORS_WINDOW_MS = 5 * 60_000;
```

### B. Host bridge server — `apps/desktop/src/bun/host-bridge/server.ts` (NEW)

Small, generic, feature-agnostic HTTP layer. Precedent for `Bun.serve` on
localhost: `bun/oauth.ts:247`.

```ts
export type HostBridgeRequest = {
  params: Record<string, string>;   // from :segments in the pattern
  query: URLSearchParams;
};

export type HostBridgeRoute = {
  method: "GET";
  /** Path pattern, e.g. "/v1/tabs/:tabId/preview/logs". */
  pattern: string;
  handler: (req: HostBridgeRequest) => unknown | Promise<unknown>;
};

/** Throw inside a handler to control status + error body. */
export class HostBridgeError extends Error {
  constructor(public status: number, public code: HostBridgeErrorCode, message: string) { super(message); }
}

export type HostBridgeServer = { url: string; token: string; stop(): Promise<void> };

export function startHostBridgeServer(routes: HostBridgeRoute[]): Promise<HostBridgeServer>;
```

Behavior:
- `Bun.serve({ port: 0, hostname: "127.0.0.1", fetch })` → `url = http://127.0.0.1:${server.port}`,
  `token = crypto.randomUUID()`.
- Every request except `GET /v1/health` requires header
  `Authorization: Bearer <token>` → else 401 `{ error, code: "unauthorized" }`.
- Pattern match: exact segment count + `:param` segments; unmatched → 404.
- Handler return → `Response.json(body)`. `HostBridgeError` → mapped status +
  `{ error: message, code }`; unknown throw → 500 `"internal"` + log.
- Log requests at debug via `getLogger(["herman-desktop", "host-bridge"])`.
- Module singleton: `getActiveHostBridge(): HostBridgeServer | undefined`
  (set by `startHostBridgeServer`, cleared by `stop`). Follows the existing
  singleton style of `preview/index.ts` and is what `AgentBridge` reads.

### C. Preview context service — `apps/desktop/src/bun/preview-context/` (NEW)

Three files:

**`ring-buffer.ts`** — generic bounded ring with drop counting:

```ts
export class RingBuffer<T> {
  constructor(private readonly capacity: number) {}
  push(item: T): void;            // evicts oldest, increments droppedCount on overflow
  items(): readonly T[];          // oldest → newest
  readonly droppedCount: number;
  clear(): void;
}
```

**`format.ts`** — pure formatting helpers (unit-tested without the service):

```ts
/** Tail + merged ±context windows around error lines, char-capped. */
export function formatServerLogText(lines: PreviewServerLogLine[], opts: {
  maxEntries: number; maxLinesBeforeAfter: number; maxChars: number;
}): { text: string; entries: PreviewLogEntry[]; truncated: boolean };

export function formatConsoleLogText(entries: PreviewConsoleEntry[], opts: {
  maxEntries: number; maxLinesBeforeAfter: number; maxChars: number; currentUrl?: string;
}): { text: string; entries: PreviewLogEntry[]; truncated: boolean };
```

- `formatServerLogText`: take the last `maxEntries * 4` lines as the working
  window; mark error lines with the existing `looksLikeServerError`
  (`bun/preview/preview-log-filter.ts`); build merged `[i-N, i+N]` windows;
  always include the plain last-`maxEntries` tail (so the agent sees the most
  recent output even without errors); render `[stdout] …` / `[stderr] …`
  prefixes; cap at `maxChars` with a `… (truncated)` marker.
- `formatConsoleLogText`: last `maxEntries` entries, each rendered
  `[level] message (— page-url when different from currentUrl)` with `stack`
  indented under error entries; console "context" = entries before/after each
  error entry up to `maxLinesBeforeAfter` *within the tail* (console entries
  are discrete, so in practice the tail usually fits and windows rarely
  trigger).

**`service.ts`** — the aggregate owner:

```ts
export type PreviewServerLogLine = {
  folderPath: string; serverId: string;
  source: "stdout" | "stderr"; line: string; ts: number;
};

export type PreviewContextDeps = {
  getTab: (tabId: string) => {
    folderPath?: string; projectRoot?: string; worktree?: SessionWorktree;
  } | undefined;
  getMode: () => "rookie" | "normal" | undefined;
  /** = getDevServerStatus from bun/preview/index.ts (injected for tests). */
  getFleetStatus: (folderPath: string) => PreviewFleetSnapshot;
  now?: () => number;
};

export class PreviewContextService {
  constructor(deps: PreviewContextDeps);

  // ── Feeds ──
  handleServerLine(line: PreviewServerLogLine): void;
  handleConsoleBatch(tabId: string, folderPath: string, entries: PreviewConsoleEntry[]): void;
  handleNavigation(tabId: string, folderPath: string, url: string): void;
  clearTab(tabId: string): void;   // console ring + navigation (server rings are folder-scoped)

  // ── Queries (called by host-bridge routes) ──
  getSessionInfo(tabId: string): HostBridgeSessionInfo;
  getPreviewState(tabId: string): HostBridgePreviewState;
  getPreviewLogs(tabId: string, query: PreviewLogsQuery): HostBridgePreviewLogs;
}
```

Storage & rules:
- Server rings: `Map<"${folderPath}::${serverId}", RingBuffer<PreviewServerLogLine>>`,
  capacity **500 lines**, per-line cap **1000 chars**. Survives instance death
  (crashes must be debuggable after the process is gone). Cap the map at 20
  keys with simple insertion-order eviction.
- Console rings: `Map<tabId, RingBuffer<PreviewConsoleEntry>>`, capacity **500**.
- Navigation: `Map<tabId, string>` current pane URL. `handleNavigation` also
  pushes a synthetic console entry `{ level: "log", message: "→ Navigated to <url>" }`
  into the tab's console ring (chronological correlation for the agent), and is
  ignored when `url` is unchanged.
- `getSessionInfo`: same assembly logic as today's
  `buildSessionInfoResponse` (`shared/session-info-protocol.ts` — **move the
  logic here**, dropping sentinel fields) + `currentUrl` from the navigation
  map (fallback: `preview.primaryUrl`).
- `getPreviewState`: `available = Boolean(tab?.folderPath)`; fleet phase from
  `getFleetStatus`; `recentErrors` = ring entries within
  `RECENT_ERRORS_WINDOW_MS` (console: `level === "error"`; server:
  `looksLikeServerError(line)`); `error` = first line of the primary server's
  error when `phase === "failed"`.
- `getPreviewLogs`: clamps query (`maxEntries` 1–200 default 50,
  `maxLinesBeforeAfter` 0–100 default 25); resolves serverId (given or fleet
  primary, else "web"); throws `HostBridgeError(404, "tab_not_found", …)` when
  the tab is unknown; env=server with an empty ring → `text: "(no server
  output captured yet)"` — an answer, not an error.
- `droppedEntries` = ring `droppedCount` (+ renderer-reported drops, see §E).

### D. PreviewManager: per-line tap (MODIFY)

- `bun/preview/types.ts`:
  - Add `PreviewServerLogLine` (re-export from the service's type — define it
    in `shared/preview.ts` instead, so `preview/`, `preview-context/`, and
    tests share it without a bun-internal import cycle).
  - `PreviewManagerDeps` gains **optional** `emitLine?: (line: PreviewServerLogLine) => void`
    (optional so existing PreviewManager tests keep passing unchanged).
  - Add `MAX_LOG_LINE_CHARS = 1000`.
- `bun/preview/preview-manager.ts` (`spawnInstance`): wrap the line handler so
  every line is tapped **before** the error-context filter:

  ```ts
  const baseHandler = createInstanceLineHandler({ … });
  const tapped = Object.assign(
    ((source, line) => {
      this.deps.emitLine?.({
        folderPath, serverId, source,
        line: line.slice(0, MAX_LOG_LINE_CHARS),
        ts: this.deps.now?.() ?? Date.now(),
      });
      baseHandler(source, line);
    }) as LineHandler & { flush: () => void },
    { flush: () => baseHandler.flush() },
  );
  attachLineReaders(child, tapped);
  ```
- `bun/preview/index.ts`: add module-level `lineHandler` +
  `setPreviewLineHandler(handler)` (mirrors `setPreviewStatusHandler` /
  `setPreviewLogHandler`), pass `emitLine: (e) => lineHandler?.(e)` into deps.
- `bun/preview-server.ts` (compat facade): re-export `setPreviewLineHandler`.

Nothing else in the preview subsystem changes — status/error flows to the
renderer stay exactly as they are.

### E. Renderer plumbing

**`shared/preview.ts`**: add `PreviewServerLogLine`; re-export
`PreviewConsoleEntry` from `@herman/rpc/host-bridge` (type-only re-export so
renderer code has one import site).

**`shared/rpc.ts`**:
- Add to the bun `messages` (renderer → bun):
  ```ts
  previewConsoleBatch: { tabId: TabId; folderPath: string; entries: PreviewConsoleEntry[]; dropped: number };
  previewNavigated: { tabId: TabId; folderPath: string; url: string };
  ```
- Fix the `DesktopRpc["send"]` mapped type to support payload-carrying
  messages (today every bun message is `undefined`-payload, so it maps to
  `() => void`):
  ```ts
  send: {
    [K in keyof HermanDesktopRPC["bun"]["messages"]]:
      HermanDesktopRPC["bun"]["messages"][K] extends undefined
        ? () => void
        : (payload: HermanDesktopRPC["bun"]["messages"][K]) => void;
  };
  ```
- Check `views/main/lib/browser-rpc.ts` (websocket mock): its `send` object
  must accept the new messages (add no-op entries if it's an explicit map).

**`views/main/lib/preview-webview-bridge.ts`** (MODIFY):
- `PREVIEW_CONSOLE_PRELOAD`: wrap **all five** console methods
  (`error, warn, info, log, debug`) — same pattern as the existing
  `console.error` wrap; keep `window` `error` + `unhandledrejection`
  listeners; add `url: location.href` and `ts: Date.now()` to every payload;
  guard against double-injection with a `window.__hermanConsoleTap` marker
  (preload re-runs on every navigation).
  ⚠️ The script is stringified into the webview — it must stay self-contained
  (no closures over module scope), as the file's header comment already warns.
- `PreviewHostMessage` → `{ type: "preview-console"; level: "error"|"warn"|"info"|"log"|"debug"; message: string; stack?: string; url?: string; ts?: number }`.
- `parsePreviewHostMessage`: accept all five levels; keep the 2000-char caps;
  pass through `url`/`ts` (default `ts` to `Date.now()`).

**`views/main/components/preview-webview.tsx`** (MODIFY):
- New optional prop `onConsoleEntry?: (entry: PreviewConsoleEntry) => void`.
- The `host-message` listener: parsed message →
  `onConsoleEntry?.({level, message, stack, url: url ?? "", ts: ts ?? Date.now()})`;
  additionally keep firing `onClientError` for `level === "error"` only
  (current toast behavior is preserved).

**`views/main/lib/preview-console-reporter.ts`** (NEW):
```ts
export function reportPreviewConsoleEntry(tabId: string, folderPath: string, entry: PreviewConsoleEntry): void;
export function reportPreviewNavigation(tabId: string, folderPath: string, url: string): void;
```
- Batches console entries per tab: flush every **250 ms** or at **50 entries**,
  via `desktopRpc.send.previewConsoleBatch`. Fire-and-forget (`.catch(() => {})`).
- Rate limit: **240 entries / 30 s / tab**; excess dropped and counted; the
  count rides along as `dropped` on the next batch (the service folds it into
  `droppedEntries`).
- Dedupe consecutive identical `(level, message)` entries (same rule as
  `appendRuntimeError` in `preview-errors.ts`).
- `reportPreviewNavigation` sends immediately (navigation is rare).

**`views/main/hooks/use-preview-controller.ts`** (MODIFY):
- Subscribe to `usePreviewStore` `currentUrl` changes; on change with a
  non-empty `tabId` + `folderPath` + url → `reportPreviewNavigation`.

**`views/main/components/preview-pane.tsx`** (MODIFY):
- Pass `onConsoleEntry={(entry) => reportPreviewConsoleEntry(tabId, folderPath, entry)}`
  down to `PreviewStage` (guard `tabId` present).

**`views/main/components/preview/preview-stage.tsx`** (MODIFY):
- Accept the new optional `onConsoleEntry` prop and forward it to
  `PreviewWebview` (same pass-through pattern as the existing `onClientError`
  prop, `preview-stage.tsx:18,138`).

**`bun/index.ts`** (MODIFY):
- In the RPC `messages` handlers: `previewConsoleBatch` →
  `previewContext.handleConsoleBatch(tabId, folderPath, entries)` and fold
  `dropped` into the ring's drop counter; `previewNavigated` →
  `previewContext.handleNavigation(tabId, folderPath, url)`.

### F. Agent package

**`packages/agent/src/env.ts`** (MODIFY): add
`HERMAN_HOST_BRIDGE_URL: "string = ''"` and
`HERMAN_HOST_BRIDGE_TOKEN: "string = ''"`; expose `config.hostBridgeUrl` /
`config.hostBridgeToken`.

**`packages/agent/src/host-bridge/client.ts`** (NEW):
```ts
export class HostBridgeUnavailableError extends Error {}  // env missing / unreachable
export class HostBridgeRequestError extends Error {       // non-2xx, carries code
  constructor(message: string, public code: HostBridgeErrorCode, public status: number) { super(message); }
}

export type HostBridgeClient = {
  isAvailable(): boolean;   // env vars present
  getSessionInfo(tabId: string): Promise<HostBridgeSessionInfo>;
  getPreviewState(tabId: string): Promise<HostBridgePreviewState>;
  getPreviewLogs(tabId: string, query: PreviewLogsQuery): Promise<HostBridgePreviewLogs>;
};

export function createHostBridgeClient(opts?: {
  baseUrl?: string; token?: string; fetchImpl?: typeof fetch; timeoutMs?: number;
}): HostBridgeClient;
```
- Defaults from `config.hostBridgeUrl/Token`; `timeoutMs` default **1500**
  (logs 3000); `AbortSignal.timeout`.
- Non-2xx: parse `HostBridgeErrorBody`, throw `HostBridgeRequestError`.
- Network errors → `HostBridgeUnavailableError`.
- `getPreviewState` memoized with a **2 s TTL** (per client) so a
  double-firing `before_agent_start` doesn't duplicate the call.

**`packages/agent/src/prompts/preview-state.ts`** (NEW) — pure formatter:

```ts
export function formatPreviewStateBlock(state: HostBridgePreviewState): string;
```
Output (≤ ~80 tokens), e.g. ready:
```
<herman_preview_state>
Live preview status (refreshed every turn — trust this over herman.yaml/README ports):
- Preview: ready at http://localhost:4321 (server "web", port 4321)
- Open page: http://localhost:4321/admin
- Recent errors: 2 console, 1 server in the last 5 minutes — call herman_get_preview_logs("console" | "server") for details
</herman_preview_state>
```
Variants: `installing`/`starting` → "starting up…"; `failed` → include the
one-line `error`; `stopped` → "not running"; omit `Open page` when
`currentUrl === primaryUrl`; omit `Recent errors` when both zero.

**`packages/agent/src/extensions/preview-context-extension.ts`** (NEW) —
default-exported extension factory `previewContextExtension(pi)`:

1. **Tool `herman_get_session_info`** — *moved* from `herman-extension.ts`
   with identical name/description/`promptSnippet`/`promptGuidelines`
   (copy them verbatim — the rookie prompt references this tool). `execute`
   calls `client.getSessionInfo(config.tabId)`; on
   `HostBridgeUnavailableError` return the same "only available inside Herman
   Desktop / do not invent URLs" text used today; on `HostBridgeRequestError`
   return a "could not fetch, do not guess a URL" text with `details.error =
   code`.
2. **Tool `herman_get_preview_logs`** — parameters (plain JSON schema, cast
   `as never`, per the wizard-extension pattern):
   ```json
   {
     "type": "object",
     "properties": {
       "environment": { "type": "string", "enum": ["console", "server"],
         "description": "'console' = browser console of the preview pane; 'server' = dev server terminal output" },
       "maxLinesBeforeAfter": { "type": "number", "description": "Context lines around each error (default 25)" },
       "maxEntries": { "type": "number", "description": "Max log lines/entries to return (default 50)" },
       "serverId": { "type": "string", "description": "Preview server id (env=server only; defaults to the primary server)" }
     },
     "required": ["environment"],
     "additionalProperties": false
   }
   ```
   - description: *"Fetch recent logs from the running preview: the browser
     console in Herman's preview pane ('console') or the dev server's terminal
     output ('server'). Use when debugging the site, when the user reports
     something broken or blank, or to check what the running preview is
     doing."*
   - `promptGuidelines`:
     - *"When investigating a broken or misbehaving page, call herman_get_preview_logs with environment 'server' and 'console' before asking the user for details — never ask the user to copy errors."*
     - *"Prefer this over re-running the dev server yourself; the preview is already running."*
     - *"If the tool reports unavailability, say you can't see the preview logs right now — do not invent errors or URLs."*
   - `execute`: calls `client.getPreviewLogs(config.tabId, params)`;
     returns `content` text = header line
     (`Preview: <phase> — <url> · viewing <currentUrl>` or graceful
     not-running sentence) + `\n\n` + `response.text`
     (+ `\n(+N earlier entries dropped)` when `droppedEntries > 0`);
     `details` = the full `HostBridgePreviewLogs`.
3. **`before_agent_start` handler** (rookie only): when `config.mode ===
   "rookie"` and the client is available, `await getPreviewState(config.tabId)`
   (catch → skip silently) and return
   `{ systemPrompt: event.systemPrompt + "\n\n" + formatPreviewStateBlock(state) }`
   when `state.available`.
4. Graceful degradation everywhere: missing env / unreachable bridge → tools
   return the "unavailable" text, injection skips. Never throw out of
   `execute`.

**`packages/agent/src/cli.ts`** (MODIFY): register **last**, with a comment —
pi chains `before_agent_start` handlers in registration order and
`herman-extension` *replaces* the system prompt, so the preview block must be
appended after it:
```ts
extensionFactories: [hermanExtension, contextReporterExtension, previewContextExtension],
```

**`packages/agent/src/extensions/herman-extension.ts`** (MODIFY): delete the
`herman_get_session_info` registration and the inline
`SESSION_INFO_SENTINEL`/envelope block (moved to the new extension).

**`packages/agent/src/prompts/rookie.md`** (MODIFY):
- Replace the "call `herman_get_session_info` before links" block with: the
  live preview state is shown every turn in `<herman_preview_state>` (URL,
  port, open page); still call `herman_get_session_info` when you need
  worktree/project details or the freshest URLs before printing links.
- Add a debugging bullet: *"When the user says something is broken, blank, or
  not working, call `herman_get_preview_logs` with `environment: 'server'`
  and `'console'` first — never ask the user to copy error messages, and don't
  restart the dev server yourself."*

**`apps/desktop/src/views/main/lib/preview-errors.ts`** (MODIFY): in
`buildAskHermanPrompt`, append one line to all three variants:
*"Recent preview logs are available via the `herman_get_preview_logs` tool
(environment: 'server' and 'console') — use it for full context before and
after the error."*

### G. Desktop wiring

**`bun/agent-bridge.ts`** (`start()`): after computing `env`, inject
```ts
const hostBridge = getActiveHostBridge();
if (hostBridge) {
  env.HERMAN_HOST_BRIDGE_URL = hostBridge.url;
  env.HERMAN_HOST_BRIDGE_TOKEN = hostBridge.token;
}
```
This automatically covers tab agents, wizard agents, and headless runs — all
spawn through `AgentBridge`.

**`bun/index.ts`** (startup order matters — the bridge must exist before any
agent spawns, and `restore()` spawns agents):
1. Immediately after `agentProcessManager` is constructed and **before**
   `agentProcessManager.restore()`:
   ```ts
   const previewContext = new PreviewContextService({
     getTab: (tabId) => agentProcessManager.getTab(tabId),
     getMode,                           // existing top-level getMode() in index.ts (line 152)
     getFleetStatus: (folderPath) => getDevServerStatus(folderPath),
   });
   setPreviewLineHandler((line) => previewContext.handleServerLine(line));
   await startHostBridgeServer([
     { method: "GET", pattern: "/v1/health", handler: () => ({ ok: true, version: HOST_BRIDGE_PROTOCOL_VERSION }) },
     ...previewContextRoutes(previewContext),
   ]);
   ```
2. `previewContextRoutes` lives in
   `bun/host-bridge/routes/preview-context.ts` (NEW) and maps:
   - `GET /v1/tabs/:tabId/session-info` → `service.getSessionInfo(tabId)`
   - `GET /v1/tabs/:tabId/preview/state` → `service.getPreviewState(tabId)`
   - `GET /v1/tabs/:tabId/preview/logs` → parse + validate query
     (`environment` missing/invalid → `HostBridgeError(400, "bad_request", …)`;
     numbers clamped) → `service.getPreviewLogs(tabId, query)`
3. Add the two RPC message handlers (see §E).
4. In `agentProcessManager.closeTab` — or via a subscription from index.ts if
   cleaner — call `previewContext.clearTab(tabId)`. Preferred: expose a
   callback on `AgentProcessManagerOptions` (`onTabClosed?: (tabId) => void`)
   fired at the end of `closeTab`; wire it in index.ts. (Keeps
   `AgentProcessManager` free of preview imports.)
5. App shutdown: best-effort `hostBridge.stop()` wherever
   `stopAllDevServers()` is called on quit; the OS reclaims the port regardless.

---

## Cutover & deletions (Phase 4)

Once the new extension ships, delete the sentinel session-info path:

| Delete | Notes |
|---|---|
| `apps/desktop/src/shared/session-info-protocol.ts` | replaced by `HostBridgeSessionInfo` (+ assembly in the service) |
| `apps/desktop/src/bun/session-info-host.ts` | logic moved into `PreviewContextService.getSessionInfo` |
| `tryParseSessionInfoRequest` in `shared/agent-protocol.ts` | along with its session-info imports |
| `AgentProcessManager.tryRespondSessionInfo` + its call site in `startBridge` | `agent-process-manager.ts:978` (call) and `:1172` (method); the bridge event callback returns to pure forwarding |
| Session-info block in `herman-extension.ts` | tool + sentinel constants (moved) |
| `test/bun/session-info-protocol.test.ts`, `test/bun/session-info-host.test.ts` | superseded by service tests |

**Keep**: the wizard-ask sentinel (`__herman_wizard__`) — it is an interactive
renderer dialog, not host RPC. Add a comment at
`tryParseWizardRequest` stating the boundary: *interactive user dialogs ride
`ctx.ui.editor`; silent host queries ride the host bridge HTTP API.*

## Phases & acceptance criteria

### Phase 1 — Host-side foundation (bun only, zero behavior change)
Files:
- NEW `packages/rpc/src/host-bridge.ts` (+ `package.json` export entry)
- NEW `apps/desktop/src/bun/host-bridge/server.ts`
- NEW `apps/desktop/src/bun/host-bridge/routes/preview-context.ts`
- NEW `apps/desktop/src/bun/preview-context/{ring-buffer,format,service}.ts`
- MODIFY `bun/preview/{types,preview-manager,index}.ts`, `bun/preview-server.ts`, `shared/preview.ts`
- MODIFY `bun/agent-bridge.ts`, `bun/index.ts`
- Tests: `test/bun/host-bridge-server.test.ts`, `test/bun/preview-context-service.test.ts`, `test/bun/preview-context-format.test.ts`, `test/bun/ring-buffer.test.ts`, tap case in the preview-manager tests.

Acceptance: old sentinel path still works end-to-end; bridge answers
`/v1/health` and the three routes with correct auth behavior; server lines
accumulate in rings while a preview runs; `bun test test` + `tsc --noEmit`
green in `apps/desktop` and `packages/rpc`.

### Phase 2 — Renderer plumbing
Files: everything in §E + tests
(`test/views/preview-webview-bridge.test.ts` updated,
NEW `test/views/preview-console-reporter.test.ts`).

Acceptance: console.* of every level lands in the bun ring (verify via the
`/preview/logs?environment=console` route with curl while the app runs);
navigation updates `currentUrl`; error toasts still fire exactly as before;
`preview-store` runtime-error flow untouched.

### Phase 3 — Agent side
Files: everything in §F + tests
(`packages/agent/test/host-bridge/client.test.ts`,
`packages/agent/test/extensions/preview-context-extension.test.ts`,
`packages/agent/test/prompts/preview-state.test.ts`).

Acceptance: in a dev app, the agent answers with the real URL when asked;
`herman_get_preview_logs` returns server + console output; the system prompt
carries `<herman_preview_state>` in rookie mode only; agent without bridge env
(standalone CLI) degrades gracefully; `bun test test` + `tsc --noEmit` green
in `packages/agent`.

### Phase 4 — Cutover & docs
Files: deletions per table; UPDATE `apps/desktop/AGENTS.md` (architecture +
source-layout rows for `host-bridge/` and `preview-context/`); NEW
`.agents/docs/host-bridge.md` (one page: protocol, routes, auth, how to add a
route — so future agents extend this correctly).

Acceptance: no references to `session-info-protocol` / `session-info-host` /
`tryRespondSessionInfo` / `SESSION_INFO_SENTINEL` remain (`rg`); wizard flow
unaffected; full `bun test` at repo root + `bun run typecheck` green.

## Test notes (conventions to follow)

- All tests run via `bun test` (vitest API-compat imports are the local
  style, see `herman-extension.test.ts`).
- Host-bridge server tests can `Bun.serve` for real on port 0 — no mocks
  needed; same for the agent client tests (fake server asserting the
  `Authorization` header).
- `PreviewContextService` is constructed with injected `getTab` /
  `getFleetStatus` fakes — no PreviewManager needed.
- The extension test harness pattern already exists in
  `packages/agent/test/extensions/herman-extension.test.ts` (mock `pi` API
  capturing `registerTool`/`on`); reuse it.

## Edge cases & failure modes

- **Port changed mid-session** (restart on a busy port): status feed updates
  the service; next turn's `<herman_preview_state>` shows the new URL; tools
  always read live state.
- **Server crashed**: rings survive the instance; `phase: "failed"` + error in
  state block; logs still queryable.
- **Preview not open / normal mode**: `state.available` true but phase
  `stopped` (rookie) → block says "not running"; normal mode → no injection
  at all; tools answer gracefully.
- **Console spam**: renderer rate-limits + dedupes; rings cap; drops are
  counted and surfaced in tool output.
- **Bridge down / token mismatch**: client throws typed errors; tools return
  "unavailable" text; injection skips. Nothing throws across the extension
  boundary.
- **Tab closed**: `clearTab` frees console ring + navigation; server rings
  evicted by the 20-key cap.
- **Wizard agents**: get the bridge env for free (shared `AgentBridge`), but
  their `wizard-*` ids aren't tabs → `tab_not_found` → graceful tool text.
  (Future: a wizard-scoped preview integration; out of scope here.)
- **Multiple servers (fleet)**: `serverId` param selects; default = primary.
  Console entries belong to the tab's pane regardless of which server is
  shown.

## Non-goals

- Pushing events mid-turn to the agent (pi has no clean channel for it; the
  per-turn refresh + live tools cover the need).
- Changing the renderer's error-toast UX or the preview-store.
- Wizard-phase preview integration (noted as future work above).
- Giving the agent preview *control* (start/stop/restart). Read-only on
  purpose; trivially additive later as new routes if wanted.
