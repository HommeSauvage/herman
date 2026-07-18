# Better Wizard Handoff — Docs & Tutorials Phase + Docs Browser (Rookie Mode)

## Goal

Help non-technical (Rookie Mode) users after the wizard finishes building their project:

1. **Feature 1 — Generating docs.** After the QA phase succeeds, a new agentic wizard phase called **Docs & Tutorials** runs: the agent explores the finished codebase and writes beginner-friendly docs into `<project>/herman-docs/`. Some docs are static (copied verbatim from bundled seeds), some are fully generated, and one (`database.md`) is a static seed the agent appends project specifics to. The docs end up committed so future tabs/worktrees include them.
2. **Feature 2 — Presenting the docs.** The wizard's final screen gets a new primary CTA **"Let's get familiar with your project first"** that opens an in-app docs browser (titled *"[Project Name] Documentation"*, styled like the Rookie Home page with a back button, a docs sidebar, and a reading pane). A secondary CTA **"I know how to use Herman, open the project"** performs the existing handoff.

**Mode scope (MODES.md):** Both features are **Rookie Mode only**. Do not touch the Normal shell (`shell.tsx`, `home-view.tsx`, `project-sidebar.tsx`).

---

## Current architecture (what exists today)

Wizard flow lives in the desktop app (`apps/desktop/`):

- `src/bun/wizard-session.ts` — `WizardSession` orchestrates three sequential pi agent sessions as **phases**: `planning → coding → qa`. `WizardPhase = "planning" | "coding" | "qa"` (line ~41). Phase transitions:
  - `herman_complete_planning` tool (planning) → `advanceToPhase("coding")`.
  - `herman_complete_wizard` tool (coding) → `advanceToPhase("qa")`.
  - `herman_complete_wizard` tool (qa) → emits `wizard_complete` → renderer shows the **done** screen.
  - Each non-planning phase starts a fresh `AgentBridge` with `cwd = projectPath` and sends `/goal --tokens <budget> <goalBody>` (pi-goal). Budgets: `CODING_TOKEN_BUDGET = '300k'`, `QA_TOKEN_BUDGET = '200k'`.
  - Retry/resume machinery (`scheduleRetry`, `/goal resume`, checkpointing) is phase-generic.
- `src/bun/wizard-checkpoint.ts` — crash/cold-start recovery. `WizardCheckpointPhase = "planning" | "coding" | "qa"`. `evaluateWizardCheckpoint` requires `projectPath` (existing on disk) for coding/qa.
- `src/bun/wizard-extension/index.ts` — pi extension loaded in the wizard agent subprocess. Registers `herman_wizard_ask` (auto-rejected outside planning), `herman_complete_planning`, `herman_complete_wizard`.
- `src/shared/agent-protocol.ts` — `WizardSessionEvent` union (`wizard_request | wizard_progress | wizard_models | wizard_complete | wizard_end | wizard_retrying`).
- `src/shared/rpc.ts` — Electrobun RPC contract. Wizard methods around lines 668–703 (`startWizardSession`, …, `adoptWizardSession`). `WizardRecoveryPayload.phase?: "planning" | "coding" | "qa"` (line ~43). `openExternal: { params: { url: string } }` (line ~448).
- `src/bun/index.ts` — RPC handlers (lines ~650–710). `adoptWizardSession` handler calls `setupProjectRepo(projectPath, manifest)`, then opens the project as a fresh tab.
- `src/bun/project-manifest.ts` — `setupProjectRepo()` writes `herman.yaml`, deletes the template's `.git`, and calls `initProjectRepo()` (`src/bun/worktree.ts` line ~47) which runs `git init`, `git add -A`, `git commit -m "Initial project"`. **This means every file present at handoff — including `herman-docs/` — is committed automatically. No extra commit logic is needed at handoff.**
- `src/views/main/components/onboarding-wizard.tsx` — the wizard UI. Steps (`WizardStep` in `src/views/main/lib/agent-store/types.ts`): `templates | describe | working | questions | done | error | retrying | recovery`. The **done** screen (search for `step === "done"`) has one CTA: `Open Project` → `handleDone()` → `desktopRpc.request.adoptWizardSession({ projectPath, wizardSessionId })` → `onComplete()` (hides wizard, tab opens via `tabCreated`/`tabActivated` notifications).
- `src/views/main/components/rookie-shell.tsx` — renders `<OnboardingWizard>` full-screen while `onboardingVisible`.
- `src/views/main/components/rookie-home-view.tsx` — Rookie Home. Its inner `SessionList` is the pattern to mimic for the docs browser: full-bleed `border-b border-mist` header with `ArrowLeft` back button + title + right-side action, content inside `ContentWidth size="page"`.
- `src/views/main/lib/markdown-parser.ts` — `parseMarkdown(content): Promise<string>` (marked + Shiki + DOMPurify). `src/views/main/components/message-item.tsx` line ~146 holds `proseClasses` (Tailwind arbitrary-variant typography string) used with `dangerouslySetInnerHTML`.
- `apps/desktop/electrobun.config.ts` — build `copy` map: `"templates": "templates"`, `"src/bun/wizard-extension": "wizard-extension"`, etc. `src/bun/template-registry.ts` `getTemplatesDir()` shows the prod/dev path resolution pattern: prod `resolve(import.meta.dir, "..", "templates")`, dev `resolve(import.meta.dir, "..", "..", "templates")`.
- Tests: `apps/desktop/test/bun/wizard-prompts.test.ts`, `wizard-checkpoint.test.ts`, `wizard-resume.test.ts`, `wizard-protocol.test.ts`. Run with `bun test test` (in `apps/desktop`); typecheck with `bun run typecheck`.

---

## Locked design decisions (do not re-decide)

1. New phase id: **`"docs"`** appended to the phase unions (`WizardPhase`, `WizardCheckpointPhase`, `WizardRecoveryPayload.phase`).
2. Docs folder: **`<projectPath>/herman-docs/`**.
3. Static seeds live in the repo at **`apps/desktop/rookie-docs/`** (3 files) and are bundled via a new `electrobun.config.ts` copy entry. They are copied into the project by the **host** (deterministic), never generated by the agent.
4. Sidebar ordering: doc file names carry a **2-digit numeric prefix** (`01-start-here.md`). The docs prompt instructs the agent to follow this; the reader sorts prefixed files numerically, then unprefixed alphabetically.
5. Sidebar label = the doc's **first `# ` H1 heading** (fallback: humanized file name).
6. Docs browser is an **in-wizard view** (local React state in `OnboardingWizard`, not a new `WizardStep`, not a new app view). HMR during it just returns to the done screen — acceptable.
7. The docs phase uses the same completion tool (`herman_complete_wizard`) and the same `/goal` + retry machinery as coding/QA. Token budget **`DOCS_TOKEN_BUDGET = '200k'`**.
8. Handoff commits: **no changes needed** — `setupProjectRepo` at handoff already commits everything (`git add -A`). The docs goal still tells the agent to commit best-effort (harmless; the user asked for it), but correctness does not depend on it.
9. A new `wizard_phase` event keeps the renderer's working-step header honest ("Writing your docs & tutorials").

---

## Milestone A — Static rookie-docs seeds + bundling

Create three markdown files. **These are drafts the product owner will review later — write them exactly as below, do not improvise extra content.**

### A1. `apps/desktop/rookie-docs/notions-and-terminology.md`

- [ ] Create the file with this content (note the two H2 headings whose slugs — `#static-vs-dynamic-pages`, `#seed-data` — are linked from other docs; do not rename those headings):

````md
# Notions & Terminology

Short, friendly explanations of the words you will see around Herman and your project. Come back here whenever a word feels unfamiliar.

## Project

Your project is your whole website: its pages, its design, its content, and everything Herman set up for you. It lives in a folder on your computer, and Herman takes care of everything technical inside it.

## Tabs and workspaces

When you open your project, Herman gives each tab its own private workspace — a safe copy of your project where the agent can make changes without touching what is already working. Each tab gets its own preview address, so you can work on several ideas at once without them clashing. When you are happy with a tab's changes, you apply them to your project; when you are not, you can simply discard them.

## Preview

The preview is your website running live inside Herman, next to the chat. It updates as the agent works. Only you can see it, and only on this computer.

## Development mode

While you work in Herman, your website is in *development mode*: it runs on your computer, for your eyes only. Nothing is on the internet yet.

## Publishing (production)

Publishing means putting your website on the internet so anyone can visit it, usually with its own address (a *domain name* like `my-shop.com`). The published version is called the *production* version. See the publishing guide when you are ready.

## Admin panel

Many projects include an admin panel: a private area of your website (usually at the `/admin` address) where you manage content yourself — products, posts, users — without asking Herman. Changing *how things look or work* is Herman's job; changing *content* is your job in the admin panel.

## Static vs dynamic pages

- A **static page** always shows the same content to everyone — like an "About" or "Contact" page. To change it, ask Herman.
- A **dynamic page** shows content that comes from the database — like a list of products or blog posts. Its content changes when *you* change things in the admin panel, without Herman's help.

## Seed data

Seed data is starter content Herman created so your project is not empty on day one: an example product or two, a first blog post, and — when your project has an admin panel — your first admin user with its login credentials. You can edit or delete all of it. If you do not know your admin credentials, just ask the Herman agent to share them with you.

## Database

The database is where your project's content lives (products, posts, users…). You never touch it directly — the admin panel and Herman do that for you. There is a whole doc about it: [What is the database?](./database.md)

## Template

Your project started from a template: a ready-made starting point Herman customized based on your answers during setup.
````

### A2. `apps/desktop/rookie-docs/herman-agent-quickstart.md`

- [ ] Create the file with this content (static, copied verbatim into every project — keep it project-agnostic):

````md
# Herman Agent Quickstart & Prompting

The Herman agent is your builder. You describe what you want in plain words; it reads your project, makes the changes, and shows you the result in the preview. You never need to write or understand code.

## How to ask for changes

- **Describe the outcome, not the technique.** Say "make the header sticky and add a shadow when scrolling" rather than naming tools or frameworks.
- **One change at a time.** Small requests succeed far more often than "redesign everything". You can always send the next request right after.
- **Point at what you see.** "On the product page, the price is too small" is better than "fix the typography".
- **Give examples.** "Something like the hero on apple.com — big photo, one sentence, one button" works great.
- **Say what to keep.** If part of the page should stay untouched, mention it.

## What happens after you send a message

1. The agent thinks, reads the relevant files, and edits your project inside the current tab's private workspace.
2. The preview refreshes so you can see the result.
3. If you like it, keep going (or apply the changes). If you don't, just say what is off — or discard the tab's changes and try again.

## Example prompts to steal

- "Make the homepage feel more premium: more spacing, bigger product photos, calmer colors."
- "Add an FAQ section to the bottom of the landing page with 5 questions I'll paste below."
- "The contact form should also ask for a phone number, and it should be optional."
- "This button does nothing when I click it — can you check why?"

## If something looks wrong

- Tell the agent what you see, in your own words: "the page went blank after the last change" is enough. Paste any error text you notice.
- You can always ask it to undo its last change.
- Nothing is ever lost: your project keeps a safety copy of changes, and Herman can restore earlier versions.

## Golden rules

1. **You manage content; Herman changes the product.** New blog post? Admin panel. New look, new page, new feature? Ask Herman.
2. **There are no stupid questions.** "What does this button do?", "where did my photo go?", "how do I publish?" — the agent answers all of it, step by step.
3. **Small steps, checked often** beat big leaps. Look at the preview after each change.
````

### A3. `apps/desktop/rookie-docs/database.md`

- [ ] Create the file with this content (the docs agent appends/replaces the last section per project — keep the HTML comment, the agent is instructed to act on it):

````md
# What is the database?

Think of the database as your project's **filing cabinet**. Every product, blog post, user account, or order is a sheet of paper neatly filed away. When a visitor opens a page, your website pulls the right sheets out and shows them. When you save something in the admin panel, a new sheet gets filed.

## Do I ever touch it directly?

No — and you never need to. You work with your content through the **admin panel** (adding a product feels like filling in a form, not like "using a database"), and Herman handles everything technical: creating the database, keeping it organized, and changing its structure when you ask for new features.

## Where does it live?

While you are in development mode, the database lives on your computer, next to your project — that is why only you can see your website's content for now. When you publish your project, the database moves with it to your server on the internet, and your real content starts living there.

## What happens to my content when Herman changes things?

Each Herman tab gets its own playground, so experiments never destroy your content. When you apply a tab's changes, your project keeps the content you created in the admin panel.

<!-- HERMAN DOCS AGENT: Replace the section below with project-specific details (database engine, where it lives in this project, what it stores, and how the rookie changes data day-to-day). If this project has NO database, replace the section below with a short note saying so and explaining where the site's content comes from instead. Keep the rest of this file unchanged. -->

## This project's database

_(To be filled in with the details of this specific project.)_
````

### A4. Bundle the seeds

- [ ] In `apps/desktop/electrobun.config.ts`, add to the `copy` record (next to `"templates": "templates"`):
  ```ts
  "rookie-docs": "rookie-docs",
  ```

### A5. New Bun module `apps/desktop/src/bun/rookie-docs.ts`

- [ ] Create the file. It owns: seed-dir resolution, seeding a project, listing/reading docs for the renderer, and completion validation. Full content:

```ts
import { existsSync, readdirSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { getLogger } from "@logtape/logtape";

import type { ProjectDoc } from "../shared/rpc.js";

const logger = getLogger(["herman-desktop", "rookie-docs"]);

/** Docs folder name inside every wizard-created project. */
export const HERMAN_DOCS_DIR = "herman-docs";

/** Static docs seeded verbatim into every project (order matches the docs-goal prompt). */
export const STATIC_ROOKIE_DOCS = [
  "notions-and-terminology.md",
  "herman-agent-quickstart.md",
  "database.md",
] as const;

const MAX_DOCS = 40;
const MAX_DOC_CHARS = 100_000;

/**
 * Resolves the bundled rookie-docs seed directory.
 * Production: app/bun/index.js → ../rookie-docs
 * Local dev: apps/desktop/src/bun → ../../rookie-docs
 */
export function getRookieDocsDir(): string {
  const bundledPath = resolve(import.meta.dir, "..", "rookie-docs");
  if (existsSync(bundledPath)) return bundledPath;
  return resolve(import.meta.dir, "..", "..", "rookie-docs");
}

/**
 * Copy the static seed docs into <projectPath>/herman-docs/. Idempotent:
 * existing files are never overwritten (a retried docs phase may have
 * already renamed/extended them).
 */
export async function seedStaticRookieDocs(projectPath: string): Promise<void> {
  const source = getRookieDocsDir();
  const target = join(projectPath, HERMAN_DOCS_DIR);
  await mkdir(target, { recursive: true });
  for (const name of STATIC_ROOKIE_DOCS) {
    const from = join(source, name);
    const to = join(target, name);
    if (!existsSync(from)) {
      logger.warning("Rookie docs seed missing", { from });
      continue;
    }
    if (existsSync(to)) continue;
    await copyFile(from, to);
  }
}

/** Numeric-prefix sort: "02-x.md" < "10-y.md"; unprefixed files last, alphabetical. */
function docSortKey(fileName: string): { rank: number; name: string } {
  const match = fileName.match(/^(\d+)-/);
  return match
    ? { rank: Number.parseInt(match[1]!, 10), name: fileName }
    : { rank: Number.MAX_SAFE_INTEGER, name: fileName };
}

function humanizeFileName(fileName: string): string {
  return fileName
    .replace(/^\d+-/, "")
    .replace(/\.md$/i, "")
    .split("-")
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/** First "# " heading becomes the sidebar title; falls back to a humanized file name. */
export function extractDocTitle(fileName: string, content: string): string {
  for (const line of content.split("\n")) {
    const match = line.match(/^#\s+(.+?)\s*$/);
    if (match?.[1]) return match[1];
  }
  return humanizeFileName(fileName);
}

/**
 * Read every markdown doc in <projectPath>/herman-docs/ for the renderer
 * docs browser. Missing folder / unreadable files resolve to an empty list.
 */
export async function listProjectDocs(projectPath: string): Promise<ProjectDoc[]> {
  const dir = join(projectPath, HERMAN_DOCS_DIR);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const files = entries
    .filter((f) => f.toLowerCase().endsWith(".md"))
    .map((f) => ({ file: f, key: docSortKey(f) }))
    .sort((a, b) => a.key.rank - b.key.rank || a.key.name.localeCompare(b.key.name))
    .slice(0, MAX_DOCS);

  const docs: ProjectDoc[] = [];
  for (const { file } of files) {
    try {
      const raw = await readFile(join(dir, file), "utf-8");
      const content = raw.length > MAX_DOC_CHARS ? raw.slice(0, MAX_DOC_CHARS) : raw;
      docs.push({ fileName: file, title: extractDocTitle(file, content), content });
    } catch (error) {
      logger.warning("Failed to read project doc", {
        file,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return docs;
}

/**
 * Gate for docs-phase completion. Returns an agent-facing error message when
 * the docs are not ready (the wizard then waits for a corrected
 * herman_complete_wizard call); undefined when all good.
 */
export function validateDocsOutputs(projectPath: string): string | undefined {
  const dir = join(projectPath, HERMAN_DOCS_DIR);
  if (!existsSync(dir)) {
    return `Docs incomplete: the ${HERMAN_DOCS_DIR}/ folder is missing in the project. Create it, write the docs (including a Start Here doc), then call herman_complete_wizard again.`;
  }
  const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".md"));
  if (files.length === 0) {
    return `Docs incomplete: no markdown docs found in ${HERMAN_DOCS_DIR}/. Write the docs (including a Start Here doc), then call herman_complete_wizard again.`;
  }
  const hasStartHere = files.some((f) => /^(\d+-)?start-here\.md$/i.test(f));
  if (!hasStartHere) {
    return `Docs incomplete: missing the Start Here doc (e.g. ${HERMAN_DOCS_DIR}/01-start-here.md). Write it, then call herman_complete_wizard again.`;
  }
  return undefined;
}
```

  (The `ProjectDoc` type is added to `src/shared/rpc.ts` in Milestone C — create this file after/alongside that, so imports resolve.)

---

## Milestone B — Bun: the "docs" wizard phase

All in `apps/desktop/src/bun/`.

### B1. `wizard-session.ts` — phase plumbing

- [ ] Add `"docs"` to the phase union:
  ```ts
  export type WizardPhase = "planning" | "coding" | "qa" | "docs";
  ```
- [ ] Add the budget constant next to the others:
  ```ts
  export const DOCS_TOKEN_BUDGET = '200k';
  ```
- [ ] Import the new helpers:
  ```ts
  import { seedStaticRookieDocs, validateDocsOutputs } from "./rookie-docs.js";
  ```
- [ ] In `resume()` and in `startPhaseAttempt()`, extend the project-path guards to include docs:
  - `if ((this.phase === "coding" || this.phase === "qa") && !this.projectPath)` → `if ((this.phase === "coding" || this.phase === "qa" || this.phase === "docs") && !this.projectPath)` (both occurrences; the error text can stay "coding/QA/docs phase").
- [ ] In `startPhaseAttempt()`, right after the `projectPath` guard and before creating the bridge, seed the static docs (best-effort; never blocks the phase):
  ```ts
  if (this.phase === "docs" && this.projectPath) {
    try {
      await seedStaticRookieDocs(this.projectPath);
    } catch (error) {
      logger.warning("Failed to seed rookie docs", { id: this.id, error });
    }
  }
  ```
- [ ] In `sendPhasePrompts()`, add a docs branch after the qa branch:
  ```ts
  // docs
  const projectPath = this.projectPath as string;
  const goalBody = buildDocsGoal(projectPath);
  this.phaseGoal = goalBody;
  await bridge.sendCommand({
    type: "prompt",
    message: `/goal --tokens ${DOCS_TOKEN_BUDGET} ${goalBody}`,
  });
  ```
- [ ] In `onEvent()`, in the `herman_complete_wizard` handler, change the **qa** branch to advance to docs instead of finishing (keep the coding branch as-is):
  ```ts
  if (this.phase === "qa") {
    this.phaseSignaledComplete = true;
    this.clearRetryTimer();
    this.emit({
      type: "wizard_progress",
      wizardSessionId: this.id,
      text: "Docs & Tutorials — writing your guides…",
    });
    this.recordProgress("Docs & Tutorials — writing your guides…");
    this.advanceToPhase("docs");
    return;
  }

  if (this.phase === "docs") {
    const finalPath = this.projectPath ?? projectPath ?? "";
    const docsError = validateDocsOutputs(finalPath);
    if (docsError) {
      // Same pattern as planning validation: tell the agent what is missing
      // and wait for a corrected completion (or agent_end → retry).
      logger.warning("herman_complete_wizard (docs) rejected", { id: this.id, error: docsError });
      this.emit({ type: "wizard_progress", wizardSessionId: this.id, text: docsError });
      return;
    }
    this.phaseSignaledComplete = true;
    this.clearRetryTimer();
    this.emit({
      type: "wizard_complete",
      wizardSessionId: this.id,
      projectPath: finalPath,
      ...(summary ? { summary } : {}),
    });
    // Stop the agent: the done screen no longer needs a live bridge.
    this.finished = true;
    this.bridgeGeneration++;
    void clearWizardCheckpoint();
    void this.bridge?.stop().catch(() => undefined);
    return;
  }
  ```
  (Move — don't copy — the finish logic from the old qa branch into the docs branch. Note the docs branch does **not** set `phaseSignaledComplete` before validation.)

### B2. `wizard-session.ts` — `buildDocsGoal()`

- [ ] Add this exported function in the Prompts section (after `buildQaGoal`). It embeds the example structure, the full Start Here example, and the publishing outline so the agent has strong guidance. Use exactly this body:

```ts
/** Session 4 — Docs & Tutorials `/goal` body (without the `/goal ` prefix). */
export function buildDocsGoal(projectPath: string): string {
  return `You are in HERMAN WIZARD MODE (Docs & Tutorials phase) for a rookie (non-technical) user.
Do NOT call herman_wizard_ask — there is no user Q&A in this phase.

A working project has just been built and verified at: ${projectPath}
Your mission: write beginner-friendly documentation and tutorials that teach the rookie how THEIR project works, how to manage its content, and how to keep improving it with Herman.

All docs live in: ${projectPath}/herman-docs/ (already created; Herman has seeded static files there).
Do not modify any project code in this phase — only files inside herman-docs/.

## Seeded static files (already in herman-docs/ — do NOT regenerate)
- \`notions-and-terminology.md\` — general Herman/web concepts. Leave content as-is.
- \`herman-agent-quickstart.md\` — how to work with the Herman agent. Leave content as-is.
- \`database.md\` — base explainer. Follow the HTML comment at the bottom: replace the final section with this project's real database details (engine, where it lives, what it stores, how the rookie changes data day-to-day). If the project has NO database, replace that final section with a short note saying so and explain where the site's content comes from instead.
You may RENAME seeded files only to add a 2-digit ordering prefix (e.g. \`notions-and-terminology.md\` → \`02-notions-and-terminology.md\`), keeping the base name.

## Step 1 — understand the project
Explore before writing: package.json scripts, routes/pages, admin panel, data/content models, env files, README/AGENTS.md.
Decide for this project: does it have an admin panel? a database? manageable content (products, posts, users)? Then tailor the docs to what actually exists — never document features the project does not have.

## Step 2 — decide the structure and write the docs
You choose the doc titles, count, and order. Rules:
- ALWAYS include a **Start Here** doc as the entry point.
- File names: kebab-case with a 2-digit ordering prefix: \`01-start-here.md\`, \`02-….md\`. The app's sidebar sorts by this prefix.
- Every doc starts with exactly one \`# Title\` line — it becomes the sidebar label.
- Cross-link docs with relative links inside the folder: \`[text](./other-doc.md)\`. Every linked file must exist.
- Audience: a non-technical rookie. Short sentences, second person ("you"), warm and encouraging. Never use jargon without explaining it. Never tell the user to run terminal commands or edit code — Herman does technical work. (Exception: the publishing doc may include clearly fenced copy-paste commands, with a note that the rookie can ask Herman to do it for them.)
- A good structure for a typical site with an admin panel (adapt freely — merge, split, rename, reorder):
  - \`01-start-here.md\`
  - \`02-notions-and-terminology.md\` (seeded)
  - \`03-herman-agent-quickstart.md\` (seeded)
  - \`04-database.md\` (seeded + your appendix — only when the project has a database)
  - a doc about adding/changing features, with example prompts
  - a doc about managing content (only when the project has an admin panel / content system)
  - a publishing doc

## The "Start Here" doc
Here is a real example from a merchandise + blog project with an admin panel. Adapt every claim to THIS project (what it has, where things live, what the user manages):

\`\`\`md
# Start Here
[Welcome to Herman Agent + very short description of the project]

## How's the project organized?
- The project is split in 2 main parts: **Admin Panel** and **Public Website**.
- Your project also has a **database**, to understand what this is, read the doc in [database.md](./database.md)

## How can I see my website?
- Your website is available on the preview pane when you open the project in Herman. Each new tab will have its own URL to make it easier to work on multiple features without clashing edits.
- Your website can also be visited from your local browser, just copy the URL from the preview pane and paste it in your browser or click the \`Open in Browser\` button in the URL bar.

## Can other people see my website?
Not when you are in \`Development Mode\`. When you are in \`Development Mode\`, your website is only visible to you on your machine. When you want to share your website with others or have it with a live domain, you need to [publish your project](./publishing.md).

## Public Website
- Your public website is the place where your content is displayed to the visitors. This is the core of your project.
- Modifications & prompts about the public website should be about:
  - Design & structure
  - Pages & the logic of how they display data or collect data & forms
  - Static pages (pages that are not managed by the admin panel, read about them in [Notions & Terminology](./notions-and-terminology.md#static-vs-dynamic-pages))

Since you have an admin panel, you should not prompt the agent about adding new blog posts

## Admin Panel
The admin panel is the place to manage the website. At the moment, you can:
- Create/Edit/Delete posts
- Create/Edit/Delete merchandise and their categories with their photos
- Create/Edit/Delete users
- Add products and update their prices

### Opening the admin panel
- Your admin panel is available at /admin page
- You must login. This project has a [seed data](./notions-and-terminology.md#seed-data) functionality. So it should generate your first user and admin user with the credentials. You can ask the Herman Agent to share them with you to login.

### Summary of the Website/Admin Split
- If you want to manage products, users, posts, do this in the admin panel, do not prompt the agent about those tasks.
- If you want to modify **how the website looks** and how does it **present the data**, then you should prompt the agent about those tasks.
- When the website is live in production \`my-project.com\`, you will only be working on the admin panel. \`Herman\` cannot modify the website in production. You can however keep using \`Herman\` to modify locally and then publish the changes.
\`\`\`

## The "adding features" doc
Give concrete, copy-paste-able example prompts for Herman that fit THIS project: one brand-new feature, one new static page, one new dynamic feature, and one enhancement of an existing feature. Briefly explain the static/dynamic difference (link to the terminology doc's #static-vs-dynamic-pages section).

## The "managing content" doc (only when the project has an admin/content system)
Explain what can be managed (products, posts, users… — the real list for this project), how to open the admin panel (the real route), how login works with seed data (tell the rookie to ask Herman for the credentials), and the golden rule: manage CONTENT in the admin panel; ask Herman to change how things LOOK or WORK.

## The "publishing" doc
Structure it like this:
- **What is publishing?** — in simple terms: the project needs somewhere to live on the internet, linked to a domain name, to be visible to the public.
- **How can I publish my project?** — two ways:
  - **Herman Cloud** — say it is not available yet; when it launches it will let the rookie publish their website with one button.
  - **Doing it with a provider** —
    - *Getting a domain name*: briefly why a domain is needed; two examples of where to buy one: Cloudflare and Namecheap.
    - *Choosing a place for the project*: mention there are multiple ways and the rookie can always ask Herman how to publish. Give ONE concrete example: hosting with Coolify on a Hetzner server — non-technical, step by step: buying the Hetzner server (always suggest their cheapest plan), copy-paste commands to install Coolify, then easy steps to publish the project with Coolify.
- End with: Herman is always here to answer questions about publishing and to help step by step.

## Finishing up
1. Re-check every relative link target exists in herman-docs/.
2. Best-effort commit (never fail the phase over git errors — and it's fine if there is no git repo): \`git add herman-docs && git commit -m "Add project docs"\`
3. Call herman_complete_wizard with { projectPath, summary } as your LAST tool call.`;
}
```

### B3. `wizard-checkpoint.ts` — checkpoint support

- [ ] `WizardCheckpointPhase = "planning" | "coding" | "qa" | "docs"`.
- [ ] `evaluateWizardCheckpoint`: treat docs like coding/qa — extend the condition:
  ```ts
  if (checkpoint.phase === "coding" || checkpoint.phase === "qa" || checkpoint.phase === "docs") {
  ```
- [ ] `isWizardCheckpoint`: accept `"docs"` in the phase check.

### B4. `wizard-extension/index.ts` — tool copy

- [ ] In `herman_complete_wizard`'s `description`, change "coding or QA phase" → "coding, QA, or docs phase" (both occurrences — description and `promptGuidelines` first bullet, and the header comment on line ~15).
- [ ] In `herman_wizard_ask`'s `description`, change "Do not use this tool during coding or QA phases." → "…during coding, QA, or docs phases." (Behavior already auto-rejects outside planning — no logic change.)

### B5. `src/shared/rpc.ts` — recovery payload

- [ ] `WizardRecoveryPayload.phase?: "planning" | "coding" | "qa"` → add `| "docs"`.

---

## Milestone C — RPC: reading the docs from the renderer

### C1. `src/shared/rpc.ts`

- [ ] Add the shared type (near `WizardRecoveryPayload`):
  ```ts
  /** One doc file from <project>/herman-docs/, for the Rookie docs browser. */
  export type ProjectDoc = {
    /** File name inside herman-docs/ (e.g. "01-start-here.md"). */
    fileName: string;
    /** First H1 heading (fallback: humanized file name). */
    title: string;
    /** Raw markdown. */
    content: string;
  };
  ```
- [ ] Add the request (right after the `adoptWizardSession` entry, ~line 700):
  ```ts
  getProjectDocs: {
    params: { projectPath: string };
    response: { docs: ProjectDoc[] };
  };
  ```

### C2. `src/bun/index.ts` — handler

- [ ] Import `listProjectDocs` from `./rookie-docs.js`.
- [ ] Add the handler after `adoptWizardSession`:
  ```ts
  getProjectDocs: async ({ projectPath }) => {
    try {
      return { docs: await listProjectDocs(projectPath) };
    } catch (error) {
      logger.warning("getProjectDocs failed", {
        projectPath,
        error: error instanceof Error ? error.message : String(error),
      });
      return { docs: [] };
    }
  },
  ```

### C3. `src/views/main/lib/browser-rpc.ts` — browser mock

- [ ] Add next to the other wizard mocks (after `adoptWizardSession`):
  ```ts
  getProjectDocs: async () => ({ docs: [] }),
  ```

---

## Milestone D — Renderer: done-screen CTAs + docs browser

### D1. Extract `proseClasses` for reuse

- [ ] Create `apps/desktop/src/views/main/components/ui/prose-classes.ts` and move the `proseClasses` constant there verbatim (currently `message-item.tsx` ~line 146), exported:
  ```ts
  export const proseClasses = "…same string…";
  ```
- [ ] In `message-item.tsx`, delete the local constant and import it: `import { proseClasses } from "./ui/prose-classes.js";`
- [ ] Re-export from `apps/desktop/src/views/main/components/ui/index.ts`:
  ```ts
  export { proseClasses } from "./prose-classes.js";
  ```

### D2. New component `apps/desktop/src/views/main/components/wizard-docs-view.tsx`

- [ ] Create the file with this implementation (it is intentionally complete — adjust only formatting):

```tsx
import { ArrowLeft, BookOpen, FileText, Loader2, Sparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { getLogger } from "@logtape/logtape";

import { cn } from "@herman/ui/lib/utils";

import type { ProjectDoc } from "../../../shared/rpc.js";
import { getProjectName } from "../../../shared/tab-utils.js";
import { desktopRpc } from "../lib/desktop-rpc.js";
import { parseMarkdown } from "../lib/markdown-parser.js";
import { ContentWidth, SectionLabel, SignalButton, proseClasses } from "./ui/index.js";

const logger = getLogger(["herman-desktop", "view", "wizard-docs"]);

function docBaseName(href: string): string | null {
  const match = href.match(/([^/]+\.md)(?:#.*)?$/i);
  return match?.[1] ?? null;
}

export function WizardDocsView({
  projectPath,
  onBack,
  onOpenProject,
}: {
  projectPath: string;
  onBack: () => void;
  onOpenProject: () => void;
}) {
  const [docs, setDocs] = useState<ProjectDoc[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [htmlCache, setHtmlCache] = useState<Record<string, string>>({});

  const projectName = getProjectName(projectPath);

  useEffect(() => {
    let cancelled = false;
    desktopRpc.request
      .getProjectDocs({ projectPath })
      .then((result) => {
        if (cancelled) return;
        setDocs(result.docs);
        setSelectedFile((prev) => prev ?? result.docs[0]?.fileName ?? null);
      })
      .catch((err) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("Failed to load project docs", { error: msg });
        setError(msg);
      });
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  const selected = useMemo(
    () => docs?.find((d) => d.fileName === selectedFile) ?? null,
    [docs, selectedFile],
  );

  // Render the selected doc's markdown (async: Shiki + DOMPurify).
  useEffect(() => {
    if (!selected) return;
    const file = selected.fileName;
    if (htmlCache[file]) return;
    let cancelled = false;
    void parseMarkdown(selected.content).then((html) => {
      if (cancelled) return;
      setHtmlCache((prev) => (prev[file] ? prev : { ...prev, [file]: html }));
    });
    return () => {
      cancelled = true;
    };
  }, [selected, htmlCache]);

  // In-app navigation for relative .md links; external links open in the browser.
  const handleContentClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const anchor = (event.target as HTMLElement).closest("a[href]");
      if (!anchor) return;
      const href = anchor.getAttribute("href") ?? "";
      const mdFile = docBaseName(href);
      if (mdFile && docs?.some((d) => d.fileName === mdFile)) {
        event.preventDefault();
        setSelectedFile(mdFile);
        return;
      }
      if (/^https?:\/\//i.test(href)) {
        event.preventDefault();
        void desktopRpc.request.openExternal({ url: href });
      }
    },
    [docs],
  );

  const html = selected ? htmlCache[selected.fileName] : undefined;

  return (
    <div className="flex h-full w-full min-w-0 flex-col">
      {/* Header — mimics the Rookie Home session list header */}
      <div className="border-b border-mist px-6 py-3">
        <ContentWidth size="page" className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="text-ghost hover:text-dim flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs transition hover:bg-fog"
          >
            <ArrowLeft size={13} />
            Back
          </button>
          <div className="text-ghost h-4 w-px bg-white/[0.08]" />
          <div className="text-text min-w-0 flex-1 truncate text-sm font-semibold">
            {projectName} Documentation
          </div>
          <SignalButton size="md" glow className="shrink-0" onClick={onOpenProject}>
            <Sparkles size={14} />
            Open Project
          </SignalButton>
        </ContentWidth>
      </div>

      {error ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <p className="text-dim text-sm">Couldn't load the docs: {error}</p>
          <SignalButton size="md" onClick={onOpenProject}>
            Open Project
          </SignalButton>
        </div>
      ) : docs === null ? (
        <div className="flex flex-1 items-center justify-center gap-2">
          <Loader2 size={18} className="text-signal animate-spin" />
          <span className="text-dim text-sm">Loading your docs…</span>
        </div>
      ) : docs.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
          <div className="text-ghost flex h-12 w-12 items-center justify-center rounded-xl bg-white/[0.02]">
            <BookOpen size={20} strokeWidth={1.5} />
          </div>
          <p className="text-dim max-w-xs text-sm">
            No docs were found in this project yet. You can ask Herman about anything instead.
          </p>
          <SignalButton size="md" glow onClick={onOpenProject}>
            <Sparkles size={14} />
            Open Project
          </SignalButton>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* Docs sidebar */}
          <div className="w-60 shrink-0 overflow-y-auto border-r border-mist px-3 py-4">
            <SectionLabel className="px-3 pb-2">Guides</SectionLabel>
            <div className="flex flex-col gap-0.5">
              {docs.map((doc) => {
                const active = doc.fileName === selectedFile;
                return (
                  <button
                    key={doc.fileName}
                    onClick={() => setSelectedFile(doc.fileName)}
                    className={cn(
                      "flex items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition",
                      active ? "bg-fog text-text" : "text-dim hover:bg-fog hover:text-text",
                    )}
                  >
                    <FileText
                      size={14}
                      strokeWidth={1.5}
                      className={cn("shrink-0", active ? "text-signal" : "text-ghost")}
                    />
                    <span className="min-w-0 truncate">{doc.title}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Reading pane */}
          <div className="flex-1 overflow-y-auto px-6 py-6">
            <ContentWidth size="chat">
              {selected && html ? (
                <>
                  <div
                    className={cn("text-body min-w-0 text-sm leading-relaxed", proseClasses)}
                    onClick={handleContentClick}
                    dangerouslySetInnerHTML={{ __html: html }}
                  />
                  <div className="mt-10 flex flex-col items-center gap-2 border-t border-mist pt-6 text-center">
                    <SignalButton size="lg" glow onClick={onOpenProject}>
                      <Sparkles size={16} />
                      Open Project
                    </SignalButton>
                    <p className="text-ghost text-[11px]">
                      You can always find these docs in your project's herman-docs folder.
                    </p>
                  </div>
                </>
              ) : (
                <div className="flex items-center justify-center gap-2 py-16">
                  <Loader2 size={16} className="text-signal animate-spin" />
                  <span className="text-dim text-sm">Rendering…</span>
                </div>
              )}
            </ContentWidth>
          </div>
        </div>
      )}
    </div>
  );
}
```

  Notes for the implementer:
  - `SectionLabel` accepts a `className` prop (verified in `ui/section-label.tsx`).
  - `openExternal` already exists in the RPC contract (`{ params: { url: string } }`).
  - Markdown anchor fragments (`./x.md#some-heading`) are stripped when navigating (see `docBaseName`); marked does not emit heading ids, so in-page anchor scrolling is intentionally out of scope.

### D3. `onboarding-wizard.tsx` — wire the CTAs and the view

- [ ] Add local state near the other `useState`s:
  ```ts
  const [docsOpen, setDocsOpen] = useState(false);
  ```
- [ ] Import `WizardDocsView` and `BookOpen` (lucide).
- [ ] In the **done** step (`step === "done"` block), replace the final `motion.div` (the one containing the `Open Project` `SignalButton` and the "Opens your project in a new tab." caption) with:
  ```tsx
  <motion.div
    initial={{ opacity: 0, y: 8 }}
    animate={{ opacity: 1, y: 0 }}
    transition={{ delay: 0.35 }}
  >
    <SignalButton size="lg" fullWidth glow className="mt-5" onClick={() => setDocsOpen(true)}>
      <BookOpen size={16} />
      Let's get familiar with your project first
    </SignalButton>
    <button
      type="button"
      onClick={handleDone}
      className="text-dim hover:text-text mt-3 w-full rounded-xl border border-mist bg-white/[0.02] px-4 py-2.5 text-sm transition hover:bg-fog"
    >
      I know how to use Herman, open the project
    </button>
    <p className="text-ghost mt-2 text-center text-[11px]">
      Opens your project in a new tab.
    </p>
  </motion.div>
  ```
- [ ] Also update the done-step header subtitle (in the `StepHeader` block): `step === "done"` → subtitle `"Take a minute to get familiar — or dive right in."` (title stays "Your project is ready").
- [ ] Render the docs view above everything when open. Place this early return **after** the `isLoadingTemplates` check and before the main `return`:
  ```tsx
  if (docsOpen && projectPath) {
    return (
      <WizardDocsView
        projectPath={projectPath}
        onBack={() => setDocsOpen(false)}
        onOpenProject={handleDone}
      />
    );
  }
  ```
  (`handleDone` already adopts the wizard session, calls `onComplete`, and clears wizard state — reuse it as-is.)

---

## Milestone E — Working-step phase indicator ("Docs & Tutorials" label)

Without this, the working step says "Setting up your project" during the docs phase. Add a lightweight phase event.

### E1. `src/shared/agent-protocol.ts`

- [ ] Add to the `WizardSessionEvent` union:
  ```ts
  | {
      type: "wizard_phase";
      wizardSessionId: string;
      phase: "planning" | "coding" | "qa" | "docs";
    }
  ```

### E2. `src/bun/wizard-session.ts`

- [ ] In `start()` (planning begins, after `this.phase = "planning"`): emit
  ```ts
  this.emit({ type: "wizard_phase", wizardSessionId: this.id, phase: this.phase });
  ```
- [ ] In `advanceToPhase()` (after `this.phase = next`): emit the same event.

### E3. Renderer store — `src/views/main/lib/agent-store/types.ts` + `store.ts`

- [ ] In `types.ts`, add a wizard phase type and state field:
  ```ts
  export type WizardPhaseId = "planning" | "coding" | "qa" | "docs";
  ```
  and in `INITIAL_WIZARD_STATE` add `phase: "planning" as WizardPhaseId,`. Ensure the wizard state type includes `phase: WizardPhaseId`.
- [ ] `clearWizardState` already spreads `INITIAL_WIZARD_STATE` — no change needed.
- [ ] In `hydrateWizardFromRecovery` and in the live-reattach `patchWizard` call inside `onboarding-wizard.tsx` (the `getWizardRecovery` effect), pass `phase` through when `recovery.phase` exists so a mid-docs reload shows the right label:
  - In the recovery effect's live branch `patchWizard({ … })`, add `phase: recovery.phase ?? "planning",`.
  - Extend `hydrateWizardFromRecovery`'s payload type (`AgentActions` + implementation) with an optional `phase?: WizardPhaseId` and apply it with a `"planning"` fallback.

### E4. `onboarding-wizard.tsx` — header labels

- [ ] Subscribe to the new state: add `phase: s.wizard.phase` to the `useShallow` selector.
- [ ] In `handleWizardEvent`, handle the new event before the session-id guard (like `wizard_models`) — or after it; either is fine, but it must update state:
  ```ts
  case "wizard_phase": {
    useAgentStore.getState().patchWizard({ phase: event.phase });
    break;
  }
  ```
  (Note: `wizard_phase` is emitted for the current session only; still check `event.wizardSessionId` consistency the same way other events do — the existing guard `if (sessionRef.current && event.wizardSessionId !== sessionRef.current) return;` already covers it when placed inside the switch.)
- [ ] Add a label map near `shortModelLabel`:
  ```ts
  const PHASE_HEADERS: Record<WizardPhaseId, { title: string; subtitle: string }> = {
    planning: { title: "Planning your project", subtitle: "The agent is figuring out the best starting point." },
    coding: { title: "Setting up your project", subtitle: "The agent is on it — this takes a moment." },
    qa: { title: "Verifying everything works", subtitle: "The agent is testing your project end to end." },
    docs: { title: "Writing your docs & tutorials", subtitle: "Almost there — creating guides tailored to your project." },
  };
  ```
  (Import `WizardPhaseId` from `../lib/agent-store/types.js`.)
- [ ] Change the `working` StepHeader to use it:
  ```tsx
  {step === "working" && (
    <StepHeader
      title={PHASE_HEADERS[phase].title}
      subtitle={PHASE_HEADERS[phase].subtitle}
    />
  )}
  ```

---

## Milestone F — Tests & verification

### F1. New `apps/desktop/test/bun/rookie-docs.test.ts`

- [ ] Cover, using temp dirs:
  - `seedStaticRookieDocs` copies the 3 seed files into `<tmp>/herman-docs/` and does NOT overwrite an existing file on a second call.
  - `listProjectDocs` returns docs sorted by numeric prefix (`02-x` before `10-y`), unprefixed last; `title` comes from the first `# ` heading; humanized fallback title for a doc without H1; missing folder → `[]`.
  - `validateDocsOutputs`: missing dir → error string; dir with no `.md` → error; `.md` files but no `start-here` → error; `01-start-here.md` present → `undefined`.

### F2. Update `apps/desktop/test/bun/wizard-prompts.test.ts`

- [ ] Import `buildDocsGoal` and assert it: contains `herman-docs`, the three seeded file names, `01-start-here.md`, `herman_complete_wizard`, the passed `projectPath`, "Do NOT call herman_wizard_ask", and mentions renaming seeds with ordering prefixes. Mirror the existing test style (`makeManifest` is not needed — `buildDocsGoal(projectPath)` takes only a path).

### F3. Update `apps/desktop/test/bun/wizard-checkpoint.test.ts`

- [ ] Add cases: checkpoint with `phase: "docs"` + existing `projectPath` + `capturedPiSessionId` → resumable; `phase: "docs"` + missing project folder → not resumable ("Project folder no longer exists"); `phase: "docs"` without `projectPath` → not resumable ("Missing project path").

### F4. Check other wizard tests

- [ ] `grep -rn '"qa"' apps/desktop/test/bun/wizard-resume.test.ts` (and the whole `test/` dir for phase assumptions); update any test that asserts `wizard_complete` fires after QA (it now fires after docs) or that enumerates phases.

### F5. Full verification

- [ ] `cd apps/desktop && bun run typecheck` — clean.
- [ ] `cd apps/desktop && bun test test` — green.
- [ ] Manual smoke (if a runnable environment is available): run a wizard session end-to-end; confirm the working step shows "Writing your docs & tutorials" during the docs phase; the done screen shows both CTAs; the docs browser lists docs in order, renders markdown, and relative links switch docs; "I know how to use Herman, open the project" performs the handoff; after handoff, `git -C <project> log --oneline` shows `herman-docs/` files in the initial commit; creating a new session tab (worktree) still has `herman-docs/`.

---

## Edge cases & decisions already made (FAQ for implementers)

- **Docs agent finishes without writing docs** → `validateDocsOutputs` rejects the completion with an agent-facing message; the agent fixes and calls `herman_complete_wizard` again (same pattern as `validatePlanningOutputs`). If the agent ends anyway, existing retry machinery kicks in.
- **Docs phase crashes / app quits mid-phase** → checkpoint with `phase: "docs"`; recovery works like coding/qa (project path must exist). Seed copy is idempotent, so retries are safe.
- **Project has no database / no admin panel** → handled by prompt instructions (agent adapts structure; `database.md`'s final section says so).
- **Docs missing at render time** → docs browser shows the empty state with an Open Project CTA; the secondary done-screen CTA always works.
- **Renderer HMR while browsing docs** → `docsOpen` is local state and resets to the done screen. Intentional (keeps wizard recovery logic untouched).
- **Why no explicit "commit docs" step at handoff?** `adoptWizardSession` → `setupProjectRepo` → `initProjectRepo` runs `git add -A` + `git commit "Initial project"`, which includes `herman-docs/`. Worktree tabs for new sessions are created from that commit, so they include the docs. The agent's own best-effort commit during the docs phase lands in the template clone's `.git`, which `setupProjectRepo` replaces — harmless but not load-bearing.
- **Links between docs** use `./file.md` relative form; the docs browser intercepts them (basename match) and switches docs; `http(s)` links go through `openExternal`. `#anchor` fragments are ignored (marked emits no heading ids).

## Non-goals (do NOT implement)

- No docs entry point outside the wizard (e.g., a "Docs" button in the project view or Rookie Home). Possible follow-up.
- No Normal Mode UI.
- No in-page anchor scrolling, no doc search, no editing of docs in-app.
- No `herman-docs` indexing in the agent's context tools or preview pane.
- No changes to `adoptWizardSession` / tab handoff semantics.

## Final acceptance checklist

- [ ] Wizard runs planning → coding → qa → **docs**; `wizard_complete` fires only after docs validation passes.
- [ ] `<project>/herman-docs/` contains the 3 seeded docs (possibly renamed with prefixes) plus generated docs, all with `NN-` prefixes and H1 titles; `database.md`'s final section is project-specific.
- [ ] Done screen: primary CTA "Let's get familiar with your project first" opens the docs browser; secondary CTA "I know how to use Herman, open the project" opens the project.
- [ ] Docs browser: back button returns to the done screen; header shows "[Project Name] Documentation" + Open Project button; sidebar lists docs in prefix order by H1 title; clicking renders markdown; relative links navigate; external links open the OS browser.
- [ ] After handoff, `herman-docs/` is in the project's initial git commit and present in new worktree tabs.
- [ ] Working step header reflects the current phase, including "Writing your docs & tutorials".
- [ ] `bun run typecheck` clean; `bun test test` green (including new/updated tests).
