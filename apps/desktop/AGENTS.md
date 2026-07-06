# Herman Desktop

Herman Desktop is the client side of the coding agent, built with [Electrobun](https://electrobun.dev). It manages agent subprocesses, provider credentials, project sessions, and renders the chat UI.

## Architecture

The app runs in two processes within a single Electrobun window:

- **Main process** (`src/bun/`) — Bun runtime. Spawns and manages agent subprocesses, persists settings and credentials, handles device activation, OAuth flows, and ad telemetry.
- **Renderer** (`src/views/main/`) — Webview. React UI built with Vite and Tailwind CSS. Communicates with the main process through Electrobun's RPC bridge (`src/shared/rpc.ts`).

Shared types and utilities live in `src/shared/`.

## Electrobun

This is **not** Electron + Bun. Electrobun is an entirely different framework with its own APIs for windows, menus, views, RPC, and build tooling.

Full Electrobun API docs are at `.agents/electrobun/` in the repo root (`.mdx` files covering APIs, build config, browser APIs, and guides).

The `electrobun.config.ts` at the project root defines the build entrypoint, view configuration, platform-specific settings (icons, code signing), and the assets copied into the final bundle.

During development, `scripts/dev.ts` starts both the Vite dev server (port 3456) and Electrobun in dev mode. The dev URL is wired through the `HERMAN_DESKTOP_DEV_URL` env var.

## Key source layout

```
src/
├── bun/                  Main process (Bun)
│   ├── index.ts          Entrypoint — RPC handlers, window setup, menu, activation
│   ├── agent-bridge.ts   Spawns and manages a single agent subprocess per tab
│   ├── agent-process-manager.ts  Multi-tab orchestration, session persistence
│   ├── agent-process.ts  Low-level subprocess lifecycle (start, stop, crash)
│   ├── activation.ts     Device authorization flow via better-auth
│   ├── credentials.ts    Encrypted at-rest credential store
│   ├── settings.ts       User settings persistence
│   ├── session.ts        Auth session persistence
│   ├── herman-api.ts     Raw fetch wrappers for the server API
│   ├── oauth.ts          OAuth flow for provider logins
│   ├── keychain.ts       OS keychain abstraction
│   ├── ad-telemetry.ts   Window focus/visibility telemetry
│   ├── project-files.ts  Fuzzy file search within open projects
│   └── persistence/      SQLite-based persistence (tab history, composer drafts)
├── shared/               Types and utilities shared between main and renderer
│   ├── rpc.ts            Electrobun RPC contract
│   ├── agent-protocol.ts JSON-RPC event parsing, ad event detection
│   └── apply-agent-event.ts  State machine for applying agent events to message lists
└── views/main/           Renderer (React)
    ├── main.tsx          App root, RPC bridge setup
    ├── index.css         Global styles, theme tokens, animations
    ├── components/       UI components (composer, message list, sidebar, settings, tabs)
    ├── hooks/            React hooks (useStreamingThrottle, useAgentEvents, etc.)
    ├── lib/              State management (zustand stores), utilities
    └── types/            Renderer-specific type declarations
```

## Providers & Bring-Your-Own-Key (BYOK)

Herman supports multiple LLM providers alongside the built-in Herman proxy.

- **Herman provider** is the built-in proxy. It always appears first in the provider list. Its action is Enable/Disable rather than Connect/Disconnect. When disabled, features that depend on the server (activation, ads, analytics, title generation, provider pins) are gated off.
- **Other providers** follow the pi-agent pattern: pick a provider, authenticate (API key or OAuth), and the provider's models appear in the model selector.
- **Settings is a page**, not a modal. It replaces the content area while keeping the sidebar visible.

### Key design points

- Model ids are provider-prefixed: `herman/kimi-k2.7-code`, `openai/gpt-4o-mini`.
- Provider credentials are stored by the main process (OS keychain when available, encrypted JSON fallback).
- The agent CLI receives provider config via `HERMAN_AGENT_DIR`, which contains `auth.json` and `models.json` in pi-coding-agent format.
- The Herman extension (`packages/agent/src/extensions/herman-extension.ts`) is loaded by the agent subprocess and registers the Herman provider dynamically.

### Implementation overview

| Concern | Location |
|---|---|
| Settings state | `src/bun/settings.ts` — `userData/settings.json` |
| Credential store | `src/bun/credentials.ts` — `userData/credentials.enc.json` |
| Provider metadata | `src/bun/index.ts` — `BUILTIN_PROVIDERS` |
| Settings page | `src/views/main/components/settings-view.tsx` (Providers, Models, General tabs) |
| Provider auth dialog | `src/views/main/components/settings/provider-auth-dialog.tsx` |
| Model selector | `src/views/main/components/model-selector.tsx` (grouped by provider) |
| Agent spawn | `src/bun/agent-bridge.ts` — writes per-tab agent config |
| Herman gating | `src/bun/index.ts`, `src/bun/agent-process-manager.ts` — gated on `providers.herman.enabled` |

## Agent lifecycle

Each open tab has its own agent subprocess, spawned via `agent-bridge.ts`. The subprocess runs `packages/agent/src/cli.ts` (the `@herman/agent` package), which is bundled into `dist/cli.js` and copied into the app bundle at build time.

Communication between the main process and the agent uses JSON-RPC over stdin/stdout. Events flow through `agent-process-manager.ts`, which persists messages, manages session archives, and broadcasts state changes to the renderer.

## Environment variables

| Variable | Description |
|---|---|
| `HERMAN_SERVER_URL` | Server base URL (default: `http://localhost:4000`) |
| `BETTER_AUTH_URL` | Auth server URL (default: `http://localhost:3000`) |
| `HERMAN_DESKTOP_DEV_URL` | Vite dev server URL (sets dev mode) |
| `HERMAN_DESKTOP_LOG_LEVEL` | Log level (default: info) |
| `HERMAN_DESKTOP_LOG_FILE` | Enable file logging |
| `HERMAN_DESKTOP_UPDATE_BASE_URL` | Auto-update base URL |
| `HERMAN_AGENT_PATH` | Custom path to the agent binary (overrides bundled) |
| `ENABLE_EMAIL_AUTH` | Enable email-based auth flow |

## Scripts

| Script | Purpose |
|---|---|
| `dev` | Start Vite + Electrobun in dev mode |
| `build` | Production build (macOS code sign off by default) |
| `build:canary` | Canary channel build |
| `test` | Run all tests |
| `typecheck` | TypeScript check |
| `inject-dev-session` | Inject a test session for local development |
