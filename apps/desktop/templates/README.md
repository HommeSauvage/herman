# Authoring HERMAN.md templates

Templates are curated Markdown files in `apps/desktop/templates/*.HERMAN.md`.
Each file can point at **any** git repo via `source.repo` — that repo does not
need its own `HERMAN.md`.

## Structure

```markdown
---
version: 1
name: Blog
description: A fast blog you can write posts in.
icon: "📝"
extends: base          # optional — inherit another curated manifest
source:
  repo: https://github.com/HommeSauvage/herman-starter
  ref: master
requirements:
  - id: bun
    label: Bun
    check: bun --version
    install: https://bun.sh
env:
  file: apps/web/.env.development.local
  vars:
    - key: BETTER_AUTH_SECRET
      required: true
      generate: openssl rand -base64 32
dev:
  install: bun install
  servers:
    - id: web
      label: Website
      command: bun run dev:web
      port: 3000
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
  (extends flattened) into the project root. Preview, env, and guidance read that
  file at runtime. `HERMAN.md` is only a fallback for older projects / optional
  upstream clones.
- Machine-critical fields (`dev`, `env`, `requirements`, `source`) stay in
  frontmatter. Agent-interpreted intent stays in Markdown sections.

See `apps/desktop/schema/herman-frontmatter.v1.json` for the frontmatter schema.

## `exportUrlAs` (multi-server URL contract)

When a project has more than one `dev.servers` entry, siblings need each other's
URL. Preferred `port` values can shift when multiple Herman tabs/worktrees run
the same template, so apps must not hardcode `localhost:3010`.

Declare `exportUrlAs` on the server that others call. Herman pre-allocates free
ports at preview start and injects those env keys (with
`http://localhost:{resolvedPort}`) into **every** Herman-spawned process for
that project. It does **not** rewrite `.env` files for ports.

String or list (aliases for repos that use several names):

```yaml
dev:
  servers:
    - id: api
      label: API
      command: bun run dev:api
      port: 3010
      exportUrlAs: API_SERVER
      # or:
      # exportUrlAs:
      #   - API_SERVER
      #   - API_URL
    - id: web
      label: Website
      command: bun run dev:web
      port: 3000
      primary: true
```

After the wizard, this lives in **`herman.yaml`**. Coding/QA prompts tell the
agent to align app code so consumers read the declared keys.
