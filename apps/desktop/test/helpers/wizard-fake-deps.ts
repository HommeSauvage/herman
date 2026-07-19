import type { WizardSessionDeps } from "../../src/bun/wizard-session.js";
import type { ResolvedManifest } from "../../src/shared/herman-manifest.js";

/**
 * Fake dependencies for wizard session tests: gates always pass, the preview
 * is immediately ready, the template registry returns a fixed manifest, no
 * wizard extensions resolve, and bridges come from the test's own
 * MockAgentBridge factory.
 *
 * Inject through `WizardSessionOptions.deps` (or the manager's third
 * constructor arg) — never via mock.module: bun's mock records are
 * process-wide, leak into later-loaded test files, and freeze once linked by
 * a dependent.
 */
export function fakeWizardDeps(opts: {
  /** The test file's MockAgentBridge constructor (loosely typed at the boundary). */
  createBridge: unknown;
  /** Manifest returned by resolveTemplateManifest. Defaults to a minimal blog. */
  manifest?: ResolvedManifest;
  overrides?: Partial<WizardSessionDeps>;
}): WizardSessionDeps {
  const manifest = opts.manifest ?? DEFAULT_FAKE_MANIFEST;
  const base = {
    ensurePreviewStarted: async (scope: string, folderPath: string) => ({
      scope,
      folderPath,
      serverId: "web",
      phase: "ready" as const,
      url: "http://localhost:3000",
      port: 3000,
      starting: false,
    }),
    getDevServerStatus: (scope: string) => ({
      scope,
      folderPath: "",
      primaryServerId: "web",
      phase: "ready" as const,
      servers: [
        {
          scope,
          folderPath: "",
          serverId: "web",
          phase: "ready" as const,
          url: "http://localhost:3000",
          port: 3000,
        },
      ],
    }),
    stopPreviewsForScope: async () => {},
    runCodingGate: async () => ({ passed: true, report: "", warnings: [] as string[] }),
    runQaGate: async () => ({ passed: true, report: "", warnings: [] as string[] }),
    resolveTemplateManifest: async () => manifest,
    resolveWizardExtensionPath: () => [] as string[],
    createBridge: opts.createBridge as WizardSessionDeps["createBridge"],
  };
  return { ...base, ...opts.overrides } as WizardSessionDeps;
}

export const DEFAULT_FAKE_MANIFEST: ResolvedManifest = {
  id: "blog",
  frontmatter: {
    version: 1,
    name: "Blog",
    description: "A personal blog",
    source: { repo: "https://github.com/example/blog.git", ref: "main" },
    setup_goal: "Homepage loads",
  },
  sections: {
    setup: "Install deps.",
    questions: "- Topics?",
    guidance: "Keep it simple.",
  },
  serialized: "",
};
