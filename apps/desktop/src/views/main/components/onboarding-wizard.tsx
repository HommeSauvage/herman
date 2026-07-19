import { motion, AnimatePresence } from "motion/react";
import {
  ArrowRight,
  BookOpen,
  Sparkles,
  Loader2,
  Store,
  Rocket,
  FileText,
  Check,
  AlertCircle,
  Cpu,
  Download,
  PartyPopper,
} from "lucide-react";
import { getLogger } from "@logtape/logtape";
import { useCallback, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { cn } from "@herman/ui/lib/utils";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@herman/ui/components/accordion";

import type { WizardSessionEvent } from "../../../shared/agent-protocol.js";
import type { GalleryTemplate } from "../../../shared/herman-manifest.js";
import { getToolEntry } from "../../../shared/tool-registry.js";
import { desktopRpc } from "../lib/desktop-rpc.js";
import { useAgentStore } from "../lib/agent-store.js";
import type { WizardStep, WizardPhaseId } from "../lib/agent-store/types.js";
import { useConfetti } from "../hooks/use-confetti.js";
import { ContentWidth, SignalButton } from "./ui/index.js";
import { ModelSelector } from "./model-selector.js";
import { WizardDocsView } from "./wizard-docs-view.js";
import { WizardQuestions } from "./wizard-questions.js";
import { WizardLoading } from "./wizard-loading.js";
import { WizardToolSetup } from "./wizard-tool-setup.js";
import { ProgressLog } from "./progress-log.js";

const logger = getLogger(["herman-desktop", "view", "onboarding-wizard"]);

function shortModelLabel(modelId?: string): string {
  if (!modelId) return "Select model";
  const slash = modelId.indexOf("/");
  return slash > 0 ? modelId.slice(slash + 1) : modelId;
}

const PHASE_HEADERS: Record<WizardPhaseId, { title: string; subtitle: string }> = {
  planning: {
    title: "Planning your project",
    subtitle: "The agent is figuring out the best starting point.",
  },
  coding: {
    title: "Setting up your project",
    subtitle: "The agent is on it — this takes a moment.",
  },
  qa: {
    title: "Verifying everything works",
    subtitle: "The agent is testing your project end to end.",
  },
  docs: {
    title: "Writing your docs & tutorials",
    subtitle: "Almost there — creating guides tailored to your project.",
  },
};

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
  missingCount,
}: {
  template: GalleryTemplate;
  selected: boolean;
  /** Number of required tools missing on this machine (undefined = unknown). */
  missingCount?: number;
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
          <span className={cn("flex items-center gap-2 text-sm font-medium", selected ? "text-text" : "text-body")}>
            {template.name}
            {missingCount !== undefined && missingCount > 0 && (
              <span className="rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-[10px] font-normal text-amber-300">
                Needs setup
              </span>
            )}
          </span>
          <span className="text-dim text-sm leading-relaxed">{template.description}</span>
        </div>
      </AccordionTrigger>
      {template.suitableFor && (
        <AccordionContent className="text-dim text-sm leading-relaxed">
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
  const [templates, setTemplates] = useState<GalleryTemplate[]>([]);
  const [isLoadingTemplates, setIsLoadingTemplates] = useState(true);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [docsOpen, setDocsOpen] = useState(false);
  /** Required-tools-missing count per template id (for gallery badges). */
  const [missingByTemplate, setMissingByTemplate] = useState<Record<string, number>>({});
  const [installBusy, setInstallBusy] = useState(false);

  const {
    step,
    description,
    selectedTemplateId,
    wizardSessionId,
    progressLines,
    envelope,
    pendingRequestId,
    installRequest,
    projectPath,
    wizardError,
    retryAttempt,
    retryMax,
    recoveryBlocked,
    currentModel,
    phase,
  } = useAgentStore(
    useShallow((s) => ({
      step: s.wizard.step,
      description: s.wizard.description,
      selectedTemplateId: s.wizard.selectedTemplateId,
      wizardSessionId: s.wizard.sessionId,
      progressLines: s.wizard.progressLines,
      envelope: s.wizard.envelope,
      pendingRequestId: s.wizard.pendingRequestId,
      installRequest: s.wizard.installRequest ?? null,
      projectPath: s.wizard.projectPath,
      wizardError: s.wizard.wizardError,
      retryAttempt: s.wizard.retryAttempt,
      retryMax: s.wizard.retryMax,
      recoveryBlocked: s.wizard.recoveryBlocked,
      currentModel: s.wizard.currentModel,
      phase: s.wizard.phase,
    })),
  );

  const setModelSelectorOpen = useAgentStore((s) => s.setModelSelectorOpen);
  const setWizardActive = useAgentStore((s) => s.setWizardActive);
  const setWizardCurrentModel = useAgentStore((s) => s.setWizardCurrentModel);
  const setWizardSessionId = useAgentStore((s) => s.setWizardSessionId);
  const setWizardStep = useAgentStore((s) => s.setWizardStep);
  const setWizardDescription = useAgentStore((s) => s.setWizardDescription);
  const setWizardSelectedTemplateId = useAgentStore((s) => s.setWizardSelectedTemplateId);
  const patchWizard = useAgentStore((s) => s.patchWizard);
  const hydrateWizardFromRecovery = useAgentStore((s) => s.hydrateWizardFromRecovery);
  const clearWizardState = useAgentStore((s) => s.clearWizardState);
  const deactivateWizard = useAgentStore((s) => s.deactivateWizard);

  const selectedTemplate =
    selectedTemplateId ? templates.find((t) => t.id === selectedTemplateId) ?? null : null;

  const { start: fireConfetti } = useConfetti();
  const confettiFiredRef = useRef(false);

  const sessionRef = useRef<string | undefined>(undefined);
  sessionRef.current = wizardSessionId;
  const projectPathRef = useRef<string | null | undefined>(null);
  projectPathRef.current = projectPath;

  // Activate wizard context and resolve the preferred model from the shared
  // catalog (seeded at app init from the main-process catalog service).
  useEffect(() => {
    setWizardActive(true);
    const store = useAgentStore.getState();

    const catalog = store.modelCatalog.availableModels;
    const lastUsed = store.settings.models.lastUsedModel;
    const preferred =
      store.wizard.currentModel && catalog.includes(store.wizard.currentModel)
        ? store.wizard.currentModel
        : lastUsed && catalog.includes(lastUsed)
          ? lastUsed
          : catalog[0];
    if (preferred) setWizardCurrentModel(preferred);

    return () => {
      // Soft deactivate so HMR remount can rehydrate from Bun / Zustand.
      deactivateWizard();
    };
  }, [
    setWizardActive,
    setWizardCurrentModel,
    deactivateWizard,
  ]);

  // Reattach to a live Bun session or already-hydrated recovery (HMR).
  useEffect(() => {
    const existing = useAgentStore.getState().wizard;
    if (existing.recoveryMode === "continue" || existing.sessionId) return;

    void desktopRpc.request.getWizardRecovery().then((recovery) => {
      if (!recovery) return;
      if (recovery.live) {
        patchWizard({
          sessionId: recovery.sessionId,
          selectedTemplateId: recovery.templateId,
          description: recovery.description ?? "",
          progressLines: recovery.progressLines,
          projectPath: recovery.projectPath ?? null,
          wizardError: recovery.uiStep === "error" ? recovery.lastError ?? null : null,
          recoveryMode: false,
          recoveryBlocked: false,
          step: (recovery.uiStep ?? "working") as WizardStep,
          phase: recovery.phase ?? "planning",
          pendingRequestId: recovery.pendingRequestId ?? null,
          envelope: recovery.envelope ?? null,
          retryAttempt: recovery.retryAttempt ?? 0,
        });
        return;
      }
      hydrateWizardFromRecovery({
        sessionId: recovery.sessionId,
        templateId: recovery.templateId,
        description: recovery.description,
        progressLines: recovery.progressLines,
        projectPath: recovery.projectPath ?? null,
        wizardError: recovery.lastError ?? recovery.blockedReason ?? null,
        recoveryBlocked: !recovery.resumable,
        preferredModel: recovery.preferredModel,
        phase: recovery.phase,
      });
    }).catch((err) => {
      logger.warning("Failed to query wizard recovery", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, [hydrateWizardFromRecovery, patchWizard]);

  useEffect(() => {
    desktopRpc.request
      .getGalleryTemplates()
      .then((t) => {
        setTemplates(t);
        setIsLoadingTemplates(false);
        // Background requirement checks → "Needs setup" badges on cards.
        for (const template of t) {
          void desktopRpc.request
            .checkTemplateRequirements({ templateId: template.id })
            .then(({ results }) => {
              const missing = results.filter((r) => !r.ok && !r.optional).length;
              setMissingByTemplate((prev) => ({ ...prev, [template.id]: missing }));
            })
            .catch(() => undefined);
        }
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("Failed to load templates", { error: msg });
        setTemplateError(msg);
        setIsLoadingTemplates(false);
      });
  }, []);

  const handleWizardEvent = useCallback(
    (payload: { event: WizardSessionEvent }) => {
      const event = payload.event;

      if (event.type === "wizard_models") {
        // The main-process catalog service owns the shared catalog (it also
        // ingests this list); here we only need the current-model fallback.
        if (event.currentModel && !useAgentStore.getState().wizard.currentModel) {
          useAgentStore.getState().setWizardCurrentModel(event.currentModel);
        }
        return;
      }

      if (sessionRef.current && event.wizardSessionId !== sessionRef.current) return;

      switch (event.type) {
        case "wizard_phase": {
          useAgentStore.getState().patchWizard({ phase: event.phase });
          break;
        }
        case "wizard_progress": {
          useAgentStore.getState().setWizardProgressLines((prev) => [...prev, event.text].slice(-50));
          // If we were retrying, the first progress event means the agent
          // has recovered — transition back to the working state.
          if (useAgentStore.getState().wizard.step === "retrying") {
            useAgentStore.getState().patchWizard({ step: "working", retryAttempt: 0 });
          }
          break;
        }
        case "wizard_request": {
          useAgentStore.getState().patchWizard({
            pendingRequestId: event.requestId,
            envelope: event.envelope,
            step: "questions",
            recoveryMode: false,
          });
          break;
        }
        case "wizard_install_request": {
          useAgentStore.getState().patchWizard({
            installRequest: { requestId: event.requestId, envelope: event.envelope },
          });
          break;
        }
        case "wizard_complete": {
          useAgentStore.getState().patchWizard({
            projectPath: event.projectPath,
            step: "done",
            recoveryMode: false,
          });
          if (!confettiFiredRef.current) {
            confettiFiredRef.current = true;
            requestAnimationFrame(() => fireConfetti());
          }
          break;
        }
        case "wizard_retrying": {
          useAgentStore.getState().patchWizard({
            retryAttempt: event.attempt,
            retryMax: event.maxRetries,
            step: "retrying",
            recoveryMode: false,
          });
          break;
        }
        case "wizard_end": {
          if (event.error) {
            useAgentStore.getState().patchWizard({
              wizardError: event.error,
              step: "error",
              retryAttempt: 0,
              recoveryMode: false,
            });
          } else if (!projectPathRef.current) {
            useAgentStore.getState().patchWizard({
              wizardError: "Setup ended before finishing.",
              step: "error",
              retryAttempt: 0,
              recoveryMode: false,
            });
          } else {
            useAgentStore.getState().setWizardRetry(0);
          }
          break;
        }
      }
    },
    [fireConfetti],
  );

  useEffect(() => {
    desktopRpc.addMessageListener("wizardEvent", handleWizardEvent);
    return () => {
      desktopRpc.removeMessageListener("wizardEvent", handleWizardEvent);
    };
  }, [handleWizardEvent]);

  // Actually launches the planning agent. Called by the setup step once the
  // machine satisfies the template's requirements.
  const startWizardSessionNow = useCallback(async () => {
    if (!selectedTemplate || !description.trim()) return;
    patchWizard({ step: "working" });
    const modelId = useAgentStore.getState().wizard.currentModel;
    try {
      const { wizardSessionId: id } = await desktopRpc.request.startWizardSession({
        templateId: selectedTemplate.id,
        description: description.trim(),
        ...(modelId ? { modelId } : {}),
      });
      setWizardSessionId(id);
      const latestModel = useAgentStore.getState().wizard.currentModel;
      if (latestModel && latestModel !== modelId) {
        void desktopRpc.request.setWizardModel({ wizardSessionId: id, modelId: latestModel });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("Failed to start wizard session", { error: msg });
      patchWizard({ wizardError: msg, step: "error" });
    }
  }, [selectedTemplate, description, patchWizard, setWizardSessionId]);

  // Describe → Continue: reset state and route through the deterministic
  // tool-setup step before any agent starts.
  const handleDescribeContinue = useCallback(() => {
    if (!selectedTemplate || !description.trim()) return;
    patchWizard({
      wizardError: null,
      retryAttempt: 0,
      progressLines: [],
      envelope: null,
      installRequest: null,
      projectPath: null,
      sessionId: undefined,
      step: "setup",
      recoveryMode: false,
    });
  }, [selectedTemplate, description, patchWizard]);

  const handleInstallRespond = useCallback(
    (approved: boolean) => {
      if (!wizardSessionId || !installRequest) return;
      const { requestId } = installRequest;
      patchWizard({ installRequest: null });
      if (approved) setInstallBusy(true);
      void desktopRpc.request
        .respondWizardInstall({ wizardSessionId, requestId, approved })
        .catch((err) => {
          logger.warning("respondWizardInstall failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => setInstallBusy(false));
    },
    [wizardSessionId, installRequest, patchWizard],
  );

  const handleAnswersSubmit = useCallback(
    (answers: { id: string; value: string; values?: string[] }[]) => {
      if (!wizardSessionId || !pendingRequestId) return;
      patchWizard({
        envelope: null,
        pendingRequestId: null,
        step: "working",
      });
      void desktopRpc.request.respondWizardQuestions({
        wizardSessionId,
        requestId: pendingRequestId,
        answers,
      });
    },
    [wizardSessionId, pendingRequestId, patchWizard],
  );

  const handleQuestionsCancel = useCallback(() => {
    if (!wizardSessionId) return;
    void desktopRpc.request.cancelWizard({ wizardSessionId });
    patchWizard({
      sessionId: undefined,
      envelope: null,
      pendingRequestId: null,
      step: "describe",
    });
  }, [wizardSessionId, patchWizard]);

  const handleDone = useCallback(async () => {
    if (!projectPath || !wizardSessionId) {
      onComplete();
      clearWizardState();
      return;
    }
    try {
      await desktopRpc.request.adoptWizardSession({
        projectPath,
        wizardSessionId,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("Failed to adopt wizard session", { error: msg });
      patchWizard({ wizardError: msg, step: "error" });
      return;
    }
    onComplete();
    clearWizardState();
  }, [projectPath, wizardSessionId, onComplete, clearWizardState, patchWizard]);

  const handleRetryOrContinue = useCallback(() => {
    if (wizardSessionId && !recoveryBlocked) {
      patchWizard({
        wizardError: null,
        retryAttempt: 0,
        step: "working",
        recoveryMode: false,
      });
      void desktopRpc.request.resumeWizardSession({ wizardSessionId }).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("Failed to resume wizard session", { error: msg });
        patchWizard({ wizardError: msg, step: "error", recoveryMode: false });
      });
      return;
    }

    // Blocked recovery or no session — clear checkpoint and return to describe.
    void (async () => {
      if (wizardSessionId) {
        await desktopRpc.request.cancelWizard({ wizardSessionId }).catch(() => undefined);
      } else {
        await desktopRpc.request.discardWizardRecovery().catch(() => undefined);
      }
      clearWizardState();
      setWizardStep("describe");
    })();
  }, [wizardSessionId, recoveryBlocked, patchWizard, clearWizardState, setWizardStep]);

  const handleStartOver = useCallback(() => {
    const id = wizardSessionId;
    void (async () => {
      if (id) {
        await desktopRpc.request.cancelWizard({ wizardSessionId: id }).catch(() => undefined);
      } else {
        await desktopRpc.request.discardWizardRecovery().catch(() => undefined);
      }
      clearWizardState();
      setWizardStep("templates");
    })();
  }, [wizardSessionId, clearWizardState, setWizardStep]);

  const handleSkipOnboarding = useCallback(() => {
    if (wizardSessionId) {
      void desktopRpc.request.cancelWizard({ wizardSessionId });
    }
    clearWizardState();
    onCancel();
  }, [onCancel, wizardSessionId, clearWizardState]);

  if (isLoadingTemplates) {
    return (
      <div className="relative flex h-full flex-col items-center justify-center gap-4">
        <Loader2 size={24} className="text-signal animate-spin" />
        <p className="text-dim text-sm">Loading templates…</p>
        <ModelSelector />
      </div>
    );
  }

  if (docsOpen && projectPath) {
    return (
      <WizardDocsView
        projectPath={projectPath}
        onBack={() => setDocsOpen(false)}
        onOpenProject={handleDone}
      />
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
        {step === "setup" && (
          <StepHeader
            title="Getting your computer ready"
            subtitle="This template needs a few free tools. One click and you're set."
          />
        )}
        {step === "working" && (
          <StepHeader
            title={PHASE_HEADERS[phase].title}
            subtitle={PHASE_HEADERS[phase].subtitle}
          />
        )}
        {step === "questions" && <StepHeader title="A few questions" subtitle="Only the bits we still need." />}
        {step === "done" && (
          <StepHeader title="Your project is ready" subtitle="Take a minute to get familiar — or dive right in." />
        )}
        {step === "error" && <StepHeader title="Something went wrong" subtitle="You can try again." />}
        {step === "recovery" && (
          <StepHeader
            title="Setup was interrupted"
            subtitle={
              recoveryBlocked
                ? "We couldn't resume where you left off."
                : "Pick up where the agent left off."
            }
          />
        )}
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
                <div className="mb-4 text-dim text-sm">
                  This is just the initial setup, you will be able to continue building on top of it. Choose the template that can be the best starting point for you.
                </div>
                <Accordion
                  value={selectedTemplate ? [selectedTemplate.id] : []}
                  onValueChange={(values) => {
                    const nextId = values[0];
                    setWizardSelectedTemplateId(nextId);
                  }}
                  className="border-white/[0.08] bg-white/[0.02] mb-6 max-h-[360px] overflow-y-auto"
                >
                  {templates.map((t) => (
                    <TemplateListItem
                      key={t.id}
                      template={t}
                      selected={selectedTemplate?.id === t.id}
                      missingCount={missingByTemplate[t.id]}
                    />
                  ))}
                </Accordion>
                <SignalButton
                  size="lg"
                  fullWidth
                  disabled={!selectedTemplate}
                  onClick={() => selectedTemplate && setWizardStep("describe")}
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
                  onChange={(e) => setWizardDescription(e.target.value)}
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

          {step === "setup" && selectedTemplate && (
            <WizardToolSetup
              key={selectedTemplate.id}
              templateId={selectedTemplate.id}
              onReady={startWizardSessionNow}
            />
          )}

          {step === "working" && (
            <motion.div
              key="working"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="w-full"
            >
              <ContentWidth size="formWide">
                <WizardLoading progressLines={progressLines} phase={phase} />
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
              <ContentWidth size="formWide">
                <WizardLoading
                  progressLines={progressLines}
                  phase={phase}
                  headerText={`Connection lost — retrying (attempt ${retryAttempt} of ${retryMax})`}
                  variant="retrying"
                />
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
                    <h2 className="text-text text-lg font-semibold">Congratulations!</h2>
                    <p className="text-dim mt-1 text-sm">Your project is ready to go.</p>
                  </div>
                </motion.div>

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

                <motion.div
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.35 }}
                >
                  <SignalButton size="lg" fullWidth glow className="mt-5" onClick={() => setDocsOpen(true)}>
                    <BookOpen size={16} />
                    Let's get familiar with your project first
                  </SignalButton>
                  <button
                    type="button"
                    onClick={handleDone}
                    className="text-dim hover:text-text mt-3 w-full rounded-xl border border-mist bg-white/[0.02] px-4 py-2.5 text-sm transition hover:bg-fog"
                  >
                    I know how to use Herman, open the project
                  </button>
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
                <SignalButton size="md" fullWidth onClick={handleRetryOrContinue}>
                  Try again
                  <ArrowRight size={14} />
                </SignalButton>
              </ContentWidth>
            </motion.div>
          )}

          {step === "recovery" && (
            <motion.div
              key="recovery"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              className="w-full"
            >
              <ContentWidth size="form">
                {wizardError && (
                  <div className="mb-4 flex items-start gap-3 rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-xs text-amber-200">
                    <AlertCircle size={14} className="mt-0.5 shrink-0" />
                    <span className="leading-relaxed">{wizardError}</span>
                  </div>
                )}
                <ProgressLog lines={progressLines} />
                {!recoveryBlocked && (
                  <SignalButton size="lg" fullWidth glow className="mt-4" onClick={handleRetryOrContinue}>
                    Continue
                    <ArrowRight size={14} />
                  </SignalButton>
                )}
                <button
                  type="button"
                  onClick={handleStartOver}
                  className="text-ghost hover:text-dim mt-3 w-full text-center text-xs transition"
                >
                  Start over
                </button>
              </ContentWidth>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Agent-requested install approval (herman_request_install) */}
      <AnimatePresence>
        {installRequest && (
          <motion.div
            key="install-request"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 16 }}
            className="absolute inset-x-0 bottom-0 z-20 flex justify-center px-6 pb-6"
          >
            <div className="bg-ridge w-full max-w-md rounded-2xl border border-white/[0.1] p-4 shadow-2xl">
              <div className="flex items-start gap-3">
                <div className="bg-signal/10 text-signal flex h-9 w-9 shrink-0 items-center justify-center rounded-xl">
                  <Download size={16} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-text text-sm font-semibold">
                    Install {installRequest.envelope.label}?
                  </div>
                  <p className="text-dim mt-0.5 text-xs leading-relaxed">
                    {installRequest.envelope.reason ??
                      getToolEntry(installRequest.envelope.toolId)?.why ??
                      "The agent needs this tool to continue building your project."}
                  </p>
                </div>
              </div>
              <div className="mt-3 flex gap-2">
                <SignalButton
                  size="sm"
                  className="flex-1"
                  disabled={installBusy}
                  onClick={() => handleInstallRespond(true)}
                >
                  {installBusy ? <Loader2 size={12} className="animate-spin" /> : null}
                  Approve & install
                </SignalButton>
                <button
                  type="button"
                  disabled={installBusy}
                  onClick={() => handleInstallRespond(false)}
                  className="text-dim hover:text-text rounded-xl border border-mist bg-white/[0.02] px-3 py-1.5 text-xs transition hover:bg-fog"
                >
                  Not now
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

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


