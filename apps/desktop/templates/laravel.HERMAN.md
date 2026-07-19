---
version: 2
name: Laravel Starter
description: A full-stack Laravel application with Inertia.js, React, and Tailwind CSS. Ships with authentication, team management, and shadcn/ui components.
suitable_for: Web applications that need a robust backend, authentication, database, and a modern React frontend. Good for SaaS products, admin panels, content platforms, and any project requiring server-side logic.
category: base
source:
  repo: https://github.com/HommeSauvage/herman-starter-laravel
  ref: master
requirements:
  - id: php
    label: PHP 8.3+
    check: php --version
    install: https://php.net
    why: Runs your website's backend — the part that thinks and remembers.
  - id: composer
    label: Composer
    check: composer --version
    install: https://getcomposer.org
    why: Installs the PHP building blocks your project is made of.
  - id: bun
    label: Bun
    check: bun --version
    install: https://bun.sh
    why: Runs your website on your computer and builds its pages.
  - id: node
    label: Node
    check: node --version
    install: https://nodejs.org
    why: Runs your website on your computer and builds its pages.
env:
  files:
    - path: .env
      from_example: .env.example
      vars:
        APP_KEY:
          required: true
          notes: Application encryption key. We can generate this for you.
          generate: php artisan key:generate --show
        DB_CONNECTION:
          required: true
          notes: Database driver. Defaults to sqlite for zero-config local dev. Change to mysql or pgsql for production.
          value: sqlite
        DB_DATABASE:
          required: true
          notes: Database path for sqlite, or database name for mysql/pgsql.
          value: database/database.sqlite
        SERVER_PORT:
          session: primary_port
        APP_URL:
          session: primary_url
setup:
  - id: php-deps
    label: Installing PHP dependencies
    run: composer install
    skip_if: vendor/autoload.php
  - id: database
    label: Preparing the database
    run: touch database/database.sqlite && php artisan migrate --force
    skip_if: database/database.sqlite
  - id: seed
    label: Seeding the database
    run: php artisan db:seed
    optional: true
  - id: js-deps
    label: Installing frontend dependencies
    run: bun install
    skip_if: node_modules
servers:
  - id: web
    label: Website
    command: composer run dev
    port: 8000
    portEnv: SERVER_PORT
    primary: true
checks:
  - id: pint
    label: PHP formatting & static checks
    run: vendor/bin/pint --test
  - id: types
    label: Frontend type check
    run: bunx tsc --noEmit
  - id: tests
    label: Test suite
    run: php artisan test --compact
    timeout: 600
---

## Stack

This is a Laravel application with:
- **Backend**: Laravel 13, PHP 8.3+, SQLite (default) or MySQL/Postgres
- **Frontend**: Inertia.js v3, React 19, Tailwind CSS v4, shadcn/ui
- **Auth**: Laravel Fortify with passkeys, two-factor authentication, and team management
- **Testing**: Pest PHP
- **Tooling**: Wayfinder (typed route generation), Laravel Boost (MCP server), Pint (code formatting)

## Setup

Initial setup:
- Run `composer run setup` to install PHP dependencies, set up the `.env` file, generate the app key, run migrations, and install frontend dependencies
- If setup fails on individual steps, run them manually: `composer install`, then copy `.env.example` to `.env`, then `php artisan key:generate`, then `php artisan migrate`, then `bun install`
- Seed the database if seeders exist: `php artisan db:seed`
- Start the dev server: `composer run dev` (runs both Vite and the PHP development server on port 8000)

## Frontend

- Pages live in `resources/js/pages/` and are Inertia page components
- Shared UI components are in `resources/js/components/` (shadcn/ui based)
- Layouts are in `resources/js/layouts/` — the default app layout wraps authenticated pages with sidebar navigation
- Use Wayfinder-generated route helpers from `@/routes/` and controller actions from `@/actions/` for typed, safe URL generation
- Run `bun run dev` to start only the Vite dev server, or `composer run dev` for both Vite and PHP

## Backend

- **Creating new models**: use `php artisan make:model ModelName -a --no-interaction` to generate model, migration, factory, seeder, controller, form request, and policy
- **Creating controllers**: use `php artisan make:controller ControllerName --no-interaction`
- **Routes**: defined in `routes/web.php` (web routes) and `routes/settings.php` (settings/team routes). Use `Route::inertia()` for pages without a dedicated controller, and named routes with the `route()` helper
- **Migrations**: run `php artisan migrate` to apply, `php artisan migrate:rollback` to undo
- **Testing**: run `php artisan test --compact` for the full suite, or filter with `--filter=TestName`. Create tests with `php artisan make:test --pest TestName`
- **Code formatting**: run `vendor/bin/pint --format agent` before finalizing PHP changes

## Auth & Teams

- Authentication is handled by Laravel Fortify with Inertia views
- Auth pages are in `resources/js/pages/auth/` (login, register, forgot password, etc.)
- The app uses team-based scoping: every authenticated user belongs to a team. URLs are prefixed with `/{current_team}`
- Team management is under Settings → Teams
- Passkey (WebAuthn) support is built in for passwordless authentication

## Guidance

- Do things the Laravel way: use Artisan commands, Eloquent, named routes, and Laravel conventions
- Before writing code, use `search-docs` (via Laravel Boost MCP) to check version-specific documentation
- Reuse existing shadcn/ui components in `resources/js/components/ui/` before creating new ones
- When creating models, always create factories and seeders alongside them
- Run `vendor/bin/pint --format agent` after modifying PHP files
- Do not create documentation files unless explicitly asked

### Quality bar (non-negotiable for rookie projects)

- Every list/table view links to a **detail view**. Never truncate content without a way to see all of it (e.g. a comments admin column must open a full comment page with approve/reject actions — not just a truncated cell).
- Content editing uses a proper editor component (rich text or markdown with preview) — **never** a bare textarea expecting raw HTML.
- Every screen handles **empty**, **loading**, and **error** states. Seed data must make every page look real on first boot (no "lorem ipsum" placeholders left for the user).
- Destructive actions confirm; forms validate with human-readable messages.
- Admin pages get the same design care as public pages — polish, spacing, and clarity matter everywhere.
- The starter ships a **Notes** reference module as a concrete quality-bar example (list → detail → markdown editor → delete confirm). If the product does not need Notes, delete the whole module early (see starter `AGENTS.md`); do not leave orphan routes or half-removed UI.
