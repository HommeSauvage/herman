---
version: 1
name: Herman Starter
description: Shared Bun + TanStack + Drizzle with Bun SQLite foundation. 
category: base
source:
  repo: https://github.com/HommeSauvage/herman-starter
  ref: master
requirements:
  - id: bun
    label: Bun
    check: bun --version
    install: https://bun.sh
  - id: docker
    label: Docker
    check: docker --version
    optional: true
env:
  file: apps/web/.env.development.local
  vars:
    - key: BETTER_AUTH_SECRET
      required: true
      notes: Signs login sessions. We can generate this for you.
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
Initial setup:
- Install with `bun install`
- Search for the env variables in the project (they are defined in `env.ts` files)
- Create the `.env.development.local` file and add any required missing variables
- Generate the migrations: `bun auth:generate` then `bun db generate`
- Run the migration `bun db migrate`
- Seed initial users: `bun cli seed` and share the seeded users with the user and share them with the user
