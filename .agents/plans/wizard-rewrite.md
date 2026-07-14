# Wizard Rewrite — Agent-Driven Wizard Session

> Status: COMPLETE — verified in dev, ready for production build validation
> Owner: agent
> Started: 2026-07-13

## Goal

Replace the current compile→triage→static-form wizard with a single **agent
session that runs in "wizard mode"** and asks the user questions through a
Herman-native `herman_wizard_ask` tool. The React UI renders the questions the
agent produces (text / choice / multi-select, with a progress bar) and streams
the agent's setup progress (clone, install, migrate, env) live.

## Why

The current pipeline (`wizard-compiler.ts` + `template-triage.ts`) makes two
fragile 60–90s headless agent calls to turn author prose into a static
`WizardSpec`, then a second call to triage which questions the user's
description already answered. The output is free-form text only, so
"payments now or catalog first?" becomes a blank textarea. And the build agent
never sees `## Guidance` — `create-project.ts:buildSetupPrompt` drops it.

An agent session that reads the manifest directly and asks via a structured
tool eliminates both headless calls, enables richer question types, lets the
agent adaptively follow up, and unifies questioning + building in one context.

## The round trip (the hard part — verified feasible)

Pi's RPC mode has a request/response sub-protocol for extension UI dialogs.
The closed set of dialog methods is `select` / `confirm` / `input` / `editor`.
`ctx.ui.custom()` returns `undefined` in RPC mode (confirmed in
`docs/rpc.md`), so we cannot port edb-ask-user's TUI component. We borrow its
**schema + interaction model** and render with React.

Carrier: `ctx.ui.editor(title, prefill=<envelope JSON>)` round-trips a string.
Herman intercepts `editor` requests whose `prefill` starts with our sentinel
`{"__herman_wizard__":true,...}`, routes the questions to the React wizard,
collects answers, and writes `extension_ui_response {id, value:<answers JSON>}`
back to the agent's stdin via `AgentBridge.sendRaw`. The tool's `editor()` call
resolves with the answers JSON string; the tool parses it and returns it to the
LLM as the tool result. One tool call = one question batch.

Verified primitives:
- Agent subprocess launched with `--mode rpc` (`agent-process.ts:82`).
- `ctx.ui.editor(title, prefill?) => Promise<string|undefined>` exists
  (`dist/core/extensions/types.d.ts:134`).
- `sendRaw` writes raw JSONL to stdin (`agent-rpc.ts:126`).
- `extension_ui_request` events flow through `AgentBridge.onEvent`
  (`agent-bridge.ts`).
- Extensions load via `settings.json { extensions: [paths] }`, which
  `prepareAgentDir` already writes (`agent-bridge.ts:prepareAgentDir`).

## Flow

1. **Templates** (React, unchanged) — pick template via `getGalleryTemplates`.
2. **Describe** (React, unchanged) — freeform description.
3. **Loading + agent start** — React calls `startWizardSession({templateId, description})`:
   - bun resolves the manifest, creates a **staging dir** `~/Herman/.wizard-<tabId>`,
     starts an `AgentBridge` there in rookie mode with the wizard extension
     injected, sends the **wizard prompt** (manifest `## Setup` + `## Questions`
     + `## Guidance` + frontmatter env/requirements + description + wizard-mode
     instructions).
   - The agent clones the template source into `~/Herman/<projectName>` (name
     from the mandatory first question), via its bash tool. Clone progress
     streams via `tool_execution_*` / `message_*` events → React loading view.
4. **Questions** — agent calls `herman_wizard_ask({questions})`; bridge emits
   `herman/wizard_request`; React renders the batch (text/choice/multi,
   password for secrets, progress bar). On submit, React calls
   `respondWizardQuestions({tabId, id, answers})` → bridge sends
   `extension_ui_response`. The agent may call the tool again → loop.
5. **Setup** — agent runs install / migrate / env; progress streams to React.
   Agent calls `herman_complete_wizard({projectPath, summary})`; bridge emits
   `herman/wizard_complete`.
6. **Done** — React calls `onComplete(projectPath)`; the wizard agent session
   is handed off as the project's first chat tab (same session continues).

## Invariants (from user)

- **First question is ALWAYS project name** (`id: "projectName"`), regardless
  of manifest. Enforced in the extension: if the agent's `herman_wizard_ask`
  call omits a `projectName` question, the extension **prepends one** before
  sending to the UI. The agent uses this name for the folder name, app/title
  updates, etc.
- **Secrets**: manifest env vars with a `generate` shell command (e.g.
  `BETTER_AUTH_SECRET` → `bun auth:secret`) are run by the agent via bash; the
  user never sees them. Non-API-key secrets without `generate` are **skippable**
  — the agent fills a placeholder value (instructed in the prompt). API keys
  (required, no `generate`) are asked by the agent via `herman_wizard_ask` with
  `secret: true` (password field).
- **Continue the session** into the normal chat shell on completion.
- **Cancel cleanup**: if the user bails after the agent has cloned, delete the
  partial project dir + staging dir.

## Question schema (ported from edb-ask-user, React-rendered)

```ts
type WizardAskQuestion = {
  id: string;
  prompt: string;
  type: "text" | "choice";
  label?: string;          // tab/short label
  placeholder?: string;
  options?: { value: string; label: string; description?: string }[];
  multiple?: boolean;      // multi-select for choice
  required?: boolean;      // default true
  secret?: boolean;        // password input (env keys)
};

type WizardAskEnvelope = {
  __herman_wizard__: true; // sentinel
  version: 1;
  header?: string;
  questions: WizardAskQuestion[];
};

type WizardAskAnswers = {
  answers: { id: string; value: string; values?: string[] }[];
  cancelled: boolean;
};
```

## Components / files

### New
- [ ] `apps/desktop/src/bun/wizard-extension/index.ts` — pi extension registering
      `herman_wizard_ask` + `herman_complete_wizard` tools. Shipped as a `.ts`
      file referenced from the per-tab `settings.json`.
- [ ] `apps/desktop/src/shared/wizard-protocol.ts` — envelope/answer types +
      sentinel constant + parse/encode helpers (shared by extension, bridge, React).
- [ ] `apps/desktop/src/bun/wizard-session.ts` — orchestrates a wizard agent
      session: create staging dir, start bridge, send prompt, hold pending
      `editor` request ids, route responses, cancel + cleanup.
- [ ] `apps/desktop/src/views/main/components/wizard-questions.tsx` — React
      renderer for a `WizardAskEnvelope` (text/choice/multi/secret + progress).

### Modified
- [ ] `apps/desktop/src/shared/agent-protocol.ts` — add `herman/wizard_request`,
      `herman/wizard_complete` event types; `herman_wizard_respond` command.
- [ ] `apps/desktop/src/bun/agent-bridge.ts` — detect sentinel `editor` requests
      in `enrichExtensionUiEvent`, expose `sendExtensionUiResponse(id, value)`,
      add `extensions: [<wizard ext path>]` to `prepareAgentDir` settings.json.
- [ ] `apps/desktop/src/shared/rpc.ts` — `startWizardSession`,
      `respondWizardQuestions`, `cancelWizard` RPC methods.
- [ ] `apps/desktop/src/bun/index.ts` — register wizard RPC handlers using
      `wizard-session.ts`.
- [ ] `apps/desktop/src/views/main/components/onboarding-wizard.tsx` — rewrite
      to be agent-driven (templates → describe → loading → questions → setup →
      done), consuming wizard events from the bridge.
- [ ] `apps/desktop/src/bun/create-project.ts` — keep env/helpers used by agent
      prompt; remove the now-dead static build path (or leave for non-wizard
      callers). Agent does clone/install in-wizard.

### Deleted / deprecated
- [ ] `apps/desktop/src/bun/wizard-compiler.ts` — delete (agent reads manifest).
- [ ] `apps/desktop/src/bun/template-triage.ts` — delete (agent self-triages).
- [ ] `WizardSpec` / `WizardQuestion` in `herman-manifest.ts` — remove once
      nothing references them (replaced by `wizard-protocol.ts` types).
- [ ] `compileWizard` / `triageTemplateQuestions` RPC entries — remove.

## Progress checklist

### Phase A — shared protocol + extension
- [x] A1. Write `wizard-protocol.ts` (types, sentinel, encode/parse).
- [x] A2. Write the pi extension (`wizard-extension/index.ts`) with
      `herman_wizard_ask` (ctx.ui.editor round trip + projectName injection)
      and `herman_complete_wizard` (informational).
- [x] A3. Verified the extension loads: pi's loader (`dist/core/extensions/loader.js`)
      resolves `typebox` / `@earendil-works/pi-ai` / `@earendil-works/pi-coding-agent`
      via `virtualModules` (Bun binary) / `alias` (dev) to pi's own bundled copies,
      so the extension's imports resolve regardless of file location. Ship the
      `index.ts` dir via the electrobun `copy` map and reference its absolute
      path in `settings.json { extensions: [...] }` (done in B3).

### Phase B — bridge plumbing
- [x] B1. Add `WizardSessionEvent` type + `tryParseWizardRequest` helper to
      `agent-protocol.ts` (wizard events use a dedicated channel, not the tab
      AgentEvent path, since the wizard runs as a detached bridge).
- [x] B2. `agent-bridge.ts`: `sendExtensionUiResponse(id, payload)` +
      `agent-rpc.ts`: `sendRawObject(obj)` for writing `extension_ui_response`
      to the agent stdin.
- [x] B3. `agent-bridge.ts`: inject wizard extension into `prepareAgentDir`
      settings.json `extensions` array via `resolveWizardExtensionPath()`;
      added `src/bun/wizard-extension` to the electrobun `copy` map.
      Added `typebox` + `@earendil-works/pi-ai` to the root catalog + desktop
      devDependencies (typecheck-only; pi's loader provides them at runtime).
- [x] B4. `herman_complete_wizard` tool-call detection handled in the session
      orchestrator (`wizard-session.ts`) via `tool_execution_start` events
      (Phase C).

### Phase C — session orchestration (bun)
- [x] C1. `wizard-session.ts`: staging dir (agent cwd = ~/Herman projects dir),
      start detached `AgentBridge` with isolated agent dir, build + send the
      wizard prompt (manifest + description + env/secret instructions +
      projectName invariant + herman_complete_wizard).
- [x] C2. Pending-request map: `respond()` sends `extension_ui_response` via
      `sendExtensionUiResponse`; stale-id guarded.
- [x] C3. Cancel: sends `cancelled` ui_response, stops agent, cleans agent dir,
      deletes the cloned project dir if the agent created one.
- [x] C4. Registered RPC handlers in `bun/index.ts` (`startWizardSession`,
      `respondWizardQuestions`, `cancelWizard`); added RPC types +
      `wizardEvent` outgoing message to `rpc.ts`; wired `wizardEvent` send +
      `WizardSessionManager`; added the methods/listener to `browser-rpc.ts`
      and `desktop-rpc-electrobun.ts`.

### Phase D — React UI
- [x] D1. `wizard-questions.tsx`: renders text/choice/multi/secret with a
      one-question-at-a-time flow + progress bar (ported edb-ask-user schema,
      React surface).
- [x] D2. Rewrote `onboarding-wizard.tsx` state machine: templates → describe →
      working (progress log) → questions → done/error; subscribes to
      `wizardEvent`; calls `startWizardSession`/`respondWizardQuestions`/
      `cancelWizard`/`adoptWizardSession`.
- [x] D3. `adoptWizardSession` RPC + `AgentProcessManager.adoptWizardSession`
      copies the wizard pi session JSONL into the new tab's session dir and
      resumes it; bun handler emits `tabCreated`/`tabActivated`; `onComplete`
      is now `() => void` (rookie-shell + app.tsx just switch to session view).

### Phase E — cleanup
- [x] E1. Deleted `wizard-compiler.ts`, `template-triage.ts`, `create-project.ts`.
- [x] E2. Removed `WizardSpec`/`WizardQuestion`/`TriageResult` from
      `herman-manifest.ts`; removed `compileWizard`/`triageTemplateQuestions`/
      `createProjectFromTemplate` RPC types + handlers + browser-rpc mocks;
      added `typebox`/`@earendil-works/pi-ai`/`@earendil-works/pi-tui` to
      `@herman/agent` deps (needed for pi loader's `import.meta.resolve` alias
      map when loading external extensions).
- [x] E3. Typecheck clean (workspace + desktop) + 375 tests pass (0 fail).
      Added `wizard-protocol.test.ts` (10 tests).
- [x] E4. Added prebuild step (`scripts/prebuild.ts`) to copy the 4 required
      packages (typebox, pi-ai, pi-tui, pi-agent-core) dereferenced into
      `packages/agent/dist/node_modules/` for production. Copy logic verified
      standalone; needs `electrobun build` validation.

## Production validation (to verify on a real build)

- [ ] Build the app with `electrobun build --env=stable` and run it.
      Verify the wizard extension loads (no "Failed to load extension" in
      agent stderr) and the round trip works end to end.
- [ ] Verify the `packages/agent/dist/node_modules/` copy step won't collide
      with `rm -rf` in `@herman/agent build` (`rm -rf dist`). Currently
      `build` runs before `copyAgentExtensionDeps`, so the copy survives.
      Verify this order holds in the electrobun build pipeline.
