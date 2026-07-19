---
version: 2
name: Herman Starter
description: A starter code that is versatil and can work for most of the web apps
suitable_for: If there are no predefined templates for your project, this is probably a good place to start. It might require a bit more work after the project is implemented, but this is a solid start.
category: base
source:
  repo: https://github.com/HommeSauvage/herman-starter
  ref: master
requirements:
  - id: bun
    label: Bun
    check: bun --version
    install: https://bun.sh
    why: Runs your website on your computer and installs its building blocks.
  - id: docker
    label: Docker
    check: docker --version
    optional: true
    why: Runs apps in self-contained containers. Only needed for advanced setups.
env:
  files:
    - path: apps/web/.env.development.local
      vars:
        BETTER_AUTH_SECRET:
          required: true
          notes: Signs login sessions. We can generate this for you.
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
Initial setup:
- Install with `bun install`
- Search for the env variables in the project (they are defined in `env.ts` files)
- Create the `.env.development.local` file and add any required missing variables
- Generate the migrations: `bun auth:generate` then `bun db generate`
- Run the migration `bun db migrate`
- Seed initial users: `bun cli seed` and share the seeded users with the user and share them with the user
