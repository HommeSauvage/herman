import { ArrowRight, Check } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";

import type {
  WizardAskEnvelope,
  WizardAskQuestion,
  WizardOption,
} from "../../../shared/wizard-protocol.js";
import { ContentWidth, SignalButton } from "./ui/index.js";

/**
 * Render a `WizardAskEnvelope` (a batch of questions produced by the agent's
 * herman_wizard_ask tool) as a one-question-at-a-time wizard with a progress
 * bar. On submit, calls `onSubmit` with the answers array. On cancel, calls
 * `onCancel`.
 */
export function WizardQuestions({
  envelope,
  onSubmit,
  onCancel,
}: {
  envelope: WizardAskEnvelope;
  onSubmit: (answers: { id: string; value: string; values?: string[] }[]) => void;
  onCancel: () => void;
}) {
  const questions = envelope.questions;
  const [index, setIndex] = useState(0);
  // Per-question draft answers, keyed by question id.
  const [drafts, setDrafts] = useState<Record<string, string | string[]>>({});
  const [submitting, setSubmitting] = useState(false);
  const total = questions.length;

  const current = questions[index];

  function setDraft(id: string, value: string | string[]) {
    setDrafts((prev) => ({ ...prev, [id]: value }));
  }

  function answerFor(q: WizardAskQuestion): string | string[] | undefined {
    const d = drafts[q.id];
    if (d !== undefined) return d;
    if (q.type === "choice" && q.multiple) return [];
    return "";
  }

  function isAnswered(q: WizardAskQuestion): boolean {
    const a = answerFor(q);
    if (Array.isArray(a)) return a.length > 0;
    if (q.required === false) return true;
    return typeof a === "string" && a.trim().length > 0;
  }

  function _allAnswered(): boolean {
    return questions.every(isAnswered);
  }

  function handleNext() {
    if (!current) return;
    if (index < total - 1) {
      setIndex((i) => i + 1);
      return;
    }
    // Submit.
    setSubmitting(true);
    const answers = questions.map((q) => {
      const a = answerFor(q);
      if (Array.isArray(a)) {
        return { id: q.id, value: a[0] ?? "", values: a };
      }
      return { id: q.id, value: (a ?? "").trim() };
    });
    onSubmit(answers);
  }

  const canAdvance = current ? isAnswered(current) : false;
  const isLast = index === total - 1;
  const answeredCount = questions.filter(isAnswered).length;

  return (
    <ContentWidth size="form" className="flex flex-col">
      {/* Progress bar */}
      <div className="mb-5">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-dim text-xs">
            Step {index + 1} of {total}
          </span>
          <span className="text-ghost text-xs">
            {answeredCount}/{total} answered
          </span>
        </div>
        <div className="bg-white/[0.06] h-1 overflow-hidden rounded-full">
          <motion.div
            className="bg-signal h-full rounded-full"
            initial={false}
            animate={{ width: `${((index + 1) / total) * 100}%` }}
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
          />
        </div>
      </div>

      <AnimatePresence mode="wait">
        {current && (
          <QuestionInput
            key={current.id}
            question={current}
            value={answerFor(current)}
            onChange={(v) => setDraft(current.id, v)}
            onNext={handleNext}
            canAdvance={canAdvance}
            isLast={isLast}
          />
        )}
      </AnimatePresence>

      <div className="mt-5 flex items-center justify-between">
        <button
          type="button"
          onClick={onCancel}
          className="text-ghost hover:text-dim text-xs transition"
        >
          Cancel
        </button>
        <div className="flex gap-2">
          {index > 0 && (
            <button
              type="button"
              onClick={() => setIndex((i) => Math.max(0, i - 1))}
              className="text-dim hover:text-text rounded-xl border border-white/[0.08] px-4 py-2 text-sm transition"
            >
              Back
            </button>
          )}
          <SignalButton size="sm" disabled={!canAdvance || submitting} onClick={handleNext}>
            {isLast ? (submitting ? "Submitting…" : "Submit") : "Next"}
            <ArrowRight size={14} />
          </SignalButton>
        </div>
      </div>
    </ContentWidth>
  );
}

function QuestionInput({
  question,
  value,
  onChange,
  onNext,
  canAdvance,
  isLast,
}: {
  question: WizardAskQuestion;
  value: string | string[] | undefined;
  onChange: (value: string | string[]) => void;
  onNext: () => void;
  canAdvance: boolean;
  isLast: boolean;
}) {
  if (question.type === "choice") {
    return (
      <ChoiceQuestion
        question={question}
        value={Array.isArray(value) ? value : value ? [value] : []}
        onChange={onChange}
        onNext={onNext}
        canAdvance={canAdvance}
        isLast={isLast}
      />
    );
  }
  return (
    <TextQuestion
      question={question}
      value={typeof value === "string" ? value : ""}
      onChange={onChange}
      onNext={onNext}
      canAdvance={canAdvance}
      isLast={isLast}
    />
  );
}

function TextQuestion({
  question,
  value,
  onChange,
  onNext,
  canAdvance,
  isLast,
}: {
  question: WizardAskQuestion;
  value: string;
  onChange: (value: string) => void;
  onNext: () => void;
  canAdvance: boolean;
  isLast: boolean;
}) {
  const inputRef = useRef<HTMLTextAreaElement | HTMLInputElement>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      if (question.secret) {
        (inputRef.current as HTMLInputElement | null)?.focus();
      } else {
        (inputRef.current as HTMLTextAreaElement | null)?.focus();
      }
    }, 150);
    return () => clearTimeout(t);
  }, [question.id, question.secret]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && canAdvance) {
      e.preventDefault();
      onNext();
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, x: 24 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -24 }}
      transition={{ type: "spring", stiffness: 400, damping: 30 }}
      className="w-full"
    >
      <label htmlFor={question.id} className="text-text mb-3 block text-sm font-medium">
        {question.prompt}
      </label>
      {question.secret ? (
        <input
          id={question.id}
          ref={inputRef as React.RefObject<HTMLInputElement>}
          type="password"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={question.placeholder ?? "Paste the value here"}
          className="text-text placeholder:text-ghost bg-void w-full rounded-xl border border-white/[0.08] px-4 py-3 text-sm transition focus:border-signal/40 focus:outline-none focus:ring-1 focus:ring-signal/20"
        />
      ) : (
        <textarea
          ref={inputRef as React.RefObject<HTMLTextAreaElement>}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={question.placeholder}
          rows={3}
          className="text-text placeholder:text-ghost bg-void w-full resize-none rounded-xl border border-white/[0.08] px-4 py-3 text-sm transition focus:border-signal/40 focus:outline-none focus:ring-1 focus:ring-signal/20"
        />
      )}
      {question.required === false && (
        <p className="text-ghost mt-2 text-[11px]">Optional — you can skip this.</p>
      )}
      {isLast && null}
    </motion.div>
  );
}

function ChoiceQuestion({
  question,
  value,
  onChange,
  onNext,
  isLast,
}: {
  question: WizardAskQuestion;
  value: string[];
  onChange: (value: string | string[]) => void;
  onNext: () => void;
  canAdvance: boolean;
  isLast: boolean;
}) {
  const options: WizardOption[] = question.options ?? [];
  const multiple = question.multiple ?? false;

  function toggle(opt: WizardOption) {
    if (multiple) {
      const set = new Set(value);
      if (set.has(opt.value)) set.delete(opt.value);
      else set.add(opt.value);
      onChange([...set]);
    } else {
      onChange(opt.value);
      // Auto-advance on single-select.
      if (!isLast) setTimeout(onNext, 120);
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, x: 24 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -24 }}
      transition={{ type: "spring", stiffness: 400, damping: 30 }}
      className="w-full"
    >
      <label htmlFor={question.id} className="text-text mb-3 block text-sm font-medium">
        {question.prompt}
      </label>
      <div className="space-y-2">
        {options.map((opt) => {
          const selected = multiple ? value.includes(opt.value) : value[0] === opt.value;
          return (
            <button
              type="button"
              key={opt.value}
              onClick={() => toggle(opt)}
              className={`flex w-full items-start gap-3 rounded-xl border px-4 py-3 text-left transition ${
                selected
                  ? "border-signal/40 bg-signal/5 ring-1 ring-signal/20"
                  : "border-white/[0.06] bg-white/[0.02] hover:border-white/[0.14] hover:bg-white/[0.04]"
              }`}
            >
              <div
                className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition ${
                  selected
                    ? "border-signal bg-signal text-primary-foreground"
                    : "border-white/[0.14] text-transparent"
                }`}
              >
                {multiple
                  ? selected && <Check size={13} strokeWidth={3} />
                  : selected && <div className="bg-primary-foreground h-2 w-2 rounded-full" />}
              </div>
              <div className="min-w-0">
                <div className={`text-sm ${selected ? "text-text" : "text-dim"}`}>{opt.label}</div>
                {opt.description && (
                  <div className="text-ghost mt-0.5 text-[11px] leading-snug">
                    {opt.description}
                  </div>
                )}
              </div>
            </button>
          );
        })}
      </div>
      {question.required === false && (
        <p className="text-ghost mt-2 text-[11px]">Optional — you can skip this.</p>
      )}
      {isLast && null}
    </motion.div>
  );
}
