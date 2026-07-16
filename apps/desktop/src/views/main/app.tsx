import { Sparkles, Loader2 } from "lucide-react";
import { getLogger } from "@logtape/logtape";
import { useEffect, useState } from "react";

import type { PersistedSession, Session, Tab, TabId } from "../../shared/rpc.js";
import { ErrorBoundary } from "./components/error-boundary.js";
import { LoginView } from "./components/login-view.js";
import { ModeChoiceView } from "./components/mode-choice-view.js";
import { OnboardingWizard } from "./components/onboarding-wizard.js";
import { RookieShell } from "./components/rookie-shell.js";
import { Shell } from "./components/shell.js";
import { UpdateBanner } from "./components/update-banner.js";
import { useAgentFinishedNotifications } from "./hooks/use-agent-finished-notifications.js";
import { useAgentStream } from "./hooks/use-agent-stream.js";
import { useAppStore, useAgentStore } from "./lib/agent-store.js";
import { useCommandShortcuts } from "./lib/command-dispatch.js";
import { desktopRpc } from "./lib/desktop-rpc.js";

const logger = getLogger(["herman-desktop", "view", "app"]);

function AppContent() {
  useCommandShortcuts();
  useAgentFinishedNotifications();

  const session = useAppStore((s) => s.session);
  const setSession = useAppStore((s) => s.setSession);
  const settings = useAgentStore((s) => s.settings);
  const restoreTabs = useAgentStore((s) => s.restoreTabs);
  const addTab = useAgentStore((s) => s.addTab);
  const closeTab = useAgentStore((s) => s.closeTab);
  const activateTab = useAgentStore((s) => s.activateTab);
  const setProjectForTab = useAgentStore((s) => s.setProjectForTab);
  const setProjects = useAgentStore((s) => s.setProjects);
  const setSessions = useAgentStore((s) => s.setSessions);
  const handleProjectOpened = useAgentStore((s) => s.handleProjectOpened);
  const setSettings = useAgentStore((s) => s.setSettings);
  const setView = useAgentStore((s) => s.setView);
  const tabCount = useAgentStore((s) => Object.keys(s.tabs).length);
  const [isLoading, setIsLoading] = useState(true);
  const [showModeChoice, setShowModeChoice] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<{ status: string; message: string } | null>(
    null,
  );
  useAgentStream();

  useEffect(() => {
    async function init() {
      try {
        const [currentSession, settings] = await Promise.all([
          desktopRpc.request.getSession(),
          desktopRpc.request.getSettings(),
        ]);
        setSession(currentSession);
        setSettings(settings);
        const { tabs, activeTabId } = await desktopRpc.request.getTabs();
        const { projects, sessions } = await desktopRpc.request.getProjectsAndSessions();
        restoreTabs(tabs, activeTabId, projects, sessions);

        // Interrupted wizard takes priority over empty-projects onboarding.
        const recovery = await desktopRpc.request.getWizardRecovery().catch(() => null);
        if (recovery && currentSession && settings.mode === "rookie") {
          if (recovery.live) {
            useAgentStore.getState().patchWizard({
              sessionId: recovery.sessionId,
              selectedTemplateId: recovery.templateId,
              description: recovery.description ?? "",
              progressLines: recovery.progressLines,
              projectPath: recovery.projectPath ?? null,
              wizardError: recovery.uiStep === "error" ? recovery.lastError ?? null : null,
              recoveryMode: false,
              recoveryBlocked: false,
              step: recovery.uiStep ?? "working",
              pendingRequestId: recovery.pendingRequestId ?? null,
              envelope: recovery.envelope ?? null,
              retryAttempt: recovery.retryAttempt ?? 0,
            });
          } else {
            useAgentStore.getState().hydrateWizardFromRecovery({
              sessionId: recovery.sessionId,
              templateId: recovery.templateId,
              description: recovery.description,
              progressLines: recovery.progressLines,
              projectPath: recovery.projectPath ?? null,
              wizardError: recovery.lastError ?? recovery.blockedReason ?? null,
              recoveryBlocked: !recovery.resumable,
              preferredModel: recovery.preferredModel,
            });
          }
          useAgentStore.getState().setOnboardingVisible(true);
          setShowOnboarding(true);
        } else if (currentSession && settings.mode === undefined) {
          // First launch — show mode choice
          setShowModeChoice(true);
        } else if (currentSession && settings.mode === "rookie" && tabs.length === 0 && projects.length === 0) {
          // Rookie mode with no existing projects — show onboarding
          useAgentStore.getState().setOnboardingVisible(true);
          setShowOnboarding(true);
        }
        logger.info("Renderer init complete", {
          hasSession: Boolean(currentSession),
          tabCount: tabs.length,
          mode: settings.mode,
          wizardRecovery: Boolean(recovery),
        });
      } catch (error) {
        logger.error("Renderer init failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setIsLoading(false);
      }
    }
    void init();
  }, [setSession, setSettings, restoreTabs]);

  useEffect(() => {
    const onSessionChanged = (nextSession?: Session) => setSession(nextSession);
    const onActivationComplete = (nextSession?: Session) => setSession(nextSession);
    const onUpdateStatus = (status: { status: string; message: string }) => {
      setUpdateStatus(status);
      if (status.status === "toggle-sidebar") {
        useAgentStore.getState().toggleSidebar();
      }
      if (status.status === "open-model-selector") {
        useAgentStore.getState().setModelSelectorOpen(true);
      }
    };
    const onTabsRestored = ({
      tabs,
      activeTabId,
      projects,
      sessions,
    }: {
      tabs: Tab[];
      activeTabId?: TabId;
      projects: string[];
      sessions: PersistedSession[];
    }) => restoreTabs(tabs, activeTabId, projects, sessions);
    const onTabCreated = ({ tab }: { tab: Tab }) => addTab(tab);
    const onTabClosed = ({ tabId }: { tabId: TabId }) => closeTab(tabId);
    const onTabActivated = ({ tabId }: { tabId: TabId }) => activateTab(tabId);
    const onTabFolderChanged = ({ tabId, folderPath, projectRoot }: { tabId: TabId; folderPath?: string; projectRoot?: string }) => {
      if (folderPath) setProjectForTab(tabId, projectRoot ?? folderPath);
    };
    const onProjectsChanged = ({ projects }: { projects: string[] }) => setProjects(projects);
    const onSessionsChanged = ({ sessions }: { sessions: PersistedSession[] }) =>
      setSessions(sessions);
    const onProjectOpened = ({
      folderPath,
      projectRoot,
      projects,
    }: {
      folderPath: string;
      projectRoot: string;
      projects: string[];
    }) => handleProjectOpened(projectRoot, projects);
    desktopRpc.addMessageListener("sessionChanged", onSessionChanged);
    desktopRpc.addMessageListener("activationComplete", onActivationComplete);
    desktopRpc.addMessageListener("updateStatus", onUpdateStatus);
    desktopRpc.addMessageListener("tabsRestored", onTabsRestored);
    desktopRpc.addMessageListener("tabCreated", onTabCreated);
    desktopRpc.addMessageListener("tabClosed", onTabClosed);
    desktopRpc.addMessageListener("tabActivated", onTabActivated);
    desktopRpc.addMessageListener("tabFolderChanged", onTabFolderChanged);
    desktopRpc.addMessageListener("projectsChanged", onProjectsChanged);
    desktopRpc.addMessageListener("sessionsChanged", onSessionsChanged);
    desktopRpc.addMessageListener("projectOpened", onProjectOpened);

    return () => {
      desktopRpc.removeMessageListener("sessionChanged", onSessionChanged);
      desktopRpc.removeMessageListener("activationComplete", onActivationComplete);
      desktopRpc.removeMessageListener("updateStatus", onUpdateStatus);
      desktopRpc.removeMessageListener("tabsRestored", onTabsRestored);
      desktopRpc.removeMessageListener("tabCreated", onTabCreated);
      desktopRpc.removeMessageListener("tabClosed", onTabClosed);
      desktopRpc.removeMessageListener("tabActivated", onTabActivated);
      desktopRpc.removeMessageListener("tabFolderChanged", onTabFolderChanged);
      desktopRpc.removeMessageListener("projectsChanged", onProjectsChanged);
      desktopRpc.removeMessageListener("sessionsChanged", onSessionsChanged);
      desktopRpc.removeMessageListener("projectOpened", onProjectOpened);
    };
  }, [
    setSession,
    restoreTabs,
    addTab,
    closeTab,
    activateTab,
    setProjectForTab,
    setProjects,
    setSessions,
    handleProjectOpened,
  ]);

  if (isLoading) {
    return (
      <div className="bg-void flex h-full flex-col items-center justify-center gap-4">
        <div className="bg-signal/10 text-signal flex h-14 w-14 items-center justify-center rounded-2xl">
          <Sparkles size={26} strokeWidth={1.5} />
        </div>
        <div className="text-dim flex items-center gap-2 text-sm">
          <Loader2 size={14} className="text-signal animate-spin" />
          Loading Herman…
        </div>
      </div>
    );
  }

  // Not logged in — show login
  if (!session && settings.providers.herman.enabled) {
    return <LoginView />;
  }

  // First launch — mode choice
  if (showModeChoice) {
    return (
      <ModeChoiceView
        onChoose={(mode) => {
          setShowModeChoice(false);
          if (mode === "rookie") {
            useAgentStore.getState().setOnboardingVisible(true);
            setShowOnboarding(true);
          }
        }}
      />
    );
  }

  // Rookie onboarding wizard
  if (showOnboarding) {
    return (
      <OnboardingWizard
        onComplete={() => {
          setShowOnboarding(false);
          useAgentStore.getState().setOnboardingVisible(false);
        }}
        onCancel={() => {
          setShowOnboarding(false);
          useAgentStore.getState().setOnboardingVisible(false);
          setView("home");
        }}
      />
    );
  }

  return (
    <ErrorBoundary>
      {updateStatus && (
        <UpdateBanner status={updateStatus} onDismiss={() => setUpdateStatus(null)} />
      )}
      {settings.mode === "rookie" ? <RookieShell /> : <Shell />}
    </ErrorBoundary>
  );
}

let scanStarted = false;

function ReactScan({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    if (scanStarted) return;
    scanStarted = true;

    void (async () => {
      const isDev = await desktopRpc.request.getDevMode();
      if (!isDev) return;

      const { scan } = await import("react-scan");
      scan({ enabled: true });
    })();
  }, []);

  return children;
}

export function App() {
  return (
    <div className="bg-void h-full w-full">
      <ReactScan>
        <AppContent />
      </ReactScan>
    </div>
  );
}
