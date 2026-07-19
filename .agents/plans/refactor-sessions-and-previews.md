# Refactor: Sessions, Tabs, Worktree Setup & Preview Panes

> Status: DRAFT — ready for implementation
> Owner: coder agent
> Created: 2026-07-19
> Scope: `apps/desktop` (main process + renderer), `packages/rpc` (types only), `apps/desktop/templates`

## Goal

Make tab/session lifecycle and preview panes coherent, reliable, and project-agnostic:

1. **Every rookie session is isolated** — including the first session after the wizard (today it opens directly on the main project).
2. **Session setup is manifest-driven** — each new worktree runs the project's declared setup recipe (composer install, `.env` provisioning, sqlite creation + migrations + seed, bun install, …), with per-step progress in the UI, idempotent resume after failure/quit, and a clear error state.
3. **Previews never clash** — servers are owned per tab (not per folder), ports are allocated atomically and injected via manifest-declared env vars, and a preview only starts after its session's workspace is fully set up.

This replaces the current split-brain model (hardcoded bun/npm install in `worktree.ts`, a separate `node_modules` heuristic in the preview subsystem, renderer-driven preview auto-start keyed on `folderPath`) with a single main-process pipeline.

---

## Part 1 — Verified root causes of the reported bugs

### Bug A — New tab stuck at "Preparing your session…" (left side)

**Repro path (rookie mode, project with git repo):**

1. `createTab()` sets `tab.worktreeStatus = "pending"` and returns immediately; worktree creation runs in the background (`finalizeTabWorktree`).
   — `apps/desktop/src/bun/agent-process-manager.ts:272-303`
2. `NewSessionView` renders "Preparing your session…" while `worktreeStatus === "pending"`.
   — `apps/desktop/src/views/main/components/new-session-view.tsx:24-39`
3. When the worktree is ready, `finalizeTabWorktree` emits
   `tabFolderChanged({ tabId, folderPath, projectRoot, worktree, worktreeStatus: "ready" })`.
   — `apps/desktop/src/bun/agent-process-manager.ts:1503-1510`
4. **The event never reaches the renderer intact.** The `WebviewSender` wiring in `src/bun/index.ts` destructures and re-sends only three fields:

   ```ts
   // apps/desktop/src/bun/index.ts:1032-1036
   tabFolderChanged: (payload) => {
     const { tabId, folderPath, projectRoot } = payload;
     logger.trace("Tab folder changed", { tabId, folderPath, projectRoot });
     webviewRpc.send.tabFolderChanged({ tabId, folderPath, projectRoot });
   },
   ```

   `worktree`, `worktreeStatus`, and `error` are silently dropped. The renderer handler in `app.tsx` only clears the pending flag when it receives one of those fields (`app.tsx:192-197`), so the tab stays `"pending"` forever → spinner forever. Queued composer messages also never flush (`composer.tsx:252-269` waits for the same transition), and `tab.worktree` never reaches the renderer, so `isWorktree` is false → the preview **Save** button and draft refresh are disabled (`rookie-shell.tsx` → `PreviewPane isWorktree`).

5. The error path is equally broken: `finalizeTabWorktree`'s catch sends `{ tabId, worktreeStatus: "error", error }` — all stripped by the same forwarding handler.

**This is a one-line-class bug, but the fix must be structural** (see Part 3): the forwarding layer should pass payloads through untouched, typed so dropped fields are a compile error.

### Bug B — Preview fails with `vendor/autoload.php` missing (right side)

Observed log sequence for `mamine-cooking-v2` (Laravel, manifest `dev.install: composer run setup`, server `composer run dev` port 8000):

```
11:59:14.513  worktree  Running install command  installCommand: 'bun install'
11:59:14.870  worktree  Install command completed
11:59:14.872  agent     Session worktree ready
11:59:14.899  preview   Spawning preview child    command: 'composer run dev' port: 8000
11:59:15.252  preview   Preview error line detected  (vendor/autoload.php: No such file or directory)
11:59:15.259  preview   Preview server exited with error  exitCode: 255
```

Chain of failures:

1. **Worktree setup is hardcoded and ecosystem-blind.** `createSessionWorktree` (`worktree.ts:165-181`) does exactly three things: `git worktree add`, `copyEnvFiles(repoRoot, folderPath)` (root-level `.env*` files only), `ensureNodeModulesInstalled()` which picks `bun install` or `npm install` from lockfiles (`detectInstallCommand`, `worktree.ts:66-70`). **It never reads the project manifest** — no `composer install`, no sqlite file creation, no migrations, no seed. Verified on disk: the worktree from the logs has `node_modules/` and `.env` but no `vendor/` and no `database/database.sqlite`.
2. **The preview's own install gate is a wrong heuristic.** The renderer auto-starts the preview the moment the tab's folder flips to the worktree (`preview-store.ts: loadAndStart`). The main-process `startPreview` handler correctly resolves `installCommand = manifest.install = "composer run setup"`, but `PreviewManager` only runs it when `shouldInstall()` returns true, and `shouldInstall` is `!existsSync(node_modules)` (`preview/index.ts:69-71`). `bun install` just created `node_modules` during worktree creation → **install skipped entirely** → `composer run dev` spawned against a project with no `vendor/` → `artisan` dies on line 10 → exit 255.
3. Even when install *does* run, it is a single opaque command with a 5-minute ceiling (`runInstallCommand`, `worktree.ts:80-122`), no per-step progress, no partial resume, no seeding step, and no DB file creation. Laravel's own `composer run setup` doesn't `touch database/database.sqlite` for a worktree (that only happens in `post-create-project-cmd`), so even a perfect `composer run setup` can stall on the interactive "create the sqlite file?" prompt.

### Bug C — First session after the wizard is not isolated

`adoptWizardSession` (`agent-process-manager.ts:308-324`) deliberately opens the project directory directly — the comment says a fresh worktree from HEAD "would drop those [uncommitted wizard] changes". **That rationale is stale**: the same RPC handler runs `setupProjectRepo()` first (`index.ts:712-737`, `project-manifest.ts:162-188`), which removes the template's `.git`, runs `git init`, and commits *everything* ("Initial project"). A worktree from HEAD would contain the full wizard output.

Consequences of the current inconsistency:

- The first session edits the main tree directly (no isolation, no Save/apply flow since `isWorktree` is false).
- **Reopening that session later silently migrates it into a worktree**: `openSession()` sees rookie + git repo + no `tab.worktree` → `needsWorktree = true` (`agent-process-manager.ts:354-365`). Any uncommitted changes the first session left on main vanish from the user's point of view, and the pi session's recorded `cwd` (project root) no longer matches where the agent runs.

### Secondary defects found during the investigation (must be fixed by the redesign)

| # | Defect | Evidence |
|---|--------|----------|
| D1 | **Preview auto-starts against the wrong folder.** `PreviewPane` activates the preview store with whatever `folderPath` the tab currently has — including the *temporary project root* assigned while `worktreeStatus === "pending"` (`agent-process-manager.ts:294`, `rookie-shell.tsx` PreviewPane mount, `preview-store.ts:activate`). A dev server can be spawned on the **main project tree** while the worktree is being built. | `use-preview-controller.ts`, `preview-store.ts:155-220` |
| D2 | **Port allocation is racy and wrong for non-node servers.** `findFreePort` probes-then-releases (TOCTOU). The child gets `PORT=<n>` env (`preview-process.ts:39-44`), but `php artisan serve` reads `SERVER_PORT` (default option value `Env::get('SERVER_PORT')` — verified in `vendor/laravel/framework/src/Illuminate/Foundation/Console/ServeCommand.php:449`), and `artisan dev` hardcodes `serve --host=localhost` with no port flag (`vendor/.../DevCommands.php:58`). Two tabs of the same project both bind 8000; the readiness probe can then report the *other* session's server as "ready" (cross-contamination). Vite inside `artisan dev` also binds a fixed 5173. | `preview-ports.ts`, `preview-process.ts` |
| D3 | **`.env` copying is root-only and verbatim.** `copyEnvFiles` (`worktree.ts:133-138`) copies only top-level `.env*` files, unmodified. Values that point into the main project (absolute `DB_DATABASE`, `APP_URL=http://localhost:8000`, ports) silently break worktree isolation. The manifest `env:` section (`EnvConfigSchema` — file/vars/generate/default) is completely unused by worktree setup. Verified: main `.env` has `APP_URL=http://localhost`; worktree copy is identical. | `worktree.ts`, `project-env.ts` (orphaned, wizard-only) |
| D4 | **Setup is not resumable.** If the app quits mid-setup, `restore()` sees the worktree folder exists and starts the agent (`agent-process-manager.ts:230-237`); the preview's `node_modules` heuristic then skips install. A half-provisioned worktree persists forever. No stamp, no per-step tracking. | `agent-process-manager.ts:restore` |
| D5 | **pi sessions created in worktrees are invisible to the project's session list.** pi JSONL headers record `cwd` = worktree path (`~/Herman/.worktrees/<tabId>`); `listPiSessionsForProject(projectRoot)` matches by cwd → worktree sessions never appear; `getProjectFoldersFromPiSessions` even surfaces worktree dirs as projects. | `pi-sessions.ts` |
| D6 | **Worktree/branch GC is absent.** One `~/Herman/.worktrees/<tabId>` dir + `herman/session/<tabId>` branch per tab, removed only when closing a tab *with no conversation* (`agent-process-manager.ts:closeTab`). Orphans from crashes accumulate (verified: dozens of orphan dirs in `~/Herman/.worktrees`). | `worktree.ts`, `closeTab` |
| D7 | **Native preview BrowserView lifecycle races.** Logs show `webviewTagSetHidden/UpdateSrc: BrowserView not found or has no ptr for id N` at tab transitions — the renderer keeps sending commands for native views already removed (unmount/src-change races in `PreviewWebview`). | `preview-webview.tsx`, electrobun preload |
| D8 | **Preview server identity is folderPath-keyed.** `PreviewManager` keys instances by `folderPath::serverId`; two tabs sharing a folder (possible in normal mode, or the error fallback where `tab.folderPath` stays on the project root) share/kill each other's servers. Ownership should be per session/tab. | `preview/types.ts: previewKey` |
| D9 | **Wizard QA preview server leaks into the session era.** The QA phase can run a dev server on the main project; nothing stops it at handoff, so it can hold port 8000 when the first session's preview starts. | `adoptWizardSession` (no `stopDevServer(projectPath)`) |
| D10 | **`mode === "rookie"` worktree policy is sprinkled across three methods** (`createTab`, `openSession`, `openPiSession`), each with slightly different rules. No single place answers "what isolation does this session get?". | `agent-process-manager.ts` |
| D11 | `detectInstallCommand` knows only bun/npm — no pnpm/yarn/composer/etc. Used as the preview install fallback (`index.ts:786-789`). Should die with the heuristic. | `worktree.ts:66`, `index.ts` |
| D12 | `restore()` skips agent start when the folder is missing but leaves the tab pointing at a dead path; no repair flow. Related: no re-validation that a restored worktree is actually provisioned. | `agent-process-manager.ts:218-237` |

---

## Part 2 — Design principles for the refactor

1. **One pipeline, one owner.** A tab goes from *created* to *ready* through a single main-process pipeline (the **Session Bootstrapper**). Nothing else creates worktrees, runs installs, starts agents, or starts previews. The renderer renders state; it never triggers setup side effects.
2. **The manifest is the setup recipe.** `herman.yaml` declares *how to prepare a fresh workspace* (ordered steps), *how to run servers* (with explicit port env), and *which env vars matter*. Herman never guesses ecosystems.
3. **Setup is idempotent and resumable.** Steps declare skip conditions; a stamp file in the workspace records progress; interrupted setups resume/repair instead of being treated as done.
4. **Sessions own previews.** Preview servers, ports, logs, and webviews are keyed by tab/session id, allocated from one registry, and torn down with the session. A preview starts only when its session is `ready`.
5. **Ports are a managed resource.** One allocator, atomic hold-then-spawn, manifest-declared env injection (`portEnv`, `{port}` templating), and readiness probes that hit the allocated port only after spawn.
6. **State transitions are explicit and observable.** The tab carries a `setup` state machine with step-level detail; every transition is pushed to the renderer over a single typed event (`sessionStateChanged`). No derived heuristics in the UI.
7. **Greenfield inside the repo.** We are allowed to break internal shapes (Tab fields, RPC payloads, window-state format gets a migration), but we keep `herman.yaml` back-compatible (`dev.install` maps onto the new setup model).

---

## Part 3 — Target architecture

### 3.1 The Session Bootstrapper (new, main process)

New module: `src/bun/session-bootstrap/` (replaces the worktree half of `agent-process-manager` and the setup half of `worktree.ts`).

```
createTab / openSession / openPiSession / adoptWizardSession / restore
        │
        ▼
┌─ SessionBootstrapper.bootstrap(tabId, intent) ────────────────────────┐
│  1. plan      → resolve project root, read manifest, decide isolation │
│  2. provision → ensure git repo (wizard path already committed),      │
│                 create/re-attach worktree (rookie policy),            │
│  3. setup     → WorkspaceSetupRunner: ordered manifest steps,         │
│                 env provisioning, per-session env rewrites,           │
│                 idempotent + stamped + resumable                      │
│  4. agent     → AgentRuntime.schedule(tabId)  (existing)              │
│  5. preview   → PreviewManager.ensureStartedForTab(tabId) (rookie,    │
│                 manifest servers present)                             │
│  every transition → emit sessionStateChanged(tabId, setupState)       │
└────────────────────────────────────────────────────────────────────────┘
```

**New tab state machine** (replaces `worktreeStatus`):

```ts
type SessionSetupState =
  | { phase: "none" }                                  // normal-mode, non-git, or direct-on-main by policy
  | { phase: "pending"; step?: string; label?: string } // provisioning/setting up
  | { phase: "ready" }
  | { phase: "error"; step?: string; error: string; retryable: boolean };
```

Carried on `Tab.setup` (and a compact form on `PersistedSession` so restore can resume). Emitted via a **new single push event** `sessionStateChanged { tabId, setup, folderPath?, worktree? }` that fully replaces the overloaded `tabFolderChanged` (keep the old event as a deprecated alias during migration, or migrate all listeners in one go — preferred, greenfield).

**Isolation policy** (one function, `resolveIsolationPolicy(mode, projectRoot, opts)`):

| Situation | Policy |
|---|---|
| rookie mode + git repo | `worktree` (always — incl. wizard first session and reopened sessions) |
| rookie mode + non-git folder | `direct` (no worktree possible; setup steps still run in place? — no: setup steps are for *fresh copies*; run `ensure` steps only — see open question Q3) |
| normal mode | `direct` (unchanged from today) |

A session's isolation is **fixed at creation and persisted** (`PersistedSession.isolation: "worktree" | "direct"`). `openSession`/`restore` never upgrade `direct → worktree` (kills the silent-migration bug C). Reopening a `direct` session stays direct forever; a banner may offer "move future sessions to isolated workspaces" (out of scope for v1).

### 3.2 Wizard handoff unification (fixes issue #1)

- `adoptWizardSession` stops being a special path: after `setupProjectRepo()` (which already commits everything — `project-manifest.ts:162-188`), the first session goes through the **same bootstrap pipeline** as any rookie tab → gets a worktree + full setup + agent + preview.
- Delete the stale comment and the `no-worktree` branch. The only remaining special-casing: `adoptWizardSession` creates a fresh pi session (no resume) and skips the post-handoff `/goal` — keep those.
- **Stop the wizard QA preview** at handoff: `await stopAllPreviewsForProject(projectPath)` inside the `adoptWizardSession` RPC handler before bootstrapping (fixes D9). Note the wizard tab itself uses a separate bridge — only preview servers need stopping.
- Edge case: if `setupProjectRepo` failed (no git repo), the first session falls back to `direct` isolation per the policy table, and the failure is logged + surfaced in the tab's setup state.

### 3.3 Manifest v2 — ground-up redesign of `herman.yaml`

The v1 schema evolved around the wizard: a single `env.file`, wizard-collection vars, `dev.install` as one opaque command, `dev.servers` for preview. The session/worktree era needs the manifest to be a **complete, declarative recipe for preparing and running a fresh workspace** — per-project setup sequences (composer vs bun vs prisma vs nothing), per-project env files (`.env` vs `.env.development.local`), and per-session values (ports, URLs) that shell commands cannot know. We have greenfield license: restructure the schema as **v2**, with a read-time v1→v2 shim so existing user projects keep working.

#### v2 project manifest

```yaml
version: 2
name: Blog
description: A place to write and publish articles online.

requirements:                        # unchanged: machine-level tools, checked before anything runs
  - id: php
    label: PHP 8.3+
    check: php --version
    install: https://php.net

env:                                 # environment files, provisioned in declared order
  files:
    - path: .env                     # relative to the workspace root
      from_main: true                # copy from the main project when present (default true)
      from_example: .env.example     # else copy from this file inside the workspace; else create empty
      merge: missing_only            # missing_only (default) | force
      rewrite_paths: true            # rewrite absolute main-root paths → workspace paths (default true)
      vars:
        APP_KEY:
          generate: php artisan key:generate --show   # phase 3: runs AFTER setup steps, only if still missing
        DB_CONNECTION:
          value: sqlite
        DB_DATABASE:
          value: database/database.sqlite
        SERVER_PORT:
          session: primary_port      # built-in per-session binding (port reserved BEFORE setup runs)
        APP_URL:
          session: primary_url
        APP_NAME:
          value: "${HERMAN_PROJECT_NAME}"            # ${HERMAN_*} interpolation in literals
        # required + notes keep their wizard meaning (ask the user); wizard writes to main,
        # from_main then carries the values into every future worktree automatically.

setup:                               # ordered, idempotent tasks for a FRESH workspace
  - id: php-deps
    label: Installing PHP dependencies
    run: composer install
    skip_if: vendor/autoload.php     # path exists (workspace-relative) → skip
  - id: database
    label: Preparing the database
    run: touch database/database.sqlite && php artisan migrate --force
    skip_if: database/database.sqlite
  - id: seed
    label: Seeding the database
    run: php artisan db:seed
    optional: true                   # failure = warning, not blocker (static sites simply omit this)
  - id: js-deps
    label: Installing frontend dependencies
    run: bun install
    skip_if: node_modules

servers:                             # was dev.servers
  - id: web
    label: Website
    command: composer run dev        # {port} / {url} substituted at spawn
    port: 8000                       # preferred port; the ACTUAL reserved port is injected…
    portEnv: [SERVER_PORT, PORT]     # …through these env vars at spawn
    exportUrlAs: [APP_URL]           # unchanged: URL exported as process env for the server
    primary: true

guidance: |
  ...
```

**What changed and why:**

- `dev:` dissolved → top-level `setup:` + `servers:`. `dev.install` is **deleted** (shimmed, below): one opaque command can't resume, can't report per-step progress, can't skip what's done, and conflated installation with preview.
- `env` goes from one file + flat vars to ordered `files[]`, each with a **source strategy** (`from_main` → `from_example` → empty) and a **merge policy**. This is what expresses "Project A uses `.env`, Project B uses `.env.development.local`" declaratively.
- Env var values have exactly four sources, resolved in order: **already present** in the sourced file (wizard-collected main `.env` values ride along via `from_main`), `value` literal (with `${HERMAN_*}` interpolation), `session` binding, `generate` command. `required`/`notes` keep their wizard ask-the-user meaning.
- `session` bindings: `primary_port`, `primary_url`, `workspace`, `main`, `branch`, `tab_id`. (Multi-server manifests address siblings via interpolation: `${HERMAN_PORT_API}` / `${HERMAN_URL_API}` for server id `api`.)
- Every `run` step also receives the same values as **real process env** (`HERMAN_WORKSPACE`, `HERMAN_MAIN`, `HERMAN_BRANCH`, `HERMAN_PRIMARY_PORT`, `HERMAN_PRIMARY_URL`, `HERMAN_PORT_<SERVERID_UPPER>`, `HERMAN_URL_<SERVERID_UPPER>`) so scripts never need string interpolation.

#### The three motivating projects, expressed

Project A (Laravel — `composer run setup` does install/migrations/bun internally, plus explicit port env):
```yaml
version: 2
env:
  files:
    - path: .env
      vars:
        SERVER_PORT: { session: primary_port }
        APP_URL: { session: primary_url }
        APP_KEY: { generate: "php artisan key:generate --show" }
setup:
  - { id: setup, label: Installing dependencies, run: composer run setup }
  - { id: seed, label: Seeding the database, run: php artisan db:seed, optional: true }
servers:
  - { id: web, label: Website, command: composer run dev, port: 8000, portEnv: [SERVER_PORT], primary: true }
```

Project B (custom env file, bun workspace build, custom seed):
```yaml
version: 2
env:
  files:
    - path: .env.development.local
setup:
  - { id: deps, label: Installing dependencies, run: "bun install && bun build:workspace", skip_if: node_modules }
  - { id: seed, label: Seeding, run: "bun cli seed", optional: true }
servers:
  - { id: web, label: Website, command: "bun dev", port: 3000, portEnv: [PORT], primary: true }
```

Project C (prisma):
```yaml
version: 2
env:
  files:
    - path: .env
setup:
  - { id: deps, label: Installing dependencies, run: bun install, skip_if: node_modules }
  - { id: prisma, label: Generating Prisma client, run: bun prisma generate, skip_if: node_modules/.prisma }
  - { id: seed, label: Seeding, run: bun prisma seed, optional: true }
```

A static-site template simply omits `setup`/`env` (or keeps a single `bun install` step) — no seed, no database, nothing to provision.

#### Zod schema work (`src/shared/herman-manifest.ts`)

```ts
EnvVarValueSchema = {
  value?: string;            // literal; ${HERMAN_*} interpolated at provisioning time
  session?: "primary_port" | "primary_url" | "workspace" | "main" | "branch" | "tab_id";
  generate?: string;         // shell → stdout; phase 3
  required?: boolean;        // wizard: ask the user
  notes?: string;            // wizard: why/how copy
}
EnvFileSchema = {
  path: string;
  from_main?: boolean = true;
  from_example?: string;
  merge?: "missing_only" | "force" = "missing_only";
  rewrite_paths?: boolean = true;
  vars?: Record<string, EnvVarValueSchema>;
}
SetupStepSchema = {
  id: string; label: string; run: string;
  skip_if?: string;          // workspace-relative path exists → skip
  skip_if_env?: string;      // env var non-empty in `env_file` (default: first env file) → skip
  env_file?: string;
  optional?: boolean;
  timeout?: number;          // seconds (default 300, hard cap 900)
}
DevServerSchema += { portEnv?: string | string[] }   // normalize like exportUrlAs
HermanYamlSchema (project, v2)     = { version: 2, name?, description?, requirements?, env?: { files: EnvFileSchema[] }, setup?: SetupStepSchema[], servers?: DevServerSchema[], guidance? }
HermanFrontmatterSchema (template) = v2 runtime fields + wizard-only extras (extends, setup_goal, source, suitable_for, snapshot, category, icon)
```

`ProjectManifestView` changes accordingly: `servers` stays; `install`/`devCommand`/`devPort` legacy convenience fields are computed from the v2 shape for any consumer that still needs them during migration, then deleted.

#### v1 → v2 read shim

`migrateV1Manifest(raw)` (in `src/shared/herman-manifest.ts`, pure, tested):
- `dev.install` → `setup: [{ id: "install", label: "Running project setup", run: dev.install }]` (no skip conditions; the stamp file provides idempotency — NOT the old `node_modules` heuristic).
- `dev.servers` → `servers`.
- `env.file` + `env.vars: [{key, default, generate, ...}]` → `env.files: [{ path: env.file ?? ".env", vars: { [key]: { value: default, generate, ... } } }]`.
- Parser accepts `version: 1 | 2` (1 goes through the shim); `HERMAN_MANIFEST_VERSION` becomes `2`; `serializeHermanYaml` always writes v2. Regenerate `apps/desktop/schema/herman-frontmatter.v1.json` → `herman-frontmatter.v2.json`.
- `extends` merge semantics for arrays (`setup`, `env.files`, `servers`): **child replaces the parent array wholesale** (concat is an ordering trap). Document in `herman-md.ts` (`mergeFrontmatter`).

#### Templates & wizard alignment

- Rewrite all five templates (`base`, `blog`, `landing`, `store`, `laravel`) to v2 in M1, with real per-stack sequences (Laravel: the decomposed steps from the v2 example above rather than one `composer run setup` blob, so progress and resume are granular; static ones: `bun install` only, no seed).
- **Wizard goal drift is eliminated by construction**: the wizard's `setup_goal` is *generated from the resolved setup plan + env files* (`buildSetupGoal(plan)` in `setup-plan.ts`), so first-time setup of the main tree and every future worktree setup execute the same recipe. The wizard's env-collection phase reads the same `env.files[].vars` (`required` + `notes`) and writes to the MAIN project; `from_main: true` then carries those values into every worktree automatically.

### 3.4 WorkspaceSetupRunner (new)

`src/bun/session-bootstrap/setup-runner.ts` — executes the resolved plan in a fresh (or interrupted) workspace:

- **Inputs**: worktree path, main project root, resolved plan (setup steps + env files + servers), pre-reserved port assignments, stamp state.
- **Phase 1 — env-base (built-in, before setup steps)**: for each `env.files[]` entry in declared order:
  1. Resolve source: copy from the main project when `from_main` and present (main's file is the source of truth — wizard-collected secrets ride along) → else `from_example` → else create empty. Replaces today's root-only `copyEnvFiles` (D3): the manifest now says *which* files exist (`.env` vs `.env.development.local` vs several).
  2. When `rewrite_paths` (default): rewrite values that **start with the main project absolute path** → workspace path (absolute `DB_DATABASE`, log paths, etc.). This is what makes sqlite-style setups actually isolated. Log every rewrite at info level.
  3. Apply literal `value` vars (with `${HERMAN_*}` interpolation) and `session` bindings per the file's merge policy. Ports/URLs used here come from the **bootstrap plan phase**, which pre-reserves all server ports for the tab (see 3.5) — that is why port reservation happens *before* setup, not at preview spawn.
- **Phase 2 — setup steps**: sequential, `sh -c` (same as today), shell-env PATH already resolved at app start (`shell-env.ts`). Every step gets the `HERMAN_*` process env (3.3). Per step: `skip_if` path check (relative to workspace), `skip_if_env` check (parsed from `env_file`, default first env file), timeout (default 300s, hard cap 900s), stdout/stderr drained into the preview-context ring (reuse `PreviewContextService.handleServerLine` with synthetic serverId `setup`) so the agent can see setup logs via the host bridge too.
- **Phase 3 — env-generate (built-in, after setup steps)**: for every var with `generate` that is still missing/empty in its file, run the command and merge stdout. This ordering is the whole point: `php artisan key:generate --show` needs `vendor/`, which only exists after phase 2. Failure on a `required` var fails setup with a clear error; otherwise warn and continue. (This finally wires the orphaned `project-env.ts` helpers into runtime.)
- **Stamp file** `<workspace>/.herman/setup.json`:
  `{ version: 1, planHash, completed: { [stepId]: { at, durationMs } }, failed?: { stepId, error, at } }`.
  Built-in phases are recorded as `herman:env-base` / `herman:env-generate` steps.
  - `planHash` = hash of the serialized resolved plan (setup steps + env files + servers) → manifest changes invalidate completed steps (re-run).
  - On resume (restore/openSession with existing worktree): run only steps not in `completed` (or whose `skip_if` no longer holds). This makes setup **repair, not reinstall** (fixes D4).
  - `.herman/` must be ignored: append it to the main repo's `.git/info/exclude` once when the first worktree is created (per-repo, no project-file pollution).
- **Failure semantics**: non-optional step fails → setup state `error` with `step`, `retryable: true`, tail of output; optional step fails → warning logged, step marked completed-with-warning, setup continues. Retry = delete `failed` marker, re-run runner (RPC `retrySessionSetup(tabId)`).
- **Keep `runInstallCommand`** (move into the runner file) for step execution; delete `detectInstallCommand` / `ensureNodeModulesInstalled` / `ensureWorktreeDependencies` / `ensureGitAndDependencies` from `worktree.ts` and all call sites (D11).

### 3.5 Port registry (new) & preview ownership rework

`src/bun/preview/port-registry.ts`:

- Single allocator for the whole app: `reserve(preferredPort): Promise<number>` — bind a socket on 127.0.0.1, hold it, return `{ port, release() }`. `PreviewManager.spawnInstance` calls `release()` immediately before spawning the child (retry loop: if the child dies instantly with EADDRINUSE, allocate the next port and respawn once). Fixes the TOCTOU race (D2).
- Registry also tracks `port → tabId` so `getPortOwner(port)` can detect cross-session clashes in readiness (below) and GC can free orphaned reservations.

`PreviewManager` changes:

- **Pre-reserved ports**: the bootstrapper's plan phase reserves one port per manifest server (3.5 registry) *before* setup runs (env files need the values). It hands them to the manager via the existing `PreviewStartRequest.resolvedPort` — the manager must use it verbatim (`opts.resolvedPort ?? findFreePort(...)` already behaves this way) and release the reservation only when the instance stops.

- **Key instances by tab**: `previewKey(tabId, serverId)` instead of `folderPath::serverId` (D8). `PreviewStartRequest` gains required `tabId`. Folder-only callers (wizard QA, normal-mode publish flow?) pass a synthetic scope id (`wizard:<id>` / `folder:<path>`) — enumerate all `startPreview` call sites and update.
- **Env injection per server**: spawn env = `exportUrlAs` mappings (existing) + `portEnv` mappings (new: each listed var = resolved port) + `PORT` (kept for node ecosystems). `{port}` / `{url}` substitution in `command`. Laravel case: `SERVER_PORT=<port>` → `artisan serve` binds the right port (D2). Vite: templates that need it add `portEnv: [VITE_PORT]` on their vite server entry or rely on `{port}` in the command.
- **Install gate removal**: `shouldInstall`/`runInstall`/`installCommand` are deleted from the preview pipeline entirely (D: the setup runner owns installation). `startPreview` on a session that isn't `ready` is rejected by the bootstrapper-gated path (main-driven auto-start) or accepted as manual override (renderer restart button) — manual starts against an un-setup folder will simply fail and surface their stderr, which is fine and self-explanatory.
- **Readiness hardening**: probe only `127.0.0.1:<reservedPort>`; when the port registry says the responding port belongs to another tab, fail fast with "port clash" instead of adopting it. (Keep simple: the reservation model makes this nearly impossible; add the ownership check as a debug-level log + phase failed guard.)
- `stopDevServer(folderPath)` call sites migrate to `stopPreviewsForTab(tabId)`; the `closeTab` "stillUsed" folder-sharing logic disappears because keys are tab-scoped. Keep the deferred-stop (renderer unmount first) behavior.
- `PreviewContextService` keys server rings by tab as well (or dual-key tab+folder); update `host-bridge/routes/preview-context.ts` accordingly (small change: it already goes through `getTab(tabId)`).

**Auto-start becomes main-driven** (fixes D1): when the bootstrapper reaches phase `ready` and the tab has manifest servers, the main process starts the fleet for that tab (rookie policy; respect a per-session "user stopped preview manually" flag persisted on the session). The renderer **never** calls `startPreview` on activation; `preview-store.loadAndStart` becomes `loadManifest + subscribe` only. `startPreview`/`restartPreview` RPCs remain for explicit user actions (restart, server switch) and for the wizard.

### 3.6 Tab/session lifecycle unification (AgentProcessManager)

- `createTab`, `openSession`, `openPiSession`, `adoptWizardSession` all become thin wrappers: build the `Tab`, register it, then `bootstrapper.bootstrap(tabId, intent)`. Delete `finalizeTabWorktree` and the `needsWorktree` branching (D10). `ensureAgentForTab`'s `worktreeStatus === "pending"` guard becomes `setup.phase === "pending"`.
- `PersistedSession` gains: `isolation: "worktree" | "direct"`, `setupCompletedAt?: number`, `setupPlanHash?: string`. `window-state.ts` read-path migrates legacy sessions: `isolation = worktree ? "worktree" : "direct"` (legacy wizard-adopted sessions stay `direct` — correct, they were created that way; no silent migration).
- `restore()`: for each open tab with `isolation: "worktree"` → bootstrap in `repair` mode (ensure worktree exists via existing `ensureSessionWorktree`, run setup-runner resume, then agent, then preview). Missing folder handling (D12) folds into the same path. Concurrency: bootstrap queue with `MAX_CONCURRENT_SETUPS = 2` (setup is IO/CPU heavy; agents already have their own queue).
- `closeTab`: stop previews by tab id (deferred), remove worktree only when session deleted (existing rule), plus dispose setup stamp state. `discardSession` unchanged apart from tab-keyed preview stop.
- **pi session listing normalization** (D5): `pi-sessions.ts` — filter cwds containing `/.worktrees/` out of `getProjectFoldersFromPiSessions`, and in `listPiSessionsForProject`, additionally union sessions whose cwd is a worktree path belonging to that project (map via persisted sessions' `worktree.mainFolderPath`, or simpler: match cwd prefix `~/Herman/.worktrees/` and look up the owning project through `AgentProcessManager`'s session store; implement behind a small `WorktreeIndex` helper in `worktree.ts`).

### 3.7 Worktree & branch GC (D6)

`src/bun/session-bootstrap/worktree-gc.ts`, run once at startup (after restore, serialized):

1. List `~/Herman/.worktrees/*`. Any dir whose name is not a known `TabId` in the session store **and** whose mtime is older than 24h → `git worktree remove --force` against its recorded main repo (resolve via `git -C <dir> rev-parse --git-common-dir`), then delete the dir if removal fails.
2. For each known project root: `git worktree prune` and delete `herman/session/*` branches with no matching worktree and no matching persisted session (older than 24h, never the checked-out one).
3. Log a summary; never block startup (run in background, errors → warnings).

### 3.8 Renderer work

- **Types/store**: replace `Tab.worktreeStatus` with `Tab.setup: SessionSetupState`; `agent-store` applies `sessionStateChanged` wholesale. Remove the `app.tsx` `onTabFolderChanged` worktree-status special-casing; folder changes become part of `sessionStateChanged`.
- **The forwarding bug (Bug A) is fixed at the source**: in `src/bun/index.ts`, stop destructuring/re-sending partial payloads — pass `payload` straight through (`tabFolderChanged: (payload) => webviewRpc.send.tabFolderChanged(payload)` during migration; then rename to `sessionStateChanged`). Add a lint-level rule by construction: the `WebviewSender` type is derived from `OutgoingMessages` so dropped fields are a type error, not a silent runtime loss.
- **NewSessionView** (both modes use it): render real progress — step list with spinner/check/warning per step, from `tab.setup.label` + a step list snapshot (add `steps?: { id, label, status }[]` to the pending state). Error state shows the failed step, trimmed output, "Retry setup" button (→ `retrySessionSetup`) and "Ask Herman to fix" (prefills composer with setup logs — but only enabled once the agent is up; see Q2).
- **PreviewPane / preview-store**: `activate` no longer starts servers (3.5); add a `waiting_for_setup` stage when `tab.setup.phase === "pending"` (rookie: friendly "Setting up your workspace…" instead of starting anything against the main tree — kills D1 visibly). Store keys per tab already via activation identity (`tabId` is part of identity — verify all selectors use it; `isCurrent` already checks `tabId` when provided — make it required).
- **PreviewWebview guards** (D7): no-op all imperative calls when `webviewId === null` or after `disconnectedCallback` (the electrobun class already null-guards most; the warnings come from calls racing removal — add a renderer-side `disposed` flag checked in `loadURL/toggleHidden/syncDimensions`, and don't call `loadURL("about:blank")` after disconnect). Keep one mounted webview per tab and only swap `src` (already the case); confirm `PreviewStage` doesn't remount on stage transitions (it conditionally renders the webview only in `ready` stage — that's a remount per failure cycle; acceptable, but the guards must make it clean).
- **Rookie shell**: no structural change; `PreviewPane` now receives `setup={tab.setup}` and `isWorktree` from the (now correctly delivered) `tab.worktree`.

### 3.9 RPC surface changes (`src/shared/rpc.ts`)

- Outgoing: add `sessionStateChanged { tabId, setup: SessionSetupState, folderPath?, projectRoot?, worktree? }`; remove `tabFolderChanged` (migrate all three producer call sites + one renderer listener).
- Requests: add `retrySessionSetup { tabId } → { ok, error? }`; `startPreview`/`restartPreview`/`stopPreview`/`getPreviewStatus` payloads switch `folderPath → tabId` (update `preview-store` deps accordingly); keep `folderPath`-based variants only where the wizard needs them (wizard has no tab) — introduce explicit `scope: { tabId } | { folderPath }` union if simpler.
- `Tab`: `+ setup: SessionSetupState`, `- worktreeStatus`. `PersistedSession`: `+ isolation, setupCompletedAt?, setupPlanHash?`.

---

## Part 4 — Implementation milestones (ordered, each shippable)

### M0 — Stop the bleeding (tiny, do first, could land alone)
1. `index.ts`: forward full `tabFolderChanged` payloads (fixes Bug A).
2. `preview/index.ts`: delete the `shouldInstall` node_modules heuristic; when an `installCommand` is provided, always run it unless the preview-manager stamp says it ran for this folder+command hash (cheap interim stamp: `node_modules/.herman-install.json`). (Mitigates Bug B until M2 lands.)
3. `adoptWizardSession` RPC: stop wizard preview servers for `projectPath` at handoff (D9).
4. Tests: forwarding passes worktree fields through; install gate honors stamp.

### M1 — Manifest v2 + templates + compat shim
1. Schema v2 in `src/shared/herman-manifest.ts` (`EnvFileSchema`, `EnvVarValueSchema`, `SetupStepSchema`, top-level `servers`, `portEnv`, `version: 2`) + v1→v2 read shim; `serializeHermanYaml` emits v2; `mergeFrontmatter` array-replace semantics for `setup`/`env.files`/`servers`.
2. `src/bun/setup-plan.ts`: `resolveSetupPlan()` (env files + setup steps + servers), `planHash`, `buildSetupGoal(plan)` for the wizard.
3. Rewrite the five templates to v2 with real per-stack sequences (Laravel decomposed; static ones minimal, no seed); regenerate the JSON schema export (`herman-frontmatter.v2.json`).
4. Tests: schema round-trip, v1→v2 migration (incl. the real `mamine-cooking-v2` herman.yaml shape), plan resolution, merge semantics.

### M2 — Session Bootstrapper + SetupRunner + state machine
1. `session-bootstrap/` module (planner, runner, stamp, gc — gc can slip to M4 if needed).
2. `Tab.setup` state machine + `sessionStateChanged` event end-to-end (main → renderer), `WebviewSender` type derived from `OutgoingMessages`.
3. `AgentProcessManager` path unification for `createTab`/`openPiSession`; `openSession` respects persisted `isolation` (no silent migration).
4. NewSessionView progress UI + retry RPC.
5. Tests: runner idempotency/skip/stamp/resume/failure/optional steps; bootstrap ordering; event payloads.

### M3 — Preview ownership & ports
1. Port registry with hold-and-release; spawn retry on EADDRINUSE.
2. PreviewManager keyed by tab; env injection (`portEnv`, `{port}`/`{url}`); delete install path; readiness ownership guard.
3. Main-driven auto-start at `ready`; renderer auto-start removal; `waiting_for_setup` stage.
4. PreviewContextService re-keying + host-bridge route updates.
5. Tests: port allocation under concurrency, per-tab fleet isolation, env injection for the Laravel template case (`SERVER_PORT`).

### M4 — Wizard unification + restore/repair + GC + session listing
1. `adoptWizardSession` through the bootstrapper; delete special no-worktree path; fresh-pi-session semantics kept.
2. Restore in repair mode; legacy window-state migration; `WorktreeIndex`; pi session listing normalization (D5).
3. Startup worktree/branch GC (D6).
4. Tests: legacy migration, repair resume after simulated crash, GC safety (never touches known sessions, 24h guard).

### M5 — Webview lifecycle hardening + polish
1. Renderer disposed-guards (D7); verify zero `BrowserView not found` warnings across tab switch/close/failure loops.
2. Setup logs into preview-context ring + "Ask Herman to fix" wiring for setup errors.
3. Rookie-docs wording touch-ups if they mention workspaces (check `rookie-docs/`).

---

## Part 5 — Concrete file change map

**Main process — new files**
- `src/bun/session-bootstrap/bootstrapper.ts` — pipeline orchestration + policy.
- `src/bun/session-bootstrap/setup-runner.ts` — step execution, env provisioning, stamp (absorbs `runInstallCommand`, `copyEnvFiles` from `worktree.ts` and `resolveEnvValues`/`writeProjectEnv` usage from `project-env.ts`).
- `src/bun/session-bootstrap/worktree-gc.ts`.
- `src/bun/setup-plan.ts` — `resolveSetupPlan` (env files + steps + servers), plan hashing, `buildSetupGoal(plan)` for the wizard.
- `src/bun/preview/port-registry.ts`.

**Main process — modified**
- `src/bun/agent-process-manager.ts` — biggest diff: delete `finalizeTabWorktree`, `needsWorktree` branches, `detectInstallCommand` import; route through bootstrapper; tab-keyed preview stops; restore repair; `retrySessionSetup`.
- `src/bun/worktree.ts` — slim down to git primitives only (create/remove/ensure worktree, changes, sync prompt, resolveProjectRoot). Delete install/env-copy/detect helpers (moved).
- `src/bun/index.ts` — full-payload forwarding; `retrySessionSetup` RPC; `adoptWizardSession` stops wizard previews; preview RPCs tab-scoped.
- `src/bun/preview/preview-manager.ts`, `types.ts`, `index.ts`, `preview-process.ts`, `preview-ports.ts` — tab keys, port registry, env injection, install path removal.
- `src/bun/preview-context/service.ts` + `src/bun/host-bridge/routes/preview-context.ts` — tab keys.
- `src/bun/pi-sessions.ts` — worktree-aware filtering/mapping.
- `src/bun/window-state.ts` — legacy migration.
- `src/bun/wizard-session.ts` — setup goal generated from resolved plan (optional but strongly recommended).

**Shared**
- `src/shared/rpc.ts` — `SessionSetupState`, `Tab.setup`, `PersistedSession.isolation`, `sessionStateChanged`, preview request payload changes.
- `src/shared/herman-manifest.ts` — **v2 ground-up**: `EnvFileSchema`/`EnvVarValueSchema`/`SetupStepSchema`, top-level `servers`, `portEnv`, v1→v2 shim; delete `DevConfigSchema`/`EnvConfigSchema` v1 shapes.
- `src/bun/herman-md.ts` — v2 frontmatter parse/serialize; array-replace merge for `extends`.
- `src/bun/project-env.ts` — absorbed into the setup runner (phase 1/3 helpers: source resolution, merge, `rewrite_paths`, `generate`); delete the standalone wizard-only entry points once the wizard reads the resolved plan.

**Renderer**
- `src/views/main/app.tsx` — listener swap.
- `src/views/main/lib/agent-store/*` — `Tab.setup` plumbing.
- `src/views/main/components/new-session-view.tsx` — progress + error + retry.
- `src/views/main/lib/preview-store.ts`, `hooks/use-preview-controller.ts`, `components/preview-pane.tsx`, `components/preview/preview-stage.tsx` — no auto-start, `waiting_for_setup`, tab identity required.
- `src/views/main/components/preview-webview.tsx` — disposed guards.
- `src/views/main/components/composer.tsx`, `lib/agent-actions.ts` — `setup.phase` gates (replace `worktreeStatus`).

**Templates**: `apps/desktop/templates/*.HERMAN.md` (+ `schema/herman-frontmatter.v1.json`).

**Deletions**: `detectInstallCommand`, `ensureNodeModulesInstalled`, `ensureWorktreeDependencies`, `ensureGitAndDependencies`, `copyEnvFiles` (absorbed by the runner), `shouldInstall`, preview `installCommand` plumbing, `dev.install` (v1, shimmed), `DevConfigSchema`/`EnvConfigSchema` (v1), `tabFolderChanged` event, `Tab.worktreeStatus`.

---

## Part 6 — Test plan

- **Unit (bun)**: setup plan resolution (schema variants + legacy fallback); setup runner (temp dirs via `test/helpers/temp-dir.ts` — skip_if/skip_if_env/optional/timeout/stamp/resume/plan-hash invalidation/env rewrite of main-root paths); port registry (concurrent reserve 50 → all unique; release on spawn); manifest serialization round-trip; window-state legacy migration; GC selection logic (fake mtimes).
- **Integration**: bootstrap a real git fixture project (node-only and a fake-composer fixture with stubbed `composer`/`php` shims on PATH) end-to-end: tab created → setup steps observed in order with events → agent scheduled after ready → preview auto-started with `SERVER_PORT` env and reserved port; kill mid-setup → restore → resume only missing steps.
- **Renderer (existing store tests pattern)**: `sessionStateChanged` applied; NewSessionView stages; preview-store no longer calls `startPreview` on activate; waiting stage.
- **Regression for the reported bugs** (must be explicit tests):
  1. Forwarding: emitting `tabFolderChanged`/`sessionStateChanged` from the manager reaches the renderer listener with `worktree` + `setup` intact.
  2. Laravel fixture: fresh worktree → preview ready with `vendor/` present and sqlite migrated (using shims), port ≠ 8000 when 8000 is occupied by another tab, and no preview process ever spawned in the main project root during setup.
- **Manual acceptance**: create project from the Laravel template via wizard → first session opens in a worktree, steps visible, preview ready on its own port; open a second tab on the same project → second worktree, different port, both previews live simultaneously; close app mid-setup → reopen → setup resumes; Save button appears (worktree flag delivered).

---

## Part 7 — Risks & open questions

- **Resolved during design** (raised in review): how env var *generation* fits a per-project setup sequence — the three-phase model in 3.4. Phase 1 creates files and applies literals + session bindings (ports are pre-reserved in the bootstrap plan phase); phase 3 runs `generate:` commands **after** setup steps so toolchain-dependent generators (`php artisan key:generate --show` needs `vendor/`) work. Per-project differences (`.env` vs `.env.development.local`, composer vs bun vs prisma, seed vs no seed) are fully expressed by `env.files[]` + `setup[]` — see the three example manifests in 3.3.
- **Q1 (product)**: Should a new worktree copy the main project's sqlite database so rookie users "keep their content" per session? Copying gives continuity but diverges content per session and Save only merges code. Proposal: v1 = fresh DB + migrate (+ optional seed); revisit with a manifest `copy_from_main` step type later. **Decide before M2.**
- **Q2**: Setup failure UX wants "Ask Herman to fix", but the agent starts only after setup succeeds. Options: (a) start the agent even on setup error with a note in context, (b) retry-only. Proposal: (a) for `retryable` errors — the agent is the best fixer and runs in the same workspace. **Decide before M2.**
- **Q3**: Non-git rookie folders currently can't get worktrees. Setup steps are designed for fresh copies; running them in-place is a no-op via skip rules, which is safe. Keep policy `direct` + no setup for those. Confirm.
- **Risk — setup runtime**: `composer install` + `bun run build` can take minutes on first tab of a project. Mitigations: per-step progress UI (M2), setup runs concurrently with the agent start? No — agent must wait (it needs vendor for tools like boost). Accept the wait; make it observable. Optional future optimization: cache a "golden" provisioned copy per project+planHash and `cp -c` (APFS clone) instead of reinstalling.
- **Risk — `.env` rewrite correctness**: prefix-replacing main-root paths is heuristic (could rewrite a value that coincidentally contains the path). Keep the rule narrow: only values that *start with* the main root path or equal it after `database_path()`-style expansion; log every rewrite at info level.
- **Risk — port hold/release window**: tiny race remains between release and child bind; the respawn-on-EADDRINUSE retry covers it.
- **Risk — wizard `setup_goal` drift**: if templates get `setup:` steps but the wizard prompt keeps its own prose, wizard-time and session-time setup diverge again. M4 includes generating the wizard goal from the resolved plan (or at least referencing it).
- **Out of scope (note, don't build)**: Normal-mode preview pane (normal mode has no preview split today); multi-window; remote/devcontainer workspaces; per-step parallel execution.

---

## Appendix — Evidence log

- Stuck-spinner forwarding bug: `apps/desktop/src/bun/index.ts:1032-1036` drops `worktree|worktreeStatus|error`; renderer needs them (`app.tsx:186-198`, `new-session-view.tsx:24-39`).
- Hardcoded worktree setup: `worktree.ts:165-181` (`createSessionWorktree`), `:66-70` (`detectInstallCommand`), `:133-138` (`copyEnvFiles`).
- Preview install heuristic: `preview/index.ts:69-71` (`shouldInstall` = `!existsSync(node_modules)`).
- Wizard no-worktree path: `agent-process-manager.ts:308-324`; stale rationale vs `project-manifest.ts:162-188` (`setupProjectRepo` commits everything).
- Silent direct→worktree migration on reopen: `agent-process-manager.ts:354-365`.
- Laravel port env: `vendor/laravel/framework/src/Illuminate/Foundation/Console/ServeCommand.php:449` (`SERVER_PORT`), `DevCommands.php:58` (`serve --host=localhost`).
- On-disk verification (2026-07-19): worktree `~/Herman/.worktrees/b7d96a5d-…` contains `node_modules/` + `.env`, lacks `vendor/` and `database/database.sqlite`; main `.env` `APP_URL=http://localhost`; `database/database.sqlite` is gitignored (present only in main).
- `~/Herman/mamine-cooking-v2/herman.yaml`: `dev.install: composer run setup`, server `composer run dev` port 8000, env vars `APP_KEY` (generate), `DB_CONNECTION`, `DB_DATABASE` — none of which were applied to the worktree.
