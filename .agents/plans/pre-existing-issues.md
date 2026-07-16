# Pre-existing Issues in agent-process-manager.ts

Issues discovered during the second-pass review of the `registerAndOpenTab` DRY
refactor.  None of these were introduced by that refactor — they predate it and are
noted here for future cleanup.

---

## 1. `createTab` leaves `tab.projectRoot` set to `rawPath` when no git repo is found

**Location**: `createTab()` in `apps/desktop/src/bun/agent-process-manager.ts`

**What happens**:
- `makeTab(rawPath, …)` sets `projectRoot: folderPath` (which is `rawPath`).
- When `resolveProjectRoot(rawPath)` returns `""` (no `.git` ancestor), the
  `if (projectRoot) { tab.projectRoot = projectRoot; … }` block is skipped.
- `tab.projectRoot` stays as `rawPath` — a non-empty path that is **not** a
  real project root.

**Impact**:
- The tab object carries a misleading `projectRoot`.
- `toPersistedSession` serialises it, so it persists across restarts.
- Mitigated on next open: `openSession` has a legacy fallback
  (`if (!persisted.projectRoot && persisted.folderPath) …`) that re-resolves it.

**Suggested fix**:
```typescript
if (projectRoot) {
  tab.projectRoot = projectRoot;
  tab.projectColor = getProjectColor(projectRoot);
  if (!title) {
    tab.title = getProjectName(projectRoot);
  }
} else {
  tab.projectRoot = "";
}
```

**Risk**: Low.  The change is localised.  The `openSession` fallback means even
if some code path depended on the stale value it would self-heal on next open.

---

## 2. `openSession` worktree check uses `tab.folderPath` for truthiness but `tab.projectRoot` for `isGitRepo`

**Location**: `openSession()` in `apps/desktop/src/bun/agent-process-manager.ts`

**What happens**:
```typescript
if (mode === "rookie" && tab.folderPath && (await isGitRepo(tab.projectRoot))) {
```

`tab.folderPath` and `tab.projectRoot` can diverge:
- `tab.folderPath` is the working directory (may be a worktree subdirectory).
- `tab.projectRoot` is the main repo root (from persistence or `resolveProjectRoot`).

If `tab.folderPath` is set but `tab.projectRoot` is empty (possible for legacy
sessions without a populated `projectRoot`), `isGitRepo("")` returns `false` and
the worktree block is silently skipped.  The agent then runs directly in
`tab.folderPath` without isolation.

**Impact**:
- Rookie-mode session isolation is silently bypassed for affected legacy
  sessions.
- The session still works, just without the worktree sandbox.

**Suggested fix**: Use `tab.projectRoot` for both checks, or ensure `tab.projectRoot`
is always populated before this point (the legacy fallback a few lines above
handles `persisted.projectRoot` but `tab` comes from hydration which may still
have an empty `projectRoot` if `persisted.folderPath` was also empty).

```typescript
// Ensure tab.projectRoot is populated before the worktree decision.
if (!tab.projectRoot && tab.folderPath) {
  tab.projectRoot = await resolveProjectRoot(tab.folderPath);
}
```

**Risk**: Low-medium.  The hydration path is complex; test with legacy session
data before landing.

---

## 3. `ensureSessionWorktree` is called synchronously (awaited) inside `openSession`

**Location**: `openSession()` in `apps/desktop/src/bun/agent-process-manager.ts`

**What happens**:
When a worktree already exists on disk (`tab.worktree` is truthy), `openSession`
calls `await ensureSessionWorktree(tab)` inline — blocking the tab-open flow
until the filesystem check completes.

By contrast, `createTab` and `openPiSession` never block on worktree I/O; they
return immediately with `worktreeStatus: "pending"` and let `finalizeTabWorktree`
handle it in the background.

**Impact**:
- Re-opening a session with an existing worktree is slower than it needs to be
  (blocked on `ensureSessionWorktree` which may access the filesystem).
- Inconsistent with the "tab opens instantly" design used everywhere else.

**Suggested fix**: Defer `ensureSessionWorktree` to the background as well.  The
simplest path: always set `needsWorktree = true` when `tab.worktree` exists,
let `finalizeTabWorktree` call `ensureSessionWorktree` (or a variant), and
return the tab immediately with `folderPath = tab.projectRoot`.

This is more involved because `finalizeTabWorktree` currently calls
`createSessionWorktree` (create-or-error), not `ensureSessionWorktree`
(find-or-reuse).  May require a small refactor of the background path to
handle both cases.

**Risk**: Medium.  The two worktree helpers (`createSessionWorktree` vs
`ensureSessionWorktree`) have different contracts, and the error-recovery path
in `finalizeTabWorktree` assumes creation semantics.

---

## Prioritisation

| # | Issue | Severity | Effort | Recommendation |
|---|---|---|---|---|
| 1 | Stale `tab.projectRoot` in `createTab` | Low | Trivial | Fix next time you touch `createTab` |
| 2 | `tab.folderPath` vs `tab.projectRoot` in worktree check | Low-medium | Small | Pair with #1; both touch projectRoot hygiene |
| 3 | Blocking `ensureSessionWorktree` in `openSession` | Medium (perf) | Medium | Worth a dedicated follow-up; changes background-worktree contract |
