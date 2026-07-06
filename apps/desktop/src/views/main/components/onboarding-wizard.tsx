import { motion, AnimatePresence } from "motion/react";
import { ArrowRight, ArrowLeft, Check, Sparkles, Loader2, Store, Rocket, Palette, FileText } from "lucide-react";
import { useCallback, useEffect, useState, useRef } from "react";

import type { TemplateManifest, Question, StyleOption } from "../../../shared/templates.js";
import { desktopRpc } from "../lib/desktop-rpc.js";
import { useAgentStore } from "../lib/agent-store.js";

type Step = "templates" | "questions" | "style" | "plan" | "building";

type OnboardingAnswers = {
  templateId: string;
  answers: Record<string, string>;
  style: string;
};

const STEP_TITLES: Record<Step, { title: string; subtitle: string }> = {
  templates: {
    title: "What do you want to build?",
    subtitle: "Pick a starting point and we'll handle the rest.",
  },
  questions: {
    title: "Tell us more",
    subtitle: "The more you share, the better the result.",
  },
  style: {
    title: "Pick a vibe",
    subtitle: "What style feels right for your project?",
  },
  plan: {
    title: "Here's the plan",
    subtitle: "We've put together a blueprint for your project.",
  },
  building: {
    title: "Building your project",
    subtitle: "This will just take a moment…",
  },
};

function StepIndicator({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center justify-center gap-1.5">
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          className={`h-1 rounded-full transition-all duration-500 ${
            i <= current
              ? "bg-signal w-6"
              : "bg-white/[0.08] w-2"
          }`}
        />
      ))}
    </div>
  );
}

function StepHeader({ step, stepIndex, totalSteps }: { step: Step; stepIndex: number; totalSteps: number }) {
  const { title, subtitle } = STEP_TITLES[step];
  return (
    <div className="text-center">
      <motion.h1
        key={`title-${step}`}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="text-text text-2xl font-semibold tracking-tight"
      >
        {title}
      </motion.h1>
      <motion.p
        key={`subtitle-${step}`}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.05 }}
        className="text-dim mt-1.5 text-sm"
      >
        {subtitle}
      </motion.p>
      <div className="mt-4">
        <StepIndicator current={stepIndex} total={totalSteps} />
      </div>
    </div>
  );
}

type TemplateCardProps = {
  template: TemplateManifest;
  selected: boolean;
  onSelect: () => void;
};

const ICON_MAP: Record<string, React.ElementType> = {
  "🏪": Store,
  "🚀": Rocket,
  "📝": FileText,
  "🎨": Palette,
};

function TemplateCard({ template, selected, onSelect }: TemplateCardProps) {
  const IconComp = ICON_MAP[template.icon] ?? Sparkles;

  return (
    <motion.button
      whileTap={{ scale: 0.97 }}
      onClick={onSelect}
      className={`flex flex-col items-center gap-3 rounded-2xl border p-5 text-center transition-all ${
        selected
          ? "border-signal/40 bg-signal/5 ring-1 ring-signal/20 shadow-[0_0_24px_rgba(34,197,94,0.08)]"
          : "border-white/[0.06] bg-white/[0.02] hover:border-white/[0.14] hover:bg-white/[0.04]"
      }`}
    >
      <div
        className={`flex h-14 w-14 items-center justify-center rounded-xl transition-colors ${
          selected ? "bg-signal/10 text-signal" : "bg-white/[0.04] text-dim"
        }`}
      >
        <IconComp size={26} strokeWidth={1.5} />
      </div>
      <div>
        <div className={`text-sm font-semibold ${selected ? "text-text" : "text-dim"}`}>
          {template.title}
        </div>
        <div className="text-ghost mt-0.5 text-[11px] leading-snug">
          {template.description}
        </div>
      </div>
    </motion.button>
  );
}

type QuestionCardProps = {
  question: Question;
  value: string;
  onChange: (value: string) => void;
  onNext: () => void;
  isLast: boolean;
};

function QuestionCard({ question, value, onChange, onNext, isLast }: QuestionCardProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    // Auto-focus the input when the question appears
    const timer = setTimeout(() => inputRef.current?.focus(), 200);
    return () => clearTimeout(timer);
  }, [question.id]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey && value.trim()) {
      e.preventDefault();
      onNext();
    }
  };

  return (
    <motion.div
      key={question.id}
      initial={{ opacity: 0, x: 24 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -24 }}
      transition={{ type: "spring", stiffness: 400, damping: 30 }}
      className="w-full"
    >
      <label className="text-text mb-3 block text-sm font-medium">
        {question.question}
      </label>
      <textarea
        ref={inputRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={question.placeholder}
        rows={3}
        className="text-text placeholder:text-ghost bg-void w-full resize-none rounded-xl border border-white/[0.08] px-4 py-3 text-sm focus:border-signal/40 focus:outline-none focus:ring-1 focus:ring-signal/20 transition"
      />
      {question.hint && (
        <p className="text-ghost mt-1.5 text-[11px]">{question.hint}</p>
      )}
      <button
        onClick={onNext}
        disabled={!value.trim()}
        className="bg-signal hover:bg-signal-dim mt-4 flex w-full items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold text-primary-foreground transition active:scale-[0.97] disabled:opacity-40"
      >
        {isLast ? "Continue" : "Next"}
        <ArrowRight size={14} />
      </button>
    </motion.div>
  );
}

type StylePickerProps = {
  options: StyleOption[];
  selected: string;
  onSelect: (id: string) => void;
};

function StylePicker({ options, selected, onSelect }: StylePickerProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      className="grid grid-cols-2 gap-3"
    >
      {options.map((opt) => (
        <motion.button
          key={opt.id}
          whileTap={{ scale: 0.97 }}
          onClick={() => onSelect(opt.id)}
          className={`flex flex-col items-center gap-2 rounded-2xl border p-4 text-center transition-all ${
            selected === opt.id
              ? "border-signal/40 bg-signal/5 ring-1 ring-signal/20"
              : "border-white/[0.06] bg-white/[0.02] hover:border-white/[0.14] hover:bg-white/[0.04]"
          }`}
        >
          <span className="text-2xl">{opt.icon}</span>
          <span className={`text-sm font-medium ${selected === opt.id ? "text-text" : "text-dim"}`}>
            {opt.title}
          </span>
          <span className="text-ghost text-[10px] leading-snug">{opt.description}</span>
        </motion.button>
      ))}
    </motion.div>
  );
}

type PlanViewProps = {
  template: TemplateManifest;
  answers: OnboardingAnswers;
  onConfirm: () => void;
  isBuilding: boolean;
};

function PlanView({ template, answers, onConfirm, isBuilding }: PlanViewProps) {
  const styleOpt = template.styleOptions.find((s) => s.id === answers.style);

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      className="w-full max-w-md"
    >
      <div className="bg-void rounded-2xl border border-white/[0.08] p-5">
        <div className="flex items-center gap-3 mb-4">
          <div className="bg-signal/10 text-signal flex h-10 w-10 items-center justify-center rounded-xl">
            <Sparkles size={18} strokeWidth={1.5} />
          </div>
          <div>
            <div className="text-text text-sm font-semibold">{template.title}</div>
            <div className="text-ghost text-[11px]">
              {styleOpt?.icon} {styleOpt?.title ?? "Custom"} style
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <div className="text-dim text-xs font-medium tracking-wider uppercase">
            What we&apos;ll build
          </div>
          {template.features.map((feature, i) => (
            <div key={i} className="flex items-start gap-2.5 text-sm">
              <Check size={14} className="text-signal mt-0.5 shrink-0" />
              <span className="text-dim">{feature}</span>
            </div>
          ))}
        </div>

        <div className="bg-white/[0.02] mt-4 rounded-xl border border-white/[0.04] p-3">
          <div className="text-ghost text-[10px] font-medium tracking-wider uppercase mb-1">
            Tech
          </div>
          <div className="text-dim text-xs">
            Astro + Tailwind CSS · Deployed to Cloudflare Pages
          </div>
        </div>
      </div>

      <button
        onClick={onConfirm}
        disabled={isBuilding}
        className="bg-signal hover:bg-signal-dim mt-4 flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold text-primary-foreground shadow-[0_0_24px_rgba(34,197,94,0.18)] transition hover:shadow-[0_0_32px_rgba(34,197,94,0.28)] active:scale-[0.97] disabled:opacity-60"
      >
        {isBuilding ? (
          <>
            <Loader2 size={16} className="animate-spin" />
            Creating project…
          </>
        ) : (
          <>
            <Sparkles size={16} />
            Start Building
          </>
        )}
      </button>
    </motion.div>
  );
}

export function OnboardingWizard({ onComplete }: { onComplete: (folderPath: string) => void }) {
  const [step, setStep] = useState<Step>("templates");
  const [templates, setTemplates] = useState<TemplateManifest[]>([]);
  const [isLoadingTemplates, setIsLoadingTemplates] = useState(true);
  const [selectedTemplate, setSelectedTemplate] = useState<TemplateManifest | null>(null);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [selectedStyle, setSelectedStyle] = useState<string>("");
  const [isBuilding, setIsBuilding] = useState(false);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const setMode = useAgentStore((s) => s.setMode);

  // Load templates on mount
  useEffect(() => {
    desktopRpc.request.getTemplates().then((t) => {
      setTemplates(t);
      setIsLoadingTemplates(false);
    }).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[OnboardingWizard] Failed to load templates:", msg, err);
      setTemplateError(msg);
      setIsLoadingTemplates(false);
    });
  }, []);

  const totalSteps = 4;

  const stepOrder: Step[] = ["templates", "questions", "style", "plan"];
  const stepIndex = stepOrder.indexOf(step);

  const handleTemplateSelect = useCallback((template: TemplateManifest) => {
    setSelectedTemplate(template);
    setSelectedStyle(template.styleOptions[0]?.id ?? "");
    setAnswers({});
    setQuestionIndex(0);
  }, []);

  const handleTemplateConfirm = useCallback(() => {
    if (selectedTemplate) {
      setStep("questions");
    }
  }, [selectedTemplate]);

  const handleQuestionAnswer = useCallback((value: string) => {
    if (!selectedTemplate) return;
    const q = selectedTemplate.questions[questionIndex];
    setAnswers((prev) => ({ ...prev, [q.id]: value }));

    if (questionIndex < selectedTemplate.questions.length - 1) {
      setQuestionIndex((prev) => prev + 1);
    } else {
      setStep("style");
    }
  }, [selectedTemplate, questionIndex]);

  const handleStyleSelect = useCallback((styleId: string) => {
    setSelectedStyle(styleId);
  }, []);

  const handleStyleConfirm = useCallback(() => {
    setStep("plan");
  }, [selectedStyle]);

  const handleBuild = useCallback(async () => {
    if (!selectedTemplate) return;
    setIsBuilding(true);

    try {
      // Generate a project name from the answers
      const businessName = answers["name"] ?? answers["business"] ?? answers["product"] ?? answers["topic"] ?? "my-project";
      const projectName = businessName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

      const { folderPath } = await desktopRpc.request.createProjectFromTemplate({
        templateId: selectedTemplate.id,
        projectName,
      });

      setStep("building");

      // Small delay for the building animation
      await new Promise((r) => setTimeout(r, 600));

      onComplete(folderPath);
    } catch (err) {
      console.error("Failed to create project from template:", err);
      setIsBuilding(false);
    }
  }, [selectedTemplate, answers, onComplete]);

  const handleSkipOnboarding = useCallback(() => {
    // Switch to normal mode and skip onboarding
    setMode("normal");
    desktopRpc.request.getSettings().then((settings) => {
      void desktopRpc.request.saveSettings({ settings: { ...settings, mode: "normal" } });
    });
    onComplete("");
  }, [setMode, onComplete]);

  if (isLoadingTemplates) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4">
        <Loader2 size={24} className="text-signal animate-spin" />
        <p className="text-dim text-sm">Loading templates…</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="shrink-0 px-6 pt-8 pb-4">
        <StepHeader step={step} stepIndex={stepIndex} totalSteps={totalSteps} />
      </div>

      {/* Content */}
      <div className="flex flex-1 flex-col items-center justify-center px-6 pb-8">
        <AnimatePresence mode="wait">
          {step === "templates" && (
            <motion.div
              key="templates"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -12 }}
              className="w-full max-w-lg"
            >
              {templateError && (
                <div className="mb-4 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-xs text-red-400">
                  Failed to load templates: {templateError}
                </div>
              )}
              <div className="grid grid-cols-2 gap-3 mb-6">
                {templates.map((t) => (
                  <TemplateCard
                    key={t.id}
                    template={t}
                    selected={selectedTemplate?.id === t.id}
                    onSelect={() => handleTemplateSelect(t)}
                  />
                ))}
              </div>
              <button
                onClick={handleTemplateConfirm}
                disabled={!selectedTemplate}
                className="bg-signal hover:bg-signal-dim flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold text-primary-foreground transition active:scale-[0.97] disabled:opacity-40"
              >
                Continue
                <ArrowRight size={14} />
              </button>
            </motion.div>
          )}

          {step === "questions" && selectedTemplate && (
            <div className="w-full max-w-md">
              <AnimatePresence mode="wait">
                <QuestionCard
                  key={selectedTemplate.questions[questionIndex].id}
                  question={selectedTemplate.questions[questionIndex]}
                  value={answers[selectedTemplate.questions[questionIndex].id] ?? ""}
                  onChange={(val) =>
                    setAnswers((prev) => ({
                      ...prev,
                      [selectedTemplate.questions[questionIndex].id]: val,
                    }))
                  }
                  onNext={() =>
                    handleQuestionAnswer(
                      answers[selectedTemplate.questions[questionIndex].id] ?? "",
                    )
                  }
                  isLast={questionIndex === selectedTemplate.questions.length - 1}
                />
              </AnimatePresence>
            </div>
          )}

          {step === "style" && selectedTemplate && (
            <div className="w-full max-w-md">
              <StylePicker
                options={selectedTemplate.styleOptions}
                selected={selectedStyle}
                onSelect={handleStyleSelect}
              />
              <button
                onClick={handleStyleConfirm}
                className="bg-signal hover:bg-signal-dim mt-6 flex w-full items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold text-primary-foreground transition active:scale-[0.97]"
              >
                Continue
                <ArrowRight size={14} />
              </button>
            </div>
          )}

          {step === "plan" && selectedTemplate && (
            <PlanView
              template={selectedTemplate}
              answers={{
                templateId: selectedTemplate.id,
                answers,
                style: selectedStyle,
              }}
              onConfirm={handleBuild}
              isBuilding={isBuilding}
            />
          )}

          {step === "building" && (
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="flex flex-col items-center gap-4"
            >
              <div className="bg-signal/10 text-signal flex h-16 w-16 items-center justify-center rounded-2xl">
                <Loader2 size={28} className="animate-spin" />
              </div>
              <p className="text-dim text-sm">Setting up your project…</p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Bottom skip link */}
      {step === "templates" && (
        <div className="shrink-0 pb-6 text-center">
          <button
            onClick={handleSkipOnboarding}
            className="text-ghost hover:text-dim text-xs transition"
          >
            I know what I&apos;m doing — take me to Normal Mode
          </button>
        </div>
      )}
    </div>
  );
}
