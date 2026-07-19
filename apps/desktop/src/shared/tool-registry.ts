/**
 * Curated tool registry — the single source of truth for "how does Herman
 * install tool X on platform Y".
 *
 * Templates declare requirement *identity* (`id: php` in HERMAN.md); this
 * registry owns the *how*. Adding a tool is data, not code: a new entry with
 * per-platform install strategies. Tools without a registry entry fall back
 * to the manifest's `install_cmd` (custom command) or `install` (manual URL).
 *
 * Tiers:
 *  - 0: required for Herman to function at all (git, brew on macOS, bun).
 *       Missing tier-0 tools gate the app behind a one-time setup screen.
 *  - 1: needed by curated templates (php, composer, node). Installed during
 *       the wizard's pre-planning "Getting your computer ready" step.
 *  - 2: on-demand (python, docker). Installed when a template declares them.
 *
 * This file is shared with the renderer — keep it free of Node/Bun APIs.
 */

export type ToolTier = 0 | 1 | 2;

export type ToolPlatform = "macos" | "windows" | "linux";

export type ToolStrategy =
  /** Apple Command Line Tools via the native `xcode-select --install` dialog. */
  | { kind: "clt" }
  /** Homebrew bootstrap: one admin prompt (mkdir+chown) + tarball extract. */
  | { kind: "brew-bootstrap" }
  /** User-scope shell script, e.g. the bun installer. No admin needed. */
  | { kind: "curl-sh"; command: string }
  /** `brew install <formula>` (user-scope; brew must be present). */
  | { kind: "brew-formula"; formula: string }
  /** Windows winget package (user scope where possible). */
  | { kind: "winget"; packageId: string }
  /** No silent install — guided manual step with a download URL. */
  | { kind: "manual"; url: string };

export type ToolRegistryEntry = {
  /** Matches the requirement `id` in HERMAN.md manifests. */
  id: string;
  label: string;
  /** Plain-language reason shown to non-technical users. */
  why: string;
  tier: ToolTier;
  /** Detection command; exit 0 = installed (same semantics as manifest checks). */
  check: string;
  /**
   * Directories prepended to PATH (and retried) when `check` fails — covers
   * "installed but Herman was launched before PATH picked it up".
   */
  probeDirs?: string[];
  /** Other registry ids that must be installed first. */
  dependsOn?: string[];
  platforms: Partial<Record<ToolPlatform, ToolStrategy>>;
};

export const TOOL_REGISTRY: ToolRegistryEntry[] = [
  {
    id: "git",
    label: "Git",
    why: "Downloads your project and saves its history, so you can always undo changes.",
    tier: 0,
    check: "git --version",
    platforms: {
      macos: { kind: "clt" },
      windows: { kind: "winget", packageId: "Git.Git" },
      linux: { kind: "manual", url: "https://git-scm.com/downloads" },
    },
  },
  {
    id: "brew",
    label: "Homebrew",
    why: "The tool Herman uses to install other free tools your projects need (like PHP).",
    tier: 0,
    check: "brew --version",
    probeDirs: ["/opt/homebrew/bin", "/usr/local/bin"],
    // Homebrew is the install backbone on macOS only. Windows/Linux use
    // winget / their native package manager, so brew is not required there.
    platforms: {
      macos: { kind: "brew-bootstrap" },
    },
  },
  {
    id: "bun",
    label: "Bun",
    why: "Runs your website on your computer and installs its building blocks.",
    tier: 0,
    check: "bun --version",
    probeDirs: ["~/.bun/bin"],
    platforms: {
      macos: { kind: "curl-sh", command: "curl -fsSL https://bun.sh/install | bash" },
      linux: { kind: "curl-sh", command: "curl -fsSL https://bun.sh/install | bash" },
      windows: { kind: "winget", packageId: "Oven-sh.Bun" },
    },
  },
  {
    id: "php",
    label: "PHP",
    why: "Runs your website's backend — the part that thinks and remembers.",
    tier: 1,
    check: "php --version",
    probeDirs: ["/opt/homebrew/bin", "/usr/local/bin"],
    dependsOn: ["brew"],
    platforms: {
      macos: { kind: "brew-formula", formula: "php" },
      windows: { kind: "manual", url: "https://herd.laravel.com/windows" },
      linux: { kind: "manual", url: "https://www.php.net/downloads" },
    },
  },
  {
    id: "composer",
    label: "Composer",
    why: "Installs the PHP building blocks your project is made of.",
    tier: 1,
    check: "composer --version",
    probeDirs: ["/opt/homebrew/bin", "/usr/local/bin"],
    dependsOn: ["brew"],
    platforms: {
      macos: { kind: "brew-formula", formula: "composer" },
      windows: { kind: "manual", url: "https://getcomposer.org/download/" },
      linux: { kind: "manual", url: "https://getcomposer.org/download/" },
    },
  },
  {
    id: "node",
    label: "Node.js",
    why: "Runs JavaScript tools that some projects rely on.",
    tier: 1,
    check: "node --version",
    probeDirs: ["/opt/homebrew/bin", "/usr/local/bin"],
    dependsOn: ["brew"],
    platforms: {
      macos: { kind: "brew-formula", formula: "node" },
      windows: { kind: "winget", packageId: "OpenJS.NodeJS.LTS" },
      linux: { kind: "manual", url: "https://nodejs.org/en/download" },
    },
  },
  {
    id: "python",
    label: "Python",
    why: "Runs scripts and AI helpers that some templates use.",
    tier: 2,
    check: "python3 --version",
    probeDirs: ["/opt/homebrew/bin", "/usr/local/bin"],
    dependsOn: ["brew"],
    platforms: {
      macos: { kind: "brew-formula", formula: "python" },
      windows: { kind: "winget", packageId: "Python.Python.3.13" },
      linux: { kind: "manual", url: "https://www.python.org/downloads/" },
    },
  },
  {
    id: "docker",
    label: "Docker",
    why: "Runs apps in self-contained containers. Only a few advanced templates need it.",
    tier: 2,
    check: "docker --version",
    platforms: {
      macos: { kind: "manual", url: "https://www.docker.com/products/docker-desktop/" },
      windows: { kind: "manual", url: "https://www.docker.com/products/docker-desktop/" },
      linux: { kind: "manual", url: "https://docs.docker.com/engine/install/" },
    },
  },
];

const byId = new Map(TOOL_REGISTRY.map((t) => [t.id, t]));

export function getToolEntry(id: string): ToolRegistryEntry | undefined {
  return byId.get(id);
}

export function currentToolPlatform(): ToolPlatform {
  if (typeof process !== "undefined" && process.platform === "win32") return "windows";
  if (typeof process !== "undefined" && process.platform === "linux") return "linux";
  return "macos";
}

export function getStrategy(entry: ToolRegistryEntry, platform: ToolPlatform): ToolStrategy | undefined {
  return entry.platforms[platform];
}

/**
 * Tier-0 tools required on the given platform — i.e. tier-0 entries that
 * actually have a strategy there (brew is macOS-only, so it's absent on
 * Windows/Linux where git+bun are the whole baseline).
 */
export function getRequiredTier0Ids(platform: ToolPlatform): string[] {
  return TOOL_REGISTRY.filter((t) => t.tier === 0 && t.platforms[platform]).map((t) => t.id);
}

/**
 * Stable topological order: dependencies install before dependents.
 * Unknown ids and cycles are tolerated (appended in input order).
 */
export function orderByDependency(toolIds: string[]): string[] {
  const remaining = [...toolIds];
  const ordered: string[] = [];
  const done = new Set<string>();

  while (remaining.length > 0) {
    const before = remaining.length;
    for (let i = 0; i < remaining.length; i++) {
      const id = remaining[i]!;
      const deps = byId.get(id)?.dependsOn ?? [];
      if (deps.every((d) => done.has(d) || !toolIds.includes(d))) {
        ordered.push(id);
        done.add(id);
        remaining.splice(i, 1);
        i--;
      }
    }
    // Cycle or unresolvable — flush the rest in input order.
    if (remaining.length === before) {
      ordered.push(...remaining);
      break;
    }
  }
  return ordered;
}

// ── Status / event wire shapes (shared with the renderer) ───────────────────

export type ToolchainToolStatus = {
  id: string;
  label: string;
  why: string;
  tier: ToolTier;
  installed: boolean;
  /** False when Herman has no install strategy for this platform. */
  supported: boolean;
  /** Version line or error detail from the detection command. */
  detail?: string;
  /** Set for manual-strategy tools — UI renders a guided download step. */
  manualUrl?: string;
};

/** One item in an install run (registry tool, or ad-hoc custom command). */
export type ToolInstallItem = {
  toolId: string;
  /** Overrides the registry strategy — from a manifest `install_cmd` or agent. */
  customCommand?: string;
  /** Display overrides for ad-hoc items not in the registry. */
  label?: string;
};

export type ToolInstallResult = {
  toolId: string;
  ok: boolean;
  error?: string;
};

export type ToolchainEvent =
  | { type: "tool-start"; runId: string; toolId: string; label: string; message?: string }
  | { type: "tool-log"; runId: string; toolId: string; text: string }
  /** A native OS dialog is up or an async system installer is running. */
  | { type: "tool-waiting"; runId: string; toolId: string; message: string }
  | { type: "tool-done"; runId: string; toolId: string; ok: boolean; error?: string }
  | { type: "all-done"; runId: string; ok: boolean; results: ToolInstallResult[] };
