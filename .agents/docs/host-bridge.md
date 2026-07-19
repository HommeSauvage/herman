# Host Bridge

The host bridge is a localhost HTTP API that lets the agent subprocess query the
Herman desktop for live preview state, logs, and session info — silently, without
going through a UI dialog.

## Protocol

- **Transport:** HTTP/1.1 on `127.0.0.1`, OS-assigned ephemeral port.
- **Auth:** Bearer token (random UUID), set at server start.
  Header: `Authorization: Bearer <token>`.
- **Content type:** `application/json` for both request and response bodies.
- **Error shape:** `{ "error": string, "code": string }`

## Routes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/v1/health` | ❌ | Liveness check. Returns `{ "ok": true, "version": 1 }`. |
| GET | `/v1/tabs/:tabId/session-info` | ✅ | Full session info (project path, worktree, preview servers, current page URL). |
| GET | `/v1/tabs/:tabId/preview/state` | ✅ | Compact preview state for per-turn prompt injection. |
| GET | `/v1/tabs/:tabId/preview/logs?environment=console\|server` | ✅ | Recent browser console or dev-server terminal logs. |
| POST | `/v1/tabs/:tabId/browser/goto` | ✅ | Headless browser navigate (`{ url? }` or `{ path? }` relative to primary preview). |
| GET | `/v1/tabs/:tabId/browser/screenshot` | ✅ | JPEG screenshot of the current page (query `fullPage=true` optional). |
| POST | `/v1/tabs/:tabId/browser/act` | ✅ | Click/fill/press/scroll steps (`{ steps: BrowserActionStep[] }`). |
| GET | `/v1/tabs/:tabId/publishing/config` | ✅ | Full publishing config for the tab's project (server IP, SSH key path, Coolify URL + API token, recorded project/app IDs). 404 `no_publishing_config` when unset. |
| POST | `/v1/tabs/:tabId/publishing/config` | ✅ | Agent write-back of deployment results (`{ coolifyProjectId?, coolifyProjectName?, coolifyApplicationId?, domain?, status? }`; `null` clears, absent keeps, `status` only advances). |

`:tabId` may be a normal tab id **or** a wizard session id (`wizard-…`). Preview
context resolves wizard ids to `wizard:<id>` scopes so QA agents can read logs
and drive the browser without a UI tab.

Wizard coding/QA **completion gates** do **not** use the host bridge (HTTP
timeouts are too short). They ride the editor sentinel channel
(`__herman_gate__`) so verification can take minutes.

### Logs query parameters

| Param | Type | Default | Max | Description |
|-------|------|---------|-----|-------------|
| `environment` | `"console" \| "server"` | *(required)* | — | Which log source to fetch. |
| `serverId` | string | primary | — | Server to query (env=server only). |
| `maxEntries` | number | 50 | 200 | Max log lines/entries to return. |
| `maxLinesBeforeAfter` | number | 25 | 100 | Context lines around each error. |

## How to add a route

1. Add a new route builder in `packages/rpc/src/host-bridge.ts` (`HOST_BRIDGE_ROUTES`).
2. Add any new wire types in the same file.
3. Register a handler in `apps/desktop/src/bun/host-bridge/routes/preview-context.ts`
   (or create a new routes file for a different feature domain).
4. Add the client method in `packages/agent/src/host-bridge/client.ts`.

The host bridge server is generic — it does pattern matching and auth. Routes
are just functions that return (or throw) JSON-serializable values.

## Architecture

```
agent subprocess                    desktop (bun)
(packages/agent)                    (apps/desktop)

preview-context-extension.ts        HostBridge Server (Bun.serve)
  └─ host-bridge/client.ts ──HTTP──   └─ routes/preview-context.ts
       (Bearer token)                      └─ PreviewContextService
                                               ├─ server rings (per folder+server)
                                               ├─ console rings (per tab)
                                               └─ navigation URLs (per tab)
```

The `PreviewContextService` is the single owner of what the agent knows about
previews. It receives feeds from:
- **PreviewManager** (via `emitLine`): every stdout/stderr line from dev servers.
- **Renderer** (via RPC messages `previewConsoleBatch` / `previewNavigated`):
  browser console output and page navigation events from the webview preload.

The old sentinel-editor channel (`__herman_session_info__` via `ctx.ui.editor`)
is replaced entirely by the host bridge HTTP API. The wizard-ask sentinel
(`__herman_wizard__`) keeps using `ctx.ui.editor` because it is an interactive
user dialog, not a silent RPC.

## Graceful degradation

The agent client handles all failure modes without throwing across the extension
boundary:
- Missing env vars (`HERMAN_HOST_BRIDGE_URL` / `_TOKEN`) → tools return
  "unavailable" text.
- Network errors / timeouts → `HostBridgeUnavailableError` → "unavailable".
- Non-2xx responses → `HostBridgeRequestError` → descriptive error text.
- Preview state injection is silently skipped when the bridge is unavailable.
