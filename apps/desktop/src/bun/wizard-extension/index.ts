/**
 * Herman wizard extension (loaded by the pi agent subprocess in wizard mode).
 *
 * Registers three tools:
 *
 *  - `herman_wizard_ask` — ask the user a batch of structured questions
 *    (text / choice / multi-select / secret) and get the answers back, with no
 *    extra model round-trip. Carried over pi's `ctx.ui.editor()` RPC dialog
 *    sub-protocol: the envelope JSON is the editor `prefill`; Herman's bridge
 *    detects the sentinel and routes it to the React wizard, which returns the
 *    answers as the editor `value`. See `docs/rpc.md`.
 *
 *  - `herman_complete_planning` — signal that planning is done (plan MD written).
 *
 *  - `herman_complete_wizard` — signal that a coding, QA, or docs phase is finished
 *    and report the final project path. Informational; the host captures the
 *    args from the tool-execution event stream.
 *
 * ZERO-RUNTIME-IMPORT by design: this file is loaded by pi's jiti from an
 * absolute path inside the bundled app, where `typebox` / `@earendil-works/pi-ai`
 * are NOT resolvable as separate modules (the agent is a `bun build` bundle,
 * not a `--compile` binary, so pi's loader uses `require.resolve` aliases that
 * would fail). Therefore:
 *   - `import type` is used for `ExtensionAPI` / `ExtensionContext` (erased by
 *     jiti at runtime — no module resolution needed).
 *   - Parameter schemas are plain JSON Schema objects (pi does NOT Compile/Check
 *     custom tool parameters — it passes the schema straight to the LLM).
 *   - `node:fs` is a Node builtin and safe to import here for path checks.
 *
 * The wire shapes MUST match `apps/desktop/src/shared/wizard-protocol.ts`;
 * keep them in sync.
 */

import { existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ── Wire shapes (mirror shared/wizard-protocol.ts) ────────────────────────────

const WIZARD_PROTOCOL_VERSION = 1;
const PROJECT_NAME_QUESTION_ID = "projectName";
const VISUAL_TONE_QUESTION_ID = "visualTone";

type WizardOption = { value: string; label: string; description?: string };

type WizardAskQuestion = {
  id: string;
  prompt: string;
  type: "text" | "choice";
  label?: string;
  placeholder?: string;
  options?: WizardOption[];
  multiple?: boolean;
  required?: boolean;
  secret?: boolean;
};

type WizardAskEnvelope = {
  __herman_wizard__: true;
  version: 1;
  header?: string;
  questions: WizardAskQuestion[];
};

type WizardAnswer = { id: string; value: string; values?: string[] };
type WizardAskAnswers = { answers: WizardAnswer[]; cancelled: boolean };

// ── Install-request shapes (mirror shared/wizard-protocol.ts — keep in sync) ─

type WizardInstallEnvelope = {
  __herman_install__: true;
  version: 1;
  toolId: string;
  label: string;
  reason?: string;
  check?: string;
  installCmd?: string;
};

type WizardInstallResponse = {
  approved: boolean;
  installed: boolean;
  detail?: string;
};

type WizardAskParams = { header?: string; questions: WizardAskQuestion[] };
type WizardCompleteParams = { projectPath: string; summary?: string };
type WizardCompletePlanningParams = {
  projectPath: string;
  planPath: string;
  summary?: string;
};
type WizardCompleteDesignParams = {
  projectPath: string;
  designPath: string;
  planPath: string;
  summary?: string;
};

type WizardGateEnvelope = {
  __herman_gate__: true;
  version: 1;
  phase: "unknown";
  projectPath: string;
  summary?: string;
};

type WizardGateResponse = {
  passed: boolean;
  report: string;
  forced?: boolean;
};

const DEFAULT_PROJECT_NAME_QUESTION: WizardAskQuestion = {
  id: PROJECT_NAME_QUESTION_ID,
  prompt: "What would you like to name this project?",
  label: "Project name",
  placeholder: "e.g. my-cooking-blog",
  type: "text",
  required: true,
};

const DEFAULT_VISUAL_TONE_QUESTION: WizardAskQuestion = {
  id: VISUAL_TONE_QUESTION_ID,
  prompt: "What visual tone should the site have?",
  label: "Visual tone",
  type: "choice",
  required: true,
  options: [
    {
      value: "minimal",
      label: "Minimal and text-forward",
      description: "Clean typography, generous whitespace, subtle color.",
    },
    {
      value: "bold",
      label: "Bold with imagery and gradients",
      description: "Strong visuals, gradients, and expressive layout.",
    },
  ],
};

const CORE_WIZARD_QUESTION_IDS = new Set<string>([
  PROJECT_NAME_QUESTION_ID,
  VISUAL_TONE_QUESTION_ID,
]);

let projectNameInjected = false;
let visualToneInjected = false;
let wizardAskCallCount = 0;

function ensureCoreWizardQuestions(questions: WizardAskQuestion[]): WizardAskQuestion[] {
  wizardAskCallCount++;
  const middle = questions.filter((q) => !CORE_WIZARD_QUESTION_IDS.has(q.id));
  let result = [...middle];

  if (!projectNameInjected) {
    result = [
      questions.find((q) => q.id === PROJECT_NAME_QUESTION_ID) ?? DEFAULT_PROJECT_NAME_QUESTION,
      ...result,
    ];
    projectNameInjected = true;
  }

  if (!visualToneInjected && (middle.length > 0 || wizardAskCallCount > 1)) {
    result.push(
      questions.find((q) => q.id === VISUAL_TONE_QUESTION_ID) ?? DEFAULT_VISUAL_TONE_QUESTION,
    );
    visualToneInjected = true;
  }

  return result;
}

// ── JSON Schema helpers (plain objects; no typebox runtime import) ────────────
//
// pi passes `parameters` straight to the LLM as the tool's JSON Schema — it does
// not Compile/Check custom tool parameters — so plain objects are sufficient.

type JsonSchema = Record<string, unknown>;

const str = (description: string): JsonSchema => ({ type: "string", description });
const strEnum = (values: string[], description: string): JsonSchema => ({
  type: "string",
  enum: values,
  description,
});
const bool = (description: string): JsonSchema => ({ type: "boolean", description });
const arr = (items: JsonSchema, description: string): JsonSchema => ({
  type: "array",
  items,
  description,
});
const obj = (
  properties: Record<string, JsonSchema>,
  required: string[],
  description: string,
): JsonSchema => ({
  type: "object",
  properties,
  required,
  description,
});

const OptionSchema: JsonSchema = obj(
  {
    value: str("Machine-readable value returned when selected"),
    label: str("Human-readable display label"),
    description: str("Optional clarifying sub-label shown under the option"),
  },
  ["value", "label"],
  "",
);

const QuestionSchema: JsonSchema = obj(
  {
    id: str(
      "Unique key for this question. Core ids `projectName` and `visualTone` are auto-injected.",
    ),
    prompt: str("The question text shown to the user (2nd person)."),
    type: strEnum(
      ["text", "choice"],
      "text: free-form input; choice: pick from options (single or multi).",
    ),
    label: str("Short step/tab label. Defaults to a derived label."),
    placeholder: str("Hint text for text questions."),
    options: arr(OptionSchema, "Required when type is 'choice'."),
    multiple: bool("Allow selecting multiple options (checkbox). Default false."),
    required: bool("Default true. When false the user may skip."),
    secret: bool("Render a password-style input. Use for API keys / secrets the user pastes."),
  },
  ["id", "prompt", "type"],
  "",
);

const WizardAskParams: JsonSchema = obj(
  {
    header: str("Optional overall title for the question batch."),
    questions: arr(
      QuestionSchema,
      `One or more template-specific questions. Herman auto-injects \`projectName\` first and \`visualTone\` last on the appropriate ask batch. Ask only what you still need given the project description and manifest you already have — do not re-ask answered questions.`,
    ),
  },
  ["questions"],
  "",
);

const WizardCompletePlanningParams: JsonSchema = obj(
  {
    projectPath: str("Absolute path to the cloned project directory (e.g. ~/Herman/my-blog)."),
    planPath: str("Absolute path to HERMAN_PLAN.md in the project root."),
    summary: str("Optional short summary of the plan / discovery findings."),
  },
  ["projectPath", "planPath"],
  "",
);

const WizardCompleteParams: JsonSchema = obj(
  {
    projectPath: str("Absolute path to the created project directory (e.g. ~/Herman/my-blog)."),
    summary: str("Short human-readable summary of what was done."),
  },
  ["projectPath"],
  "",
);

const RequestInstallParams: JsonSchema = obj(
  {
    toolId: str(
      "Tool identifier. Use a Herman registry id when one applies (docker, postgres, redis, python, node); otherwise a short lowercase slug.",
    ),
    label: str("Human-readable tool name shown to the user (e.g. 'PostgreSQL')."),
    reason: str(
      "One plain-language sentence telling a non-technical user why this tool is needed.",
    ),
    check: str(
      "Shell command that exits 0 when the tool is present (default: '<toolId> --version').",
    ),
    installCmd: str(
      "Suggested install command (e.g. 'brew install postgresql@16'). Herman runs it only after the user approves.",
    ),
  },
  ["toolId", "label", "reason"],
  "",
);

const ANSWER_CLARIFY_NUDGE = `
Next steps (in order):
1. If you have NOT cloned yet: clone into ~/Herman/<projectName> now (after you have projectName).
2. Once the repo exists: read README, AGENTS.md, and other useful markdown in the clone.
3. If you still need clarifying questions based on the answers + docs, call \`herman_wizard_ask\` with only those remaining questions.
4. If you are clear (cloned + docs reviewed): write the full plan to \`HERMAN_PLAN.md\` in the project root
   (checkbox task list), then call \`herman_complete_planning\` with { projectPath, planPath }.
Do not write the plan or call herman_complete_planning until the project is cloned.`;

const ASK_REJECTED_MESSAGE = `herman_wizard_ask is only allowed during the planning phase. Continue without user questions and call herman_complete_wizard when done.`;

// ── Extension ─────────────────────────────────────────────────────────────────

export default function hermanWizardExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "herman_wizard_ask",
    label: "Ask Wizard Questions",
    description: `Ask the user a batch of structured onboarding questions (text, choice, or multi-select) and receive the answers immediately, with no extra model round-trip. Use this ONLY during wizard planning to collect any details you still need that are not already answered by the user's project description or the manifest. Ask via herman_wizard_ask before cloning; the project name is collected on your first call. Do not use this tool during coding, QA, or docs phases.`,
    promptSnippet: "Ask the user wizard onboarding questions and get their answers",
    promptGuidelines: [
      `Use herman_wizard_ask only during wizard planning whenever you need information from the user that you don't already have from their project description or the template manifest.`,
      "Ask only what you still need. Do NOT re-ask things the description or manifest already answer.",
      `Prefer 'choice' questions with a small option set over free text when the answer is from a known set (e.g. payments now vs catalog first). Use 'multiple: true' for multi-select. Always provide an option set for choice questions.`,
      `Use 'secret: true' for API keys / credentials the user must paste. Never log or echo secret values in your response text.`,
      `You do NOT need to include \`projectName\` or \`visualTone\` — Herman injects projectName on your first call and appends visualTone last once template-specific questions are ready. projectName is also the public display name (blog title, store name, site title) — never ask a separate naming question from the manifest. Clone into ~/Herman/<projectName> after you have the name. Capture visualTone in the plan for later styling.`,
      `After receiving answers: clone if needed, then read repo docs. If you need more, call herman_wizard_ask again. When clear, write HERMAN_PLAN.md and call herman_complete_planning — do not install or customize in the planning phase.`,
    ],
    // biome-ignore lint/suspicious/noExplicitAny: tool schema types from the SDK don't align with the actual parameter format
    parameters: WizardAskParams as any,

    async execute(_toolCallId, _params, _signal, _onUpdate, ctx: ExtensionContext) {
      const params = _params as WizardAskParams;
      // The React wizard only exists in RPC mode (Herman's --mode rpc).
      // Guard so the tool degrades safely if ever run in a real TUI.
      if (ctx.mode !== "rpc" || !ctx.hasUI) {
        return {
          content: [
            {
              type: "text",
              text: "Wizard questions are only available in Herman's wizard mode. Proceed with sensible defaults and continue planning.",
            },
          ],
          details: { answers: [], cancelled: false } satisfies WizardAskAnswers,
        };
      }

      const rawQuestions = (params.questions ?? []) as unknown as WizardAskQuestion[];
      const questions = ensureCoreWizardQuestions(rawQuestions);

      // Validate choice questions have options.
      for (const q of questions) {
        if (q.type === "choice" && (!q.options || q.options.length === 0)) {
          return {
            content: [
              {
                type: "text",
                text: `Error: question "${q.id}" is type 'choice' but has no options.`,
              },
            ],
            details: { answers: [], cancelled: true } satisfies WizardAskAnswers,
          };
        }
      }

      const envelope: WizardAskEnvelope = {
        __herman_wizard__: true,
        version: WIZARD_PROTOCOL_VERSION,
        ...(params.header ? { header: params.header } : {}),
        questions,
      };

      // Round-trip via the editor dialog. In RPC mode pi emits an
      // extension_ui_request {method:"editor", prefill:<envelope>} and
      // blocks until Herman sends back extension_ui_response {value:<answers>}.
      const responseText = await ctx.ui.editor(
        params.header ?? "Project setup",
        JSON.stringify(envelope),
      );

      if (responseText === undefined || responseText === null) {
        return {
          content: [{ type: "text", text: "User cancelled the wizard." }],
          details: { answers: [], cancelled: true } satisfies WizardAskAnswers,
        };
      }

      let parsed: (WizardAskAnswers & { __herman_ask_rejected__?: boolean }) | undefined;
      try {
        const obj = JSON.parse(responseText) as unknown;
        if (obj && typeof obj === "object" && !Array.isArray(obj)) {
          const o = obj as Record<string, unknown>;
          parsed = {
            answers: Array.isArray(o.answers) ? (o.answers as WizardAnswer[]) : [],
            cancelled: o.cancelled === true,
            ...(o.__herman_ask_rejected__ === true ? { __herman_ask_rejected__: true } : {}),
          };
        }
      } catch {
        parsed = undefined;
      }

      if (!parsed) {
        return {
          content: [
            {
              type: "text",
              text: "Could not parse wizard answers. Please continue with sensible defaults.",
            },
          ],
          details: { answers: [], cancelled: false } satisfies WizardAskAnswers,
        };
      }

      if (parsed.__herman_ask_rejected__) {
        return {
          content: [{ type: "text", text: ASK_REJECTED_MESSAGE }],
          details: { answers: [], cancelled: false } satisfies WizardAskAnswers,
        };
      }

      if (parsed.cancelled) {
        return {
          content: [{ type: "text", text: "User cancelled the wizard." }],
          details: parsed,
        };
      }

      // Return a compact, LLM-readable summary of the answers + clone-aware nudge.
      const lines = parsed.answers.map((a) => {
        const q = questions.find((x) => x.id === a.id);
        const label = q?.label ?? q?.prompt ?? a.id;
        if (a.values && a.values.length > 1) return `${label} (${a.id}): ${a.values.join(", ")}`;
        return `${label} (${a.id}): ${a.value}`;
      });
      const answerBlock = lines.length > 0 ? lines.join("\n") : "(no answers)";
      const text = `Here are the user's answers:\n${answerBlock}${ANSWER_CLARIFY_NUDGE}`;

      return {
        content: [{ type: "text", text }],
        details: parsed,
      };
    },
  });

  pi.registerTool({
    name: "herman_complete_planning",
    label: "Complete Planning",
    description: `Signal that wizard planning is complete. Call this once after cloning the project and writing HERMAN_PLAN.md with a full checkbox task list. Do not install, migrate, or customize the project in the planning phase — that happens in a later session.`,
    promptSnippet: "Report that planning is finished and give the project + plan paths",
    promptGuidelines: [
      `Call herman_complete_planning exactly once as the LAST tool call of the planning phase, after HERMAN_PLAN.md is written.`,
      "projectPath must be the absolute path to the cloned project directory.",
      "planPath must be the absolute path to HERMAN_PLAN.md.",
    ],
    // biome-ignore lint/suspicious/noExplicitAny: tool schema types from the SDK don't align with the actual parameter format
    parameters: WizardCompletePlanningParams as any,

    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx: ExtensionContext) {
      const params = _params as WizardCompletePlanningParams;
      const projectPath = (params.projectPath ?? "").trim();
      const planPath = (params.planPath ?? "").trim();

      if (!projectPath || !existsSync(projectPath)) {
        return {
          content: [
            {
              type: "text",
              text: `Error: projectPath is missing or does not exist. Clone the project into ~/Herman/<projectName>, then call herman_complete_planning again.`,
            },
          ],
          details: { projectPath, planPath, ok: false },
        };
      }
      if (!planPath || !existsSync(planPath)) {
        return {
          content: [
            {
              type: "text",
              text: `Error: planPath is missing or HERMAN_PLAN.md was not found. Write the plan file with checkbox tasks, then call herman_complete_planning again.`,
            },
          ],
          details: { projectPath, planPath, ok: false },
        };
      }

      const summary = (params.summary ?? "").trim();
      const text = summary
        ? `Planning complete. Project: ${projectPath}\nPlan: ${planPath}\n${summary}`
        : `Planning complete. Project: ${projectPath}\nPlan: ${planPath}`;
      return {
        content: [{ type: "text", text }],
        details: {
          projectPath,
          planPath,
          summary: summary || undefined,
          ok: true,
        },
      };
    },
  });

  pi.registerTool({
    name: "herman_request_install",
    label: "Request Tool Install",
    description: `Ask Herman to install a missing system tool the project needs (e.g. a database, Docker, a language runtime). Herman shows the user an approval card and runs the install safely. Use this ONLY during coding/QA when a command fails because a tool is missing — never for tools the wizard setup already covers (git, bun, php, composer, node), and never during planning.`,
    promptSnippet: "Request installation of a missing system tool (with user approval)",
    promptGuidelines: [
      `Before calling herman_request_install, verify the tool is actually missing (run its check command and see it fail).`,
      "Prefer Herman registry ids (docker, postgres, redis, python, node) so Herman can use its curated installer; otherwise provide installCmd (prefer brew on macOS).",
      "Write 'reason' for a non-technical user: what the tool does for THEIR project, one sentence, no jargon.",
      "If the user declines or the install fails, continue with a workaround (e.g. sqlite instead of postgres) instead of blocking.",
    ],
    // biome-ignore lint/suspicious/noExplicitAny: tool schema types from the SDK don't align with the actual parameter format
    parameters: RequestInstallParams as any,

    async execute(_toolCallId, _params, _signal, _onUpdate, ctx: ExtensionContext) {
      const params = _params as {
        toolId: string;
        label: string;
        reason?: string;
        check?: string;
        installCmd?: string;
      };

      if (ctx.mode !== "rpc" || !ctx.hasUI) {
        return {
          content: [
            {
              type: "text",
              text: "Install requests are only available in Herman's wizard mode. Continue with a workaround.",
            },
          ],
          details: { approved: false, installed: false } satisfies WizardInstallResponse,
        };
      }

      const envelope: WizardInstallEnvelope = {
        __herman_install__: true,
        version: 1,
        toolId: params.toolId,
        label: params.label,
        ...(params.reason ? { reason: params.reason } : {}),
        ...(params.check ? { check: params.check } : {}),
        ...(params.installCmd ? { installCmd: params.installCmd } : {}),
      };

      const responseText = await ctx.ui.editor(
        `Install ${params.label}?`,
        JSON.stringify(envelope),
      );

      let parsed: WizardInstallResponse | undefined;
      try {
        const obj = responseText ? (JSON.parse(responseText) as unknown) : undefined;
        if (obj && typeof obj === "object" && !Array.isArray(obj)) {
          const o = obj as Record<string, unknown>;
          parsed = {
            approved: o.approved === true,
            installed: o.installed === true,
            ...(typeof o.detail === "string" ? { detail: o.detail } : {}),
          };
        }
      } catch {
        parsed = undefined;
      }

      if (!parsed) {
        return {
          content: [
            {
              type: "text",
              text: "The install request could not be completed (cancelled or unparsable response). Continue with a workaround.",
            },
          ],
          details: { approved: false, installed: false } satisfies WizardInstallResponse,
        };
      }

      if (parsed.installed) {
        return {
          content: [
            {
              type: "text",
              text: `${params.label} was installed successfully. You can now use it — retry the command that failed before.${parsed.detail ? ` (${parsed.detail})` : ""}`,
            },
          ],
          details: parsed,
        };
      }

      const why = parsed.approved
        ? `the install failed${parsed.detail ? `: ${parsed.detail}` : ""}`
        : "the user declined the install";
      return {
        content: [
          {
            type: "text",
            text: `${params.label} is NOT available — ${why}. Do not retry it; continue with a workaround that uses tools already installed.`,
          },
        ],
        details: parsed,
      };
    },
  });

  pi.registerTool({
    name: "herman_complete_design",
    label: "Complete Design",
    description: `Signal that the wizard design/spec phase is complete. Call this once after writing HERMAN_DESIGN.md and rewriting HERMAN_PLAN.md as a milestone plan with acceptance criteria.`,
    promptSnippet: "Report that design is finished and give the project, design, and plan paths",
    promptGuidelines: [
      "Call herman_complete_design exactly once as the LAST tool call of the design phase.",
      "designPath must be the absolute path to HERMAN_DESIGN.md.",
      "planPath must be the absolute path to HERMAN_PLAN.md (milestone-sectioned).",
    ],
    parameters: obj(
      {
        projectPath: str("Absolute path to the project directory."),
        designPath: str("Absolute path to HERMAN_DESIGN.md in the project root."),
        planPath: str("Absolute path to HERMAN_PLAN.md in the project root."),
        summary: str("Optional short summary of the design / plan."),
      },
      ["projectPath", "designPath", "planPath"],
      "",
      // biome-ignore lint/suspicious/noExplicitAny: tool schema types from the SDK don't align with the actual parameter format
    ) as any,

    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx: ExtensionContext) {
      const params = _params as WizardCompleteDesignParams;
      const projectPath = (params.projectPath ?? "").trim();
      const designPath = (params.designPath ?? "").trim();
      const planPath = (params.planPath ?? "").trim();

      if (!projectPath || !existsSync(projectPath)) {
        return {
          content: [
            {
              type: "text",
              text: "Error: projectPath is missing or does not exist. Fix the path, then call herman_complete_design again.",
            },
          ],
          details: { projectPath, designPath, planPath, ok: false },
        };
      }
      if (!designPath || !existsSync(designPath)) {
        return {
          content: [
            {
              type: "text",
              text: "Error: designPath is missing or HERMAN_DESIGN.md was not found. Write the design file, then call herman_complete_design again.",
            },
          ],
          details: { projectPath, designPath, planPath, ok: false },
        };
      }
      if (!planPath || !existsSync(planPath)) {
        return {
          content: [
            {
              type: "text",
              text: "Error: planPath is missing or HERMAN_PLAN.md was not found. Write the milestone plan, then call herman_complete_design again.",
            },
          ],
          details: { projectPath, designPath, planPath, ok: false },
        };
      }

      const summary = (params.summary ?? "").trim();
      const text = summary
        ? `Design complete. Project: ${projectPath}\nDesign: ${designPath}\nPlan: ${planPath}\n${summary}`
        : `Design complete. Project: ${projectPath}\nDesign: ${designPath}\nPlan: ${planPath}`;
      return {
        content: [{ type: "text", text }],
        details: {
          projectPath,
          designPath,
          planPath,
          summary: summary || undefined,
          ok: true,
        },
      };
    },
  });

  pi.registerTool({
    name: "herman_complete_wizard",
    label: "Complete Wizard Phase",
    description: `Signal that the current wizard coding, QA, or docs phase is complete. Call this once at the end of the phase after all work is done. Herman will verify the project (builds, boots, pages load) before accepting — if verification fails you will get a failure report and must fix the issues, then call this again. Do not call any other tools after a successful completion in the turn.`,
    promptSnippet: "Report that the current wizard phase is finished and give the project path",
    promptGuidelines: [
      "Call herman_complete_wizard exactly once as the LAST tool call of the coding, QA, or docs phase.",
      "projectPath must be the absolute path to the project directory.",
      "Include a short summary of what was done (coding) or verified/fixed (QA).",
      "Herman verifies the project before accepting. If you get a verification failure report, fix the issues and call herman_complete_wizard again — the phase is NOT done yet.",
    ],
    // biome-ignore lint/suspicious/noExplicitAny: tool schema types from the SDK don't align with the actual parameter format
    parameters: WizardCompleteParams as any,

    async execute(_toolCallId, _params, _signal, _onUpdate, ctx: ExtensionContext) {
      const params = _params as WizardCompleteParams;
      const projectPath = (params.projectPath ?? "").trim();
      const summary = (params.summary ?? "").trim();

      // Host-enforced gate via the editor round-trip (no HTTP timeout).
      // Host answers immediately with passed:true for docs / non-gated phases.
      if (ctx.mode === "rpc" && ctx.hasUI) {
        const envelope: WizardGateEnvelope = {
          __herman_gate__: true,
          version: 1,
          phase: "unknown",
          projectPath,
          ...(summary ? { summary } : {}),
        };
        const responseText = await ctx.ui.editor(
          "Verifying your project…",
          JSON.stringify(envelope),
        );

        let gate: WizardGateResponse | undefined;
        try {
          const obj = responseText ? (JSON.parse(responseText) as unknown) : undefined;
          if (obj && typeof obj === "object" && !Array.isArray(obj)) {
            const o = obj as Record<string, unknown>;
            if (typeof o.passed === "boolean") {
              gate = {
                passed: o.passed,
                report: typeof o.report === "string" ? o.report : "",
                ...(o.forced === true ? { forced: true } : {}),
              };
            }
          }
        } catch {
          gate = undefined;
        }

        if (gate && !gate.passed) {
          return {
            content: [
              {
                type: "text",
                text: `Verification FAILED — the phase is NOT complete. Fix the issues below, then call herman_complete_wizard again.\n\n${gate.report}`,
              },
            ],
            details: {
              projectPath,
              summary: summary || undefined,
              gatePassed: false,
              gateReport: gate.report,
            },
          };
        }
      }

      const text = summary
        ? `Wizard phase complete. Project ready at: ${projectPath}\n${summary}`
        : `Wizard phase complete. Project ready at: ${projectPath}`;
      return {
        content: [{ type: "text", text }],
        details: {
          projectPath,
          summary: summary || undefined,
          gatePassed: true,
        },
      };
    },
  });
}
