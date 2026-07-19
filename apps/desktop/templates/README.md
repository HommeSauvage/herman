# Authoring HERMAN.md templates

Templates are curated Markdown files in `apps/desktop/templates/*.HERMAN.md`.
Each file can point at **any** git repo via `source.repo` — that repo does not
need its own `HERMAN.md`.

## Structure

```markdown
---
version: 2
name: Blog
description: A fast blog you can write posts in.
icon: "📝"
extends: base          # optional — inherit another curated manifest
source:
  repo: https://github.com/HommeSauvage/herman-starter
  ref: master
requirements:
  - id: bun                # registry id when possible (git, brew, bun, php, composer, node, python, docker)
    label: Bun
    check: bun --version
    install: https://bun.sh # manual-install fallback link
    why: Runs your website on your computer.   # plain-language, shown to rookies
    # install_cmd: …       # optional — override install command for tools outside Herman's registry
env:
  files:
    - path: apps/web/.env.development.local
      vars:
        BETTER_AUTH_SECRET:
          required: true
          generate: openssl rand -base64 32
setup:
  - id: deps
    label: Installing dependencies
    run: bun install
    skip_if: node_modules
servers:
  - id: web
    label: Website
    command: bun run dev:web
    port: 3000
    portEnv: PORT
    primary: true
---

## Setup
Instructions the agent runs as the first turn after cloning.

## Questions
Prose describing what to ask the user (template-specific intent only). Herman auto-injects
`projectName` on the first wizard ask and appends `visualTone` last once template questions
are in the batch. `projectName` doubles as the display name (blog title, store name, site
title, etc.) — do not ask for a separate name here. Herman also skips anything already
answered by the user's project description. Do not include "describe what you're building";
Herman asks that before the wizard starts.

## Guidance
Ongoing instructions injected into the agent system prompt for this project.
```

## Rules

- Frontmatter is **block-style YAML** (no JSON braces).
- After wizard project creation, Herman writes the fully-resolved **`herman.yaml`**
  (extends flattened, always v2) into the project root. Preview, env, and guidance
  read that file at runtime. `HERMAN.md` is only a fallback for older projects /
  optional upstream clones. v1 manifests are migrated on read (`dev.install` →
  one `setup` step, `dev.servers` → `servers`, `env.vars` → `env.files`).
- Machine-critical fields (`env`, `setup`, `servers`, `checks`, `requirements`, `source`)
  stay in frontmatter. Agent-interpreted intent stays in Markdown sections.
- **`extends` and arrays**: `setup`, `env.files`, `servers`, and `checks` are replaced
  wholesale by the child when re-declared (concat would be an ordering trap).
  `requirements` merge by `id`.
- **`checks`**: host-enforced commands the wizard coding/QA gates run before a
  phase advances (e.g. `vendor/bin/pint --test`, `bunx tsc --noEmit`).

See `apps/desktop/schema/herman-frontmatter.v2.json` for the frontmatter schema.

## The workspace recipe (`env` + `setup`)

Every new session workspace (git worktree) is prepared by the manifest recipe:

1. **Env files** are provisioned first, in declared order. Source strategy per
   file: copy from the main project (`from_main`, default true — wizard-collected
   secrets ride along) → copy `from_example` → create empty. Values that start
   with the main project's absolute path are rewritten to the workspace
   (`rewrite_paths`, default true). Vars are applied per `merge`
   (`missing_only` default, `force` to overwrite):
   - `value`: literal, `${HERMAN_*}` interpolated.
   - `session`: built-in per-session binding — `primary_port`, `primary_url`,
     `workspace`, `main`, `branch`, `tab_id`. Ports are **reserved before
     setup runs**, so these values are stable. Session bindings always win
     over copied values (they are Herman-owned per-session data).
   - `generate`: shell command → stdout; runs in **phase 3, AFTER setup
     steps** (e.g. `php artisan key:generate --show` needs `vendor/`).
   - `required` / `notes`: wizard ask-the-user meaning (written to the MAIN
     project by the wizard; `from_main` carries them into worktrees).
2. **`setup` steps** run in order via `sh -c`. Each is idempotent:
   `skip_if` (path exists → skip), `skip_if_env` (env var non-empty → skip),
   `optional` (failure = warning), `timeout` (seconds, default 300, cap 900).
   Progress is stamped in `<workspace>/.herman/setup.json` — interrupted
   setups resume as repair, and manifest changes (plan hash) invalidate
   completed steps.
3. Steps get the session values as real env: `HERMAN_WORKSPACE`,
   `HERMAN_MAIN`, `HERMAN_BRANCH`, `HERMAN_TAB_ID`, `HERMAN_PRIMARY_PORT`,
   `HERMAN_PRIMARY_URL`, `HERMAN_PORT_<SERVERID>`, `HERMAN_URL_<SERVERID>`,
   `HERMAN_PROJECT_NAME`.

## `checks` (wizard gates)

```yaml
checks:
  - id: types
    label: Frontend type check
    run: bunx tsc --noEmit
  - id: tests
    label: Test suite
    run: php artisan test --compact
    timeout: 600   # seconds; default 300, cap 900
```

Herman runs these during the coding and QA completion gates. A non-zero exit
rejects `herman_complete_wizard` and feeds the failure report back to the agent.

## `servers`, `portEnv` and `exportUrlAs`

`servers` drive the preview pane. The **primary** server powers the preview.
`port` is the *preferred* port; Herman reserves the actual free port per
session (two tabs of the same project never clash).

- `portEnv`: env var name(s) set on this server's spawn environment to the
  resolved port (e.g. `SERVER_PORT` for `php artisan serve`). `PORT` is
  always set. `{port}` / `{url}` in `command` are substituted at spawn.
- `exportUrlAs`: env var name(s) set on **every** Herman-spawned server in
  the fleet to this server's resolved `http://localhost:{port}` URL — for
  inter-service calls (never hardcode `localhost:<preferredPort>`).

```yaml
servers:
  - id: api
    label: API
    command: bun run dev:api
    port: 3010
    exportUrlAs: API_SERVER      # or a list: [API_SERVER, API_URL]
  - id: web
    label: Website
    command: composer run dev    # {port}/{url} available for custom commands
    port: 8000
    portEnv: [SERVER_PORT]
    primary: true
```

After the wizard, this lives in **`herman.yaml`**. Coding/QA prompts tell the
agent to align app code so consumers read the declared keys.
