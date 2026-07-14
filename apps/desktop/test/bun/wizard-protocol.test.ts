import { describe, expect, it } from "vitest";

import {
  WIZARD_SENTINEL,
  PROJECT_NAME_QUESTION_ID,
  VISUAL_TONE_QUESTION_ID,
  DEFAULT_PROJECT_NAME_QUESTION,
  DEFAULT_VISUAL_TONE_QUESTION,
  encodeWizardEnvelope,
  tryParseWizardEnvelope,
  encodeWizardAnswers,
  parseWizardAnswers,
  ensureCoreWizardQuestions,
  ensureProjectNameFirst,
  type WizardAskEnvelope,
} from "../../src/shared/wizard-protocol.js";
import { tryParseWizardRequest } from "../../src/shared/agent-protocol.js";

describe("wizard-protocol", () => {
  it("round-trips an envelope through encode/parse", () => {
    const envelope: WizardAskEnvelope = {
      __herman_wizard__: true,
      version: 1,
      header: "Setup",
      questions: [
        { id: "projectName", prompt: "Name?", type: "text" },
        { id: "env", prompt: "Which env?", type: "choice", options: [{ value: "dev", label: "Dev" }] },
      ],
    };
    const encoded = encodeWizardEnvelope(envelope);
    const parsed = tryParseWizardEnvelope(encoded);
    expect(parsed).toEqual(envelope);
  });

  it("rejects non-wizard prefill (real editor requests)", () => {
    expect(tryParseWizardEnvelope(undefined)).toBeUndefined();
    expect(tryParseWizardEnvelope("just some text")).toBeUndefined();
    expect(tryParseWizardEnvelope(JSON.stringify({ foo: 1 }))).toBeUndefined();
    expect(tryParseWizardEnvelope(JSON.stringify({ __herman_wizard__: false, version: 1, questions: [] }))).toBeUndefined();
    expect(tryParseWizardEnvelope(JSON.stringify({ __herman_wizard__: true, version: 99, questions: [] }))).toBeUndefined();
  });

  it("round-trips answers", () => {
    const encoded = encodeWizardAnswers({
      answers: [
        { id: "projectName", value: "my-blog" },
        { id: "tags", value: "a", values: ["a", "b"] },
      ],
      cancelled: false,
    });
    const parsed = parseWizardAnswers(encoded);
    expect(parsed?.cancelled).toBe(false);
    expect(parsed?.answers).toHaveLength(2);
    expect(parsed?.answers[1]?.values).toEqual(["a", "b"]);
  });

  it("parses cancelled answers", () => {
    const parsed = parseWizardAnswers(encodeWizardAnswers({ answers: [], cancelled: true }));
    expect(parsed?.cancelled).toBe(true);
  });

  it("ensures core wizard questions wrap a batch with visualTone last", () => {
    const qs = ensureCoreWizardQuestions([{ id: "x", prompt: "X?", type: "text" }]);
    expect(qs[0]?.id).toBe(PROJECT_NAME_QUESTION_ID);
    expect(qs[1]?.id).toBe("x");
    expect(qs[2]?.id).toBe(VISUAL_TONE_QUESTION_ID);
    expect(qs).toHaveLength(3);
  });

  it("does not double-add core questions when present", () => {
    const qs = ensureCoreWizardQuestions([
      { id: "projectName", prompt: "Custom name?", type: "text" },
      { id: "visualTone", prompt: "Custom tone?", type: "choice", options: [{ value: "a", label: "A" }] },
      { id: "x", prompt: "X?", type: "text" },
    ]);
    expect(qs).toHaveLength(3);
    expect(qs[0]?.id).toBe("projectName");
    expect(qs[1]?.id).toBe("x");
    expect(qs[2]?.id).toBe("visualTone");
    expect(qs[2]?.prompt).toBe("Custom tone?");
  });

  it("ensureProjectNameFirst only prepends projectName", () => {
    const qs = ensureProjectNameFirst([{ id: "x", prompt: "X?", type: "text" }]);
    expect(qs[0]?.id).toBe(PROJECT_NAME_QUESTION_ID);
    expect(qs[1]?.id).toBe("x");
    expect(qs).toHaveLength(2);
  });
});

describe("tryParseWizardRequest", () => {
  it("extracts a wizard envelope from an editor extension_ui_request", () => {
    const envelope: WizardAskEnvelope = {
      __herman_wizard__: true,
      version: 1,
      questions: [{ id: "projectName", prompt: "Name?", type: "text" }],
    };
    const event = {
      type: "extension_ui_request" as const,
      id: "req-1",
      method: "editor",
      prefill: encodeWizardEnvelope(envelope),
    };
    const parsed = tryParseWizardRequest(event);
    expect(parsed?.requestId).toBe("req-1");
    expect(parsed?.envelope.questions[0]?.id).toBe("projectName");
  });

  it("returns undefined for a real editor request (no sentinel)", () => {
    expect(
      tryParseWizardRequest({
        type: "extension_ui_request",
        id: "req-2",
        method: "editor",
        prefill: "edit this prose please",
      }),
    ).toBeUndefined();
  });

  it("returns undefined for non-editor extension_ui_request methods", () => {
    expect(
      tryParseWizardRequest({
        type: "extension_ui_request",
        id: "req-3",
        method: "select",
        options: ["a", "b"],
      }),
    ).toBeUndefined();
  });

  it("sentinel constant is stable on the wire", () => {
    expect(WIZARD_SENTINEL).toBe("__herman_wizard__");
  });
});
