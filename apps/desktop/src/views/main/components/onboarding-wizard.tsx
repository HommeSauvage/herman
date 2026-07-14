import { motion, AnimatePresence } from "motion/react";
import {
  ArrowRight,
  Sparkles,
  Loader2,
  Store,
  Rocket,
  FileText,
  Check,
  AlertCircle,
  Cpu,
  PartyPopper,
} from "lucide-react";
import { getLogger } from "@logtape/logtape";
import { useCallback, useEffect, useRef, useState } from "react";

import { cn } from "@herman/ui/lib/utils";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@herman/ui/components/accordion";

import type { WizardSessionEvent } from "../../../shared/agent-protocol.js";
import type { GalleryTemplate } from "../../../shared/herman-manifest.js";
import type { WizardAskEnvelope } from "../../../shared/wizard-protocol.js";
import { desktopRpc } from "../lib/desktop-rpc.js";
import { useAgentStore } from "../lib/agent-store.js";
import { useConfetti } from "../hooks/use-confetti.js";
import { ContentWidth, SignalButton } from "./ui/index.js";
import { ModelSelector } from "./model-selector.js";
import { WizardQuestions } from "./wizard-questions.js";

const logger = getLogger(["herman-desktop", "view", "onboarding-wizard"]);

type Step = "templates" | "describe" | "working" | "questions" | "done" | "error" | "retrying";

function shortModelLabel(modelId?: string): string {
  if (!modelId) return "Select model";
  const slash = modelId.indexOf("/");
  return slash > 0 ? modelId.slice(slash + 1) : modelId;
}

function StepHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="text-center">
      <motion.h1
        key={`title-${title}`}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="text-text text-2xl font-semibold tracking-tight"
      >
        {title}
      </motion.h1>
      <motion.p
        key={`subtitle-${subtitle}`}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.05 }}
        className="text-dim mt-1.5 text-sm"
      >
        {subtitle}
      </motion.p>
    </div>
  );
}

const ICON_MAP: Record<string, React.ElementType> = {
  "🏪": Store,
  "🚀": Rocket,
  "📝": FileText,
};

function TemplateListItem({
  template,
  selected,
}: {
  template: GalleryTemplate;
  selected: boolean;
}) {
  const IconComp = (template.icon ? ICON_MAP[template.icon] : undefined) ?? Sparkles;
  return (
    <AccordionItem
      value={template.id}
      className="border-white/[0.06] data-open:bg-white/[0.04]"
    >
      <AccordionTrigger className="px-4 py-3.5 hover:no-underline">
        <IconComp
          size={20}
          strokeWidth={1.5}
          className={cn(
            "mt-0.5 shrink-0 transition-colors",
            selected ? "text-signal" : "text-dim",
          )}
        />
        <div className="flex flex-1 flex-col items-start gap-0.5 text-left">
          <span className={cn("text-sm font-medium", selected ? "text-text" : "text-body")}>
            {template.name}
          </span>
          <span className="text-dim text-sm leading-relaxed">{template.description}</span>
        </div>
      </AccordionTrigger>
      {template.suitableFor && (
        <AccordionContent className="text-dim text-sm leading-relaxed">
          {/* Match trigger: icon (20px) + gap-6 so copy lines up with title/description */}
          <div className="flex gap-6">
            <span className="w-5 shrink-0" aria-hidden />
            <p>{template.suitableFor}</p>
          </div>
        </AccordionContent>
      )}
    </AccordionItem>
  );
}

export function OnboardingWizard({
  onComplete,
  onCancel,
}: {
  onComplete: () => void;
  onCancel: () => void;
}) {
  const [step, setStep] = useState<Step>("templates");
  const [templates, setTemplates] = useState<GalleryTemplate[]>([]);
  const [isLoadingTemplates, setIsLoadingTemplates] = useState(true);
  const [selectedTemplate, setSelectedTemplate] = useState<GalleryTemplate | null>(null);
  const [description, setDescription] = useState("");
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [wizardError, setWizardError] = useState<string | null>(null);

  // Wizard session state.
  const [wizardSessionId, setWizardSessionId] = useState<string | null>(null);
  const [progressLines, setProgressLines] = useState<string[]>([]);
  const [envelope, setEnvelope] = useState<WizardAskEnvelope | null>(null);
  const [pendingRequestId, setPendingRequestId] = useState<string | null>(null);
  const [projectPath, setProjectPath] = useState<string | null>(null);
  // Retry state.
  const [retryAttempt, setRetryAttempt] = useState(0);
  const [retryMax, setRetryMax] = useState(20);
  const [retryError, setRetryError] = useState<string | undefined>(undefined);

  const currentModel = useAgentStore((s) => s.wizard.currentModel);
  const setModelSelectorOpen = useAgentStore((s) => s.setModelSelectorOpen);
  const setWizardActive = useAgentStore((s) => s.setWizardActive);
  const setWizardCurrentModel = useAgentStore((s) => s.setWizardCurrentModel);
  const setWizardSessionIdStore = useAgentStore((s) => s.setWizardSessionId);
  const setModelCatalog = useAgentStore((s) => s.setModelCatalog);
  const clearWizardState = useAgentStore((s) => s.clearWizardState);

  // Confetti: fires when the wizard completes.
  const { start: fireConfetti } = useConfetti();
  const confettiFiredRef = useRef(false);

  // Refs so the wizardEvent listener (registered once) can read/act on latest state.
  const stepRef = useRef<Step>(step);
  stepRef.current = step;
  const sessionRef = useRef<string | null>(null);
  sessionRef.current = wizardSessionId;

  // Activate wizard context and seed the shared model catalog from the same
  // sources chat uses (tab models_sync → catalog, else Herman cache).
  useEffect(() => {
    setWizardActive(true);
    const store = useAgentStore.getState();

    const fromTabs = new Set<string>();
    for (const tab of Object.values(store.tabs)) {
      for (const modelId of tab.availableModels) fromTabs.add(modelId);
    }
    if (fromTabs.size > 0) {
      setModelCatalog(Array.from(fromTabs), { merge: true });
    }

    const catalog = useAgentStore.getState().modelCatalog.availableModels;
    const preferred =
      store.settings.models.defaultModel &&
      catalog.includes(store.settings.models.defaultModel)
        ? store.settings.models.defaultModel
        : store.wizard.currentModel && catalog.includes(store.wizard.currentModel)
          ? store.wizard.currentModel
          : catalog[0];
    if (preferred) setWizardCurrentModel(preferred);

    if (catalog.length === 0) {
      void desktopRpc.request
        .getHermanModelsCache()
        .then((result) => {
          if (result.models.length === 0) return;
          setModelCatalog(result.models, { merge: true });
          const next = useAgentStore.getState();
          if (!next.wizard.currentModel) {
            const pick =
              next.settings.models.defaultModel &&
              result.models.includes(next.settings.models.defaultModel)
                ? next.settings.models.defaultModel
                : result.models[0];
            if (pick) setWizardCurrentModel(pick);
          }
        })
        .catch((err) => {
          logger.warning("Failed to seed models from Herman cache", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }

    return () => {
      clearWizardState();
    };
  }, [
    setWizardActive,
    setWizardCurrentModel,
    setModelCatalog,
    clearWizardState,
  ]);

  useEffect(() => {
    desktopRpc.request
      .getGalleryTemplates()
      .then((t) => {
        setTemplates(t);
        setIsLoadingTemplates(false);
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("Failed to load templates", { error: msg });
        setTemplateError(msg);
        setIsLoadingTemplates(false);
      });
  }, []);

  // ── Subscribe to wizard events for the active session ──────────────────────
  const handleWizardEvent = useCallback(
    (payload: { event: WizardSessionEvent }) => {
      const event = payload.event;

      // Catalog updates are global — accept even before React has the session id
      // (models_sync can fire during start before startWizardSession returns).
      if (event.type === "wizard_models") {
        useAgentStore.getState().setModelCatalog(event.models);
        if (event.currentModel && !useAgentStore.getState().wizard.currentModel) {
          useAgentStore.getState().setWizardCurrentModel(event.currentModel);
        }
        return;
      }

      // Only handle other events for the active wizard session.
      if (sessionRef.current && event.wizardSessionId !== sessionRef.current) return;

      switch (event.type) {
        case "wizard_progress": {
          setProgressLines((prev) => {
            const next = [...prev, event.text];
            return next.slice(-50);
          });
          break;
        }
        case "wizard_request": {
          setPendingRequestId(event.requestId);
          setEnvelope(event.envelope);
          setStep("questions");
          break;
        }
        case "wizard_complete": {
          setProjectPath(event.projectPath);
          setStep("done");
          if (!confettiFiredRef.current) {
            confettiFiredRef.current = true;
            // Defer so the "done" step renders first, then fire.
            requestAnimationFrame(() => fireConfetti());
          }
          break;
        }
        case "wizard_retrying": {
          setRetryAttempt(event.attempt);
          setRetryMax(event.maxRetries);
          setRetryError(event.error);
          setStep("retrying");
          break;
        }
        case "wizard_end": {
          if (event.error) {
            setWizardError(event.error);
            setStep("error");
          } else if (!projectPathRef.current) {
            // Agent ended without completing — treat as error.
            setWizardError("Setup ended before finishing.");
            setStep("error");
          }
          // Reset retry state on terminal event.
          setRetryAttempt(0);
          break;
        }
      }
    },
    [],
  );

  // projectPath ref for the closure above.
  const projectPathRef = useRef<string | null>(null);
  projectPathRef.current = projectPath;

  useEffect(() => {
    desktopRpc.addMessageListener("wizardEvent", handleWizardEvent);
    return () => {
      desktopRpc.removeMessageListener("wizardEvent", handleWizardEvent);
    };
  }, [handleWizardEvent]);

  // ── Start the wizard session when the user finishes describing ─────────────
  const handleDescribeContinue = useCallback(async () => {
    if (!selectedTemplate || !description.trim()) return;
    setWizardError(null);
    setRetryAttempt(0);
    setRetryError(undefined);
    setProgressLines([]);
    setEnvelope(null);
    setProjectPath(null);
    setWizardSessionId(null);
    setWizardSessionIdStore(undefined);
    setStep("working");
    const modelId = useAgentStore.getState().wizard.currentModel;
    try {
      const { wizardSessionId: id } = await desktopRpc.request.startWizardSession({
        templateId: selectedTemplate.id,
        description: description.trim(),
        ...(modelId ? { modelId } : {}),
      });
      setWizardSessionId(id);
      setWizardSessionIdStore(id);
      // Re-sync in case the user changed the model while start was in flight.
      const latestModel = useAgentStore.getState().wizard.currentModel;
      if (latestModel && latestModel !== modelId) {
        void desktopRpc.request.setWizardModel({ wizardSessionId: id, modelId: latestModel });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("Failed to start wizard session", { error: msg });
      setWizardError(msg);
      setStep("error");
    }
  }, [selectedTemplate, description, setWizardSessionIdStore]);

  // ── Submit answers to a wizard question batch ──────────────────────────────
  const handleAnswersSubmit = useCallback(
    (answers: { id: string; value: string; values?: string[] }[]) => {
      if (!wizardSessionId || !pendingRequestId) return;
      setEnvelope(null);
      setPendingRequestId(null);
      setStep("working");
      void desktopRpc.request.respondWizardQuestions({
        wizardSessionId,
        requestId: pendingRequestId,
        answers,
      });
    },
    [wizardSessionId, pendingRequestId],
  );

  const handleQuestionsCancel = useCallback(() => {
    if (!wizardSessionId) return;
    void desktopRpc.request.cancelWizard({ wizardSessionId });
    setWizardSessionId(null);
    setWizardSessionIdStore(undefined);
    setEnvelope(null);
    setPendingRequestId(null);
    setStep("describe");
  }, [wizardSessionId, setWizardSessionIdStore]);

  // ── Open the finished project as a fresh tab ───────────────────────────────
  const handleDone = useCallback(async () => {
    if (!projectPath || !wizardSessionId) {
      onComplete();
      return;
    }
    try {
      await desktopRpc.request.adoptWizardSession({
        projectPath,
        wizardSessionId,
      });
    } catch (err) {
      logger.error("Failed to adopt wizard session", {
        error: err instanceof Error ? err.message : String(err),
      });
      // Fall back to opening the project folder directly if adoption fails.
    }
    onComplete();
  }, [projectPath, wizardSessionId, onComplete]);

  const handleRetryFromError = useCallback(() => {
    setWizardError(null);
    setRetryAttempt(0);
    setRetryError(undefined);
    setWizardSessionId(null);
    setWizardSessionIdStore(undefined);
    setEnvelope(null);
    setPendingRequestId(null);
    setProjectPath(null);
    setProgressLines([]);
    setStep("describe");
  }, [setWizardSessionIdStore]);

  const handleSkipOnboarding = useCallback(() => {
    if (wizardSessionId) {
      void desktopRpc.request.cancelWizard({ wizardSessionId });
    }
    onCancel();
  }, [onCancel, wizardSessionId]);

  if (isLoadingTemplates) {
    return (
      <div className="relative flex h-full flex-col items-center justify-center gap-4">
        <Loader2 size={24} className="text-signal animate-spin" />
        <p className="text-dim text-sm">Loading templates…</p>
        <ModelSelector />
      </div>
    );
  }

  return (
    <div className="relative flex h-full flex-col">
      <div className="absolute top-4 right-4 z-10">
        <button
          type="button"
          aria-label="Change model"
          onClick={() => setModelSelectorOpen(true)}
          className="text-ghost hover:text-text flex max-w-[220px] items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs transition hover:bg-white/[0.04]"
        >
          <Cpu size={12} className="shrink-0" />
          <span className="truncate">{shortModelLabel(currentModel)}</span>
        </button>
      </div>

      <div className="shrink-0 px-6 pt-8 pb-4">
        {step === "templates" && (
          <StepHeader
            title="What do you want to build?"
            subtitle="Pick a starting point and we'll handle the rest."
          />
        )}
        {step === "describe" && (
          <StepHeader
            title="Describe what you're building"
            subtitle="The more detail you share, the better we can set things up."
          />
        )}
        {step === "working" && (
          <StepHeader title="Setting up your project" subtitle="The agent is on it — this takes a moment." />
        )}
        {step === "questions" && <StepHeader title="A few questions" subtitle="Only the bits we still need." />}
        {step === "done" && <StepHeader title="Your project is ready" subtitle="Let's open it up." />}
        {step === "error" && <StepHeader title="Something went wrong" subtitle="You can try again." />}
        {step === "retrying" && (
          <StepHeader
            title="Reconnecting…"
            subtitle={`The connection to the agent was lost. Retrying (${retryAttempt}/${retryMax})…`}
          />
        )}
      </div>

      <div className="flex flex-1 flex-col items-center justify-center px-6 pb-8">
        <AnimatePresence mode="wait">
          {step === "templates" && (
            <motion.div
              key="templates"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -12 }}
              className="w-full"
            >
              <ContentWidth size="formWide">
                {templateError && (
                  <div className="mb-4 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-xs text-red-400">
                    Failed to load templates: {templateError}
                  </div>
                )}
                <Accordion
                  value={selectedTemplate ? [selectedTemplate.id] : []}
                  onValueChange={(values) => {
                    const nextId = values[0];
                    setSelectedTemplate(
                      nextId ? templates.find((t) => t.id === nextId) ?? null : null,
                    );
                  }}
                  className="border-white/[0.08] bg-white/[0.02] mb-6 max-h-[360px] overflow-y-auto"
                >
                  {templates.map((t) => (
                    <TemplateListItem
                      key={t.id}
                      template={t}
                      selected={selectedTemplate?.id === t.id}
                    />
                  ))}
                </Accordion>
                <SignalButton
                  size="lg"
                  fullWidth
                  disabled={!selectedTemplate}
                  onClick={() => selectedTemplate && setStep("describe")}
                >
                  Continue
                  <ArrowRight size={14} />
                </SignalButton>
              </ContentWidth>
            </motion.div>
          )}

          {step === "describe" && (
            <motion.div
              key="describe"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -12 }}
              className="w-full"
            >
              <ContentWidth size="form">
                <textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="e.g. A blog about home cooking with recipes, photos, and weekly tips for beginners…"
                  rows={5}
                  className="text-text placeholder:text-ghost bg-void w-full resize-none rounded-xl border border-white/[0.08] px-4 py-3 text-sm transition focus:border-signal/40 focus:outline-none focus:ring-1 focus:ring-signal/20"
                  autoFocus
                />
                <SignalButton
                  size="md"
                  fullWidth
                  className="mt-4"
                  disabled={!description.trim()}
                  onClick={handleDescribeContinue}
                >
                  Continue
                  <ArrowRight size={14} />
                </SignalButton>
              </ContentWidth>
            </motion.div>
          )}

          {step === "working" && (
            <motion.div
              key="working"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="w-full"
            >
              <ContentWidth size="form">
                <div className="flex flex-col items-center gap-4">
                  <div className="bg-signal/10 text-signal flex h-14 w-14 items-center justify-center rounded-2xl">
                    <Loader2 size={24} className="animate-spin" />
                  </div>
                  <ProgressLog lines={progressLines} />
                </div>
              </ContentWidth>
            </motion.div>
          )}

          {step === "retrying" && (
            <motion.div
              key="retrying"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="w-full"
            >
              <ContentWidth size="form">
              <div className="flex flex-col items-center gap-4">
                {/* Orange / amber warning icon */}
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-500/15 text-amber-400">
                  <Loader2 size={24} className="animate-spin" />
                </div>
                <div className="text-center">
                  <p className="text-sm font-medium text-amber-300">
                    Connection lost — retrying
                  </p>
                  <p className="text-dim mt-1 text-xs">
                    Attempt {retryAttempt} of {retryMax}
                    {retryError && (
                      <span className="text-ghost mt-0.5 block truncate">
                        {retryError}
                      </span>
                    )}
                  </p>
                </div>
                <ProgressLog lines={progressLines} />
              </div>
              </ContentWidth>
            </motion.div>
          )}

          {step === "questions" && envelope && (
            <WizardQuestions
              envelope={envelope}
              onSubmit={handleAnswersSubmit}
              onCancel={handleQuestionsCancel}
            />
          )}

          {step === "done" && (
            <motion.div
              key="done"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="w-full"
            >
              <ContentWidth size="form">
              {/* Celebration header */}
              <motion.div
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.1 }}
                className="mb-6 flex flex-col items-center gap-3 text-center"
              >
                <motion.div
                  animate={{ scale: [1, 1.15, 1] }}
                  transition={{ duration: 0.6, delay: 0.3, ease: "easeOut" }}
                  className="bg-signal/10 text-signal flex h-16 w-16 items-center justify-center rounded-2xl ring-1 ring-signal/20"
                >
                  <PartyPopper size={28} strokeWidth={1.5} />
                </motion.div>
                <div>
                  <h2 className="text-text text-lg font-semibold">
                    Congratulations!
                  </h2>
                  <p className="text-dim mt-1 text-sm">
                    Your project is ready to go.
                  </p>
                </div>
              </motion.div>

              {/* Project card */}
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.2 }}
                className="bg-void mb-4 rounded-2xl border border-white/[0.08] p-4"
              >
                <div className="flex items-center gap-3">
                  <div className="bg-signal/10 text-signal flex h-10 w-10 items-center justify-center rounded-xl">
                    <Check size={18} strokeWidth={2} />
                  </div>
                  <div className="min-w-0">
                    <div className="text-text text-sm font-semibold">
                      {selectedTemplate?.name ?? "Project"}
                    </div>
                    {projectPath && (
                      <div className="text-ghost truncate text-[11px]">{projectPath}</div>
                    )}
                  </div>
                </div>
              </motion.div>

              <ProgressLog lines={progressLines} />

              {/* CTA */}
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.35 }}
              >
                <SignalButton size="lg" fullWidth glow className="mt-5" onClick={handleDone}>
                  <Sparkles size={16} />
                  Open Project
                </SignalButton>
                <p className="text-ghost mt-2 text-center text-[11px]">
                  Opens your project in a new tab.
                </p>
              </motion.div>
              </ContentWidth>
            </motion.div>
          )}

          {step === "error" && (
            <motion.div
              key="error"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              className="w-full"
            >
              <ContentWidth size="form">
                <div className="mb-4 flex items-start gap-3 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-xs text-red-400">
                  <AlertCircle size={14} className="mt-0.5 shrink-0" />
                  <span className="leading-relaxed">{wizardError ?? "Unknown error."}</span>
                </div>
                <SignalButton size="md" fullWidth onClick={handleRetryFromError}>
                  Try again
                  <ArrowRight size={14} />
                </SignalButton>
              </ContentWidth>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {step === "templates" && (
        <div className="shrink-0 pb-6 text-center">
          <button
            onClick={handleSkipOnboarding}
            className="text-ghost hover:text-dim text-xs transition"
          >
            Cancel
          </button>
        </div>
      )}

      <ModelSelector />
    </div>
  );
}

function ProgressLog({ lines }: { lines: string[] }) {
  if (lines.length === 0) return null;
  return (
    <div className="bg-void w-full rounded-xl border border-white/[0.06] px-4 py-3">
      <div className="max-h-32 space-y-1 overflow-y-auto">
        {lines.map((line, i) => (
          <div key={i} className="text-ghost text-[11px] leading-relaxed">
            {line}
          </div>
        ))}
      </div>
    </div>
  );
}
