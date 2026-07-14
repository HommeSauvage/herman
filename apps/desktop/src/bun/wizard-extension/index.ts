/**
 * Herman wizard extension (loaded by the pi agent subprocess in wizard mode).
 *
 * Registers two tools:
 *
 *  - `herman_wizard_ask` — ask the user a batch of structured questions
 *    (text / choice / multi-select / secret) and get the answers back, with no
 *    extra model round-trip. Carried over pi's `ctx.ui.editor()` RPC dialog
 *    sub-protocol: the envelope JSON is the editor `prefill`; Herman's bridge
 *    detects the sentinel and routes it to the React wizard, which returns the
 *    answers as the editor `value`. See `docs/rpc.md`.
 *
 *  - `herman_complete_wizard` — signal that project setup is finished and
 *    report the final project path. Informational; the host captures the args
 *    from the tool-execution event stream.
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
 *
 * The wire shapes MUST match `apps/desktop/src/shared/wizard-protocol.ts`;
 * keep them in sync.
 */

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

type WizardAskParams = { header?: string; questions: WizardAskQuestion[] };
type WizardCompleteParams = { projectPath: string; summary?: string };

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

const CORE_WIZARD_QUESTION_IDS = new Set<string>([PROJECT_NAME_QUESTION_ID, VISUAL_TONE_QUESTION_ID]);

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
const obj = (properties: Record<string, JsonSchema>, required: string[], description: string): JsonSchema => ({
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
		id: str("Unique key for this question. Core ids `projectName` and `visualTone` are auto-injected."),
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
			"One or more template-specific questions. Herman auto-injects `projectName` first and " +
				"`visualTone` last on the appropriate ask batch. Ask only what you still need given the project " +
				"description and manifest you already have — do not re-ask answered questions.",
		),
	},
	["questions"],
	"",
);

const WizardCompleteParams: JsonSchema = obj(
	{
		projectPath: str("Absolute path to the created project directory (e.g. ~/Herman/my-blog)."),
		summary: str("Short human-readable summary of what was set up."),
	},
	["projectPath"],
	"",
);

// ── Extension ─────────────────────────────────────────────────────────────────

export default function hermanWizardExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "herman_wizard_ask",
		label: "Ask Wizard Questions",
		description:
			"Ask the user a batch of structured onboarding questions (text, choice, or " +
			"multi-select) and receive the answers immediately, with no extra model " +
			"round-trip. Use this during project wizard setup to collect any details you " +
			"still need that are not already answered by the user's project description or " +
			"the manifest. Ask via herman_wizard_ask before cloning; the project name is collected on your first call.",
		promptSnippet: "Ask the user wizard onboarding questions and get their answers",
		promptGuidelines: [
			"Use herman_wizard_ask during wizard setup whenever you need information from the " +
				"user that you don't already have from their project description or the template manifest.",
			"Ask only what you still need. Do NOT re-ask things the description or manifest already answer.",
			"Prefer 'choice' questions with a small option set over free text when the answer is " +
				"from a known set (e.g. payments now vs catalog first). Use 'multiple: true' for " +
				"multi-select. Always provide an option set for choice questions.",
			"Use 'secret: true' for API keys / credentials the user must paste. Never log or echo " +
				"secret values in your response text.",
			"You do NOT need to include `projectName` or `visualTone` — Herman injects projectName " +
				"on your first call and appends visualTone last once template-specific questions are ready. " +
				"projectName is also the public display name (blog title, store name, site title) — never ask " +
				"a separate naming question from the manifest. Clone into ~/Herman/<projectName> after you have " +
				"the name, then apply it in app/title strings, package.json name, etc. Apply the visualTone " +
				"answer to typography, color, imagery, and layout.",
			"After receiving answers, decide whether you have enough to proceed. If you need more, " +
				"call herman_wizard_ask again with only the remaining questions. When you have " +
				"everything, proceed with setup and call herman_complete_wizard at the end.",
		],
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
							text: "Wizard questions are only available in Herman's wizard mode. Proceed with sensible defaults and continue setup.",
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

			let parsed: WizardAskAnswers | undefined;
			try {
				const obj = JSON.parse(responseText) as unknown;
				if (obj && typeof obj === "object" && !Array.isArray(obj)) {
					const o = obj as Record<string, unknown>;
					parsed = {
						answers: Array.isArray(o.answers) ? (o.answers as WizardAnswer[]) : [],
						cancelled: o.cancelled === true,
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

			if (parsed.cancelled) {
				return {
					content: [{ type: "text", text: "User cancelled the wizard." }],
					details: parsed,
				};
			}

			// Return a compact, LLM-readable summary of the answers.
			const lines = parsed.answers.map((a) => {
				const q = questions.find((x) => x.id === a.id);
				const label = q?.label ?? q?.prompt ?? a.id;
				if (a.values && a.values.length > 1) return `${label} (${a.id}): ${a.values.join(", ")}`;
				return `${label} (${a.id}): ${a.value}`;
			});
			const text = lines.length > 0 ? lines.join("\n") : "(no answers)";

			return {
				content: [{ type: "text", text }],
				details: parsed,
			};
		},
	});

	pi.registerTool({
		name: "herman_complete_wizard",
		label: "Complete Wizard",
		description:
			"Signal that wizard project setup is complete. Call this once, at the very end, " +
			"after cloning, installing dependencies, running migrations, writing env files, and " +
			"applying the project name. Reports the final project directory path so Herman can " +
			"open it. Do not call any other tools after this in the wizard turn.",
		promptSnippet: "Report that the wizard setup is finished and give the project path",
		promptGuidelines: [
			"Call herman_complete_wizard exactly once, as the LAST tool call of the wizard, " +
				"after all setup work (clone, install, migrate, env, naming) is done.",
			"projectPath must be the absolute path to the created project directory.",
		],
		parameters: WizardCompleteParams as any,

		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx: ExtensionContext) {
			const params = _params as WizardCompleteParams;
			const summary = (params.summary ?? "").trim();
			const text = summary
				? `Wizard complete. Project ready at: ${params.projectPath}\n${summary}`
				: `Wizard complete. Project ready at: ${params.projectPath}`;
			return {
				content: [{ type: "text", text }],
				details: {
					projectPath: params.projectPath,
					summary: summary || undefined,
				},
			};
		},
	});
}
