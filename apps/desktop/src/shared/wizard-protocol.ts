/**
 * Wire protocol for the agent-driven wizard.
 *
 * Shared by:
 *  - the pi extension (`bun/wizard-extension/index.ts`) which PRODUCES
 *    `WizardAskEnvelope` and CONSUMES `WizardAskAnswers`,
 *  - the bun bridge which intercepts the `editor` extension_ui_request carrying
 *    the envelope and routes it to React,
 *  - the React wizard which renders the envelope and returns answers.
 *
 * The on-the-wire format is JSON carried as the `prefill`/`value` string of a
 * pi `ctx.ui.editor()` dialog round-trip (see docs/rpc.md). The sentinel
 * `__herman_wizard__` lets the bridge distinguish a wizard question batch from
 * a real editor request.
 *
 * NOTE: the extension keeps its own inline copy of these shapes (it cannot
 * import from herman src at runtime). Keep them in sync.
 */

export const WIZARD_SENTINEL = "__herman_wizard__" as const;
export const WIZARD_PROTOCOL_VERSION = 1;

export type WizardOption = {
  value: string;
  label: string;
  description?: string;
};

export type WizardAskQuestion = {
  id: string;
  prompt: string;
  type: "text" | "choice";
  /** Short tab/step label. Defaults to a derived label. */
  label?: string;
  /** Hint text for text questions. */
  placeholder?: string;
  /** Required when type is "choice". */
  options?: WizardOption[];
  /** Multi-select (checkbox) for choice questions. Default false. */
  multiple?: boolean;
  /** Default true. When false the user may skip. */
  required?: boolean;
  /** Render a password-style input (for API keys / secrets). */
  secret?: boolean;
};

export type WizardAskEnvelope = {
  __herman_wizard__: true;
  version: 1;
  header?: string;
  questions: WizardAskQuestion[];
};

export type WizardAnswer = {
  id: string;
  /** Primary value. For multi-select this is the first selected value. */
  value: string;
  /** All selected values for multi-select. */
  values?: string[];
};

export type WizardAskAnswers = {
  answers: WizardAnswer[];
  cancelled: boolean;
};

/** The id the extension auto-injects for project name. */
export const PROJECT_NAME_QUESTION_ID = "projectName";

/** The id the extension auto-injects for visual tone. */
export const VISUAL_TONE_QUESTION_ID = "visualTone";

/** The default projectName question injected when the agent omits it. */
export const DEFAULT_PROJECT_NAME_QUESTION: WizardAskQuestion = {
  id: PROJECT_NAME_QUESTION_ID,
  prompt: "What would you like to name this project?",
  label: "Project name",
  placeholder: "e.g. my-cooking-blog",
  type: "text",
  required: true,
};

/** The default visualTone question injected when the agent omits it. */
export const DEFAULT_VISUAL_TONE_QUESTION: WizardAskQuestion = {
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

const CORE_WIZARD_QUESTION_IDS = new Set<string>([PROJECT_NAME_QUESTION_ID, VISUAL_TONE_QUESTION_ID]);

/** Order a wizard batch: projectName first, template-specific questions in the middle, visualTone last. */
export function orderWizardQuestionBatch(
  questions: WizardAskQuestion[],
  options: { includeProjectName?: boolean; includeVisualTone?: boolean } = {},
): WizardAskQuestion[] {
  const includeProjectName = options.includeProjectName ?? true;
  const includeVisualTone = options.includeVisualTone ?? false;
  const middle = questions.filter((q) => !CORE_WIZARD_QUESTION_IDS.has(q.id));

  const result: WizardAskQuestion[] = [];
  if (includeProjectName) {
    result.push(
      questions.find((q) => q.id === PROJECT_NAME_QUESTION_ID) ?? DEFAULT_PROJECT_NAME_QUESTION,
    );
  }
  result.push(...middle);
  if (includeVisualTone) {
    result.push(
      questions.find((q) => q.id === VISUAL_TONE_QUESTION_ID) ?? DEFAULT_VISUAL_TONE_QUESTION,
    );
  }
  return result;
}

/** Ensure Herman's core wizard questions wrap a batch (projectName first, visualTone last). */
export function ensureCoreWizardQuestions(questions: WizardAskQuestion[]): WizardAskQuestion[] {
  return orderWizardQuestionBatch(questions, {
    includeProjectName: true,
    includeVisualTone: questions.some((q) => !CORE_WIZARD_QUESTION_IDS.has(q.id)),
  });
}

/** @deprecated Use orderWizardQuestionBatch / ensureCoreWizardQuestions */
export function ensureProjectNameFirst(questions: WizardAskQuestion[]): WizardAskQuestion[] {
  return orderWizardQuestionBatch(questions, { includeProjectName: true, includeVisualTone: false });
}

export function encodeWizardEnvelope(envelope: WizardAskEnvelope): string {
  return JSON.stringify(envelope);
}

/** Detect + parse a wizard envelope from an `editor` request's prefill. */
export function tryParseWizardEnvelope(prefill: string | undefined): WizardAskEnvelope | undefined {
  if (!prefill) return undefined;
  const trimmed = prefill.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const obj = parsed as Record<string, unknown>;
    if (obj.__herman_wizard__ !== true) return undefined;
    if (obj.version !== WIZARD_PROTOCOL_VERSION) return undefined;
    if (!Array.isArray(obj.questions)) return undefined;
    return obj as unknown as WizardAskEnvelope;
  } catch {
    return undefined;
  }
}

/** Encode answers as the `value` string for `extension_ui_response`. */
export function encodeWizardAnswers(answers: WizardAskAnswers): string {
  return JSON.stringify(answers);
}

/** Decode answers returned from the UI. */
export function parseWizardAnswers(value: string | undefined): WizardAskAnswers | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const obj = parsed as Record<string, unknown>;
    return {
      answers: Array.isArray(obj.answers) ? (obj.answers as WizardAnswer[]) : [],
      cancelled: obj.cancelled === true,
    };
  } catch {
    return undefined;
  }
}
