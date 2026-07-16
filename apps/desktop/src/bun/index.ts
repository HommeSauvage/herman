import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getLogger } from "@logtape/logtape";
import { BrowserWindow, BrowserView, ApplicationMenu, Updater, Utils } from "electrobun/bun";
import type { ApplicationMenuItemConfig } from "electrobun/bun";

import { HERMAN_REFRESH_MODELS_MESSAGE } from "@herman/rpc/agent";
import { config } from "../env.js";
import { configureLogging } from "../logging.js";
import { parseAdEventFromNotify } from "../shared/agent-protocol.js";
import type { HermanDesktopRPC, ProviderMetadata, TabId, FileDiff } from "../shared/rpc.js";
import { startDeviceActivation, checkDeviceActivation } from "./activation.js";
import { AdTelemetry } from "./ad-telemetry.js";
import { AgentProcessManager } from "./agent-process-manager.js";
import { hermanDir } from "./app-paths.js";
import { syncAgentConfig } from "./agent-config-sync.js";
import {
  getProjectFoldersFromPiSessions,
  listAllPiSessions,
  listPiSessionsForProject,
} from "./pi-sessions.js";
import { clearAllComposerDrafts } from "./composer-drafts.js";
import {
  getCredential,
  getCredentialStoreError,
  removeCredential,
  setCredential,
} from "./credentials.js";
import { reportImpression, reportAdClick } from "./herman-api.js";
import { cancelOAuthLogin, pollOAuthLogin, startOAuthLogin } from "./oauth.js";
import { findProjectFiles } from "./project-files.js";
import { openFilePicker } from "./file-picker.js";
import { loadState, saveSession, clearSession, clearAllState } from "./session.js";
import { loadSettings, saveSettings } from "./settings.js";
import { rewindManager, getUserMessageIds } from "./rewind-manager.js";
import { resolveShellEnv } from "./shell-env.js";
import { clearAllTabHistory } from "./tab-history.js";
import {
  startDevServer,
  startAllDevServers,
  stopDevServer,
  getDevServerStatus,
  stopAllDevServers,
  setPreviewStatusHandler,
} from "./preview-server.js";
import { readProjectManifest, setupProjectRepo } from "./project-manifest.js";
import { checkRequirements } from "./requirements.js";
import { getGalleryTemplates as loadGalleryTemplates, resolveTemplateManifest } from "./template-registry.js";
import { WizardSessionManager } from "./wizard-session.js";
import { listAllSkills, installSkill, removeSkill, searchSkills, installSkillFromCommand, setSkillEnabled as toggleSkill } from "./skills.js";
import { detectInstallCommand, getSessionChanges, removeSessionWorktree } from "./worktree.js";
import {
  loadWindowState,
  saveWindowState,
  resolveFrame,
  clearWindowState,
} from "./window-state.js";

await configureLogging();
const logger = getLogger(["herman-desktop", "main"]);

process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception in main process", {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
});

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection in main process", {
    error: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

resolveShellEnv();
logger.info("Herman desktop main process starting", { authUrl: config.authUrl });

const BUILTIN_PROVIDERS: ProviderMetadata[] = [
  { id: "herman", name: "Herman", authMethods: [], isHerman: true, source: "herman" },
  {
    id: "openai",
    name: "OpenAI",
    authMethods: [{ type: "apiKey", label: "API key" }],
    source: "builtin",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    authMethods: [
      { type: "oauth", label: "Claude Pro/Max subscription" },
      { type: "apiKey", label: "API key" },
    ],
    source: "builtin",
  },
  {
    id: "google",
    name: "Google",
    authMethods: [{ type: "apiKey", label: "API key" }],
    source: "builtin",
  },
  {
    id: "groq",
    name: "Groq",
    authMethods: [{ type: "apiKey", label: "API key" }],
    source: "builtin",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    authMethods: [{ type: "apiKey", label: "API key" }],
    source: "builtin",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    authMethods: [{ type: "apiKey", label: "API key" }],
    source: "builtin",
  },
  {
    id: "mistral",
    name: "Mistral",
    authMethods: [{ type: "apiKey", label: "API key" }],
    source: "builtin",
  },
  {
    id: "together",
    name: "Together AI",
    authMethods: [{ type: "apiKey", label: "API key" }],
    source: "builtin",
  },
  {
    id: "fireworks",
    name: "Fireworks",
    authMethods: [{ type: "apiKey", label: "API key" }],
    source: "builtin",
  },
  {
    id: "custom",
    name: "Custom provider",
    authMethods: [{ type: "apiKey", label: "API key" }],
    source: "custom",
  },
];

let desktopSettings = await loadSettings();

function isHermanEnabled(): boolean {
  return desktopSettings.providers.herman.enabled;
}

/** Read herman-models-cache.json written by the agent Herman extension. */
function readHermanModelsCache(): string[] {
  try {
    const cachePath = join(hermanDir(), "herman-models-cache.json");
    if (!existsSync(cachePath)) return [];
    const raw = readFileSync(cachePath, "utf-8");
    const cache = JSON.parse(raw) as { models?: Array<{ id?: string }> };
    if (!Array.isArray(cache.models)) return [];
    return cache.models
      .map((m) => (typeof m.id === "string" && m.id ? `herman/${m.id}` : null))
      .filter((id): id is string => Boolean(id));
  } catch (error) {
    logger.debug("Failed to read Herman models cache", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

function getMode() {
  return desktopSettings.mode;
}

async function syncAgentConfigAndRefreshAgents(): Promise<void> {
  await syncAgentConfig();
  void agentProcessManager.refreshSession();
}

function assertRevertAllowed(): void {
  if (getMode() !== "rookie") {
    throw new Error("Undo is only available in Rookie mode.");
  }
}

const windowState = await loadWindowState();
const frame = resolveFrame(windowState.frame);

function buildApplicationMenu(): ApplicationMenuItemConfig[] {
  return [
    {
      label: "Herman",
      submenu: [
        { label: "About Herman", action: "about" },
        { type: "separator" },
        { label: "Check for Updates", action: "check-for-update" },
        { type: "separator" },
        { label: "Quit Herman", accelerator: "Cmd+Q", action: "quit" },
      ],
    },
    {
      label: "File",
      submenu: [
        { label: "New Tab", accelerator: "CmdOrCtrl+T", action: "file.new-tab" },
        { label: "Close Tab", accelerator: "CmdOrCtrl+W", action: "file.close-tab" },
        { type: "separator" },
        { label: "Open Project Folder", accelerator: "CmdOrCtrl+O", action: "file.open-folder" },
        { type: "separator" },
        { label: "Close Window", action: "close-window" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { label: "Toggle Sidebar", accelerator: "CmdOrCtrl+B", action: "view.toggle-sidebar" },
        { type: "separator" },
        { label: "Zoom In", accelerator: "CmdOrCtrl+Plus", action: "zoom-in" },
        { label: "Zoom Out", accelerator: "CmdOrCtrl+-", action: "zoom-out" },
        { label: "Actual Size", accelerator: "CmdOrCtrl+0", action: "zoom-reset" },
      ],
    },
    {
      label: "Tab",
      submenu: [
        { label: "Next Tab", accelerator: "CmdOrCtrl+Shift+]", action: "tab.next" },
        { label: "Previous Tab", accelerator: "CmdOrCtrl+Shift+[", action: "tab.previous" },
        { type: "separator" },
        { label: "Select Tab 1", accelerator: "CmdOrCtrl+1", action: "tab.select-1" },
        { label: "Select Tab 2", accelerator: "CmdOrCtrl+2", action: "tab.select-2" },
        { label: "Select Tab 3", accelerator: "CmdOrCtrl+3", action: "tab.select-3" },
        { label: "Select Tab 4", accelerator: "CmdOrCtrl+4", action: "tab.select-4" },
        { label: "Select Tab 5", accelerator: "CmdOrCtrl+5", action: "tab.select-5" },
        { label: "Select Tab 6", accelerator: "CmdOrCtrl+6", action: "tab.select-6" },
        { label: "Select Tab 7", accelerator: "CmdOrCtrl+7", action: "tab.select-7" },
        { label: "Select Tab 8", accelerator: "CmdOrCtrl+8", action: "tab.select-8" },
        { label: "Select Tab 9", accelerator: "CmdOrCtrl+9", action: "tab.select-9" },
      ],
    },
    {
      label: "Session",
      submenu: [
        { label: "Abort Agent", accelerator: "CmdOrCtrl+.", action: "session.abort" },
        { label: "Set Preferred Model", action: "session.set-model" },
        ...(isHermanEnabled()
          ? ([
              { type: "separator" as const },
              { label: "Sign Out" as const, action: "session.sign-out" as const },
            ] as const)
          : []),
      ],
    },
    ...(config.devUrl
      ? [
          {
            label: "Developer",
            submenu: [
              {
                label: "Reset App State",
                action: "dev.reset",
              },
              {
                label: "Send Test Notification",
                action: "dev.test-notification",
              },
            ],
          },
        ]
      : []),
  ];
}

ApplicationMenu.setApplicationMenu(buildApplicationMenu());

ApplicationMenu.on("application-menu-clicked", (event) => {
  const menuEvent = event as { data: { action?: string } };
  handleMenuAction(menuEvent.data.action);
});

const mainRPC = BrowserView.defineRPC<HermanDesktopRPC>({
  maxRequestTime: 30_000,
  handlers: {
    requests: {
      startDeviceActivation: async () => {
        logger.info("Starting device activation");
        try {
          const code = await startDeviceActivation();
          logger.info("Device activation code received", { verificationUri: code.verificationUri });
          beginActivationPolling(code);
          return code;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.error("Failed to start device activation", { error: message });
          throw error;
        }
      },
      checkDeviceActivation: async ({ deviceCode }) => {
        logger.trace("Checking device activation", { deviceCode: deviceCode.slice(0, 8) });
        return checkDeviceActivation(deviceCode);
      },
      getSession: async () => {
        const state = await loadState();
        return state.session;
      },
      signOut: async () => {
        await doSignOut();
      },
      copyToClipboard: async ({ text }) => {
        Utils.clipboardWriteText(text);
      },
      openExternal: async ({ url }) => {
        Utils.openExternal(url);
      },
      getVersion: async () => {
        const info = await Updater.getLocalInfo();
        return {
          version: info.version,
          hash: info.hash,
          channel: info.channel,
        };
      },
      getDevMode: async () => {
        return Boolean(config.devUrl);
      },
      checkForUpdate: async () => {
        const info = await Updater.checkForUpdate();
        return {
          updateAvailable: info.updateAvailable,
          version: info.version,
          error: info.error,
        };
      },
      downloadUpdate: async () => {
        await Updater.downloadUpdate();
      },
      applyUpdate: async () => {
        await Updater.applyUpdate();
      },
      createTab: async ({ folderPath, title }) => {
        logger.trace("Creating tab", { folderPath, title });
        const tab = await agentProcessManager.createTab(folderPath, title);
        webviewRpc.send.tabCreated({ tab });
        webviewRpc.send.tabActivated({ tabId: tab.id });
        notifyProjectsChanged();
        notifySessionsChanged();
        return tab;
      },
      closeTab: async ({ tabId }) => {
        logger.trace("Closing tab", { tabId });
        const newActiveId = await agentProcessManager.closeTab(tabId);
        webviewRpc.send.tabClosed({ tabId });
        notifySessionsChanged();
        if (pendingNotificationTabId === tabId) {
          pendingNotificationTabId = undefined;
        }
        if (newActiveId) {
          webviewRpc.send.tabActivated({ tabId: newActiveId });
        }
      },
      activateTab: async ({ tabId }) => {
        logger.trace("Activating tab", { tabId });
        await agentProcessManager.activateTab(tabId);
        webviewRpc.send.tabActivated({ tabId });
        if (pendingNotificationTabId && pendingNotificationTabId !== tabId) {
          pendingNotificationTabId = undefined;
        }
      },
      setTabFolder: async ({ tabId, folderPath }) => {
        logger.trace("Setting tab folder", { tabId, folderPath });
        return agentProcessManager.setTabFolder(tabId, folderPath);
      },
      selectTabProject: async ({ tabId, folderPath }) => {
        logger.trace("Selecting tab project", { tabId, folderPath });
        return agentProcessManager.selectTabProject(tabId, folderPath);
      },
      getTabs: async () => {
        await agentProcessManager.waitForRestore();
        return agentProcessManager.getTabs();
      },
      getProjectsAndSessions: async () => {
        await agentProcessManager.waitForRestore();
        return agentProcessManager.getProjectsAndSessions();
      },
      getProjectSessions: async ({ folderPath }) => {
        const sessions = await listPiSessionsForProject(folderPath);
        return { sessions };
      },
      getAllPiSessions: async () => {
        const sessions = await listAllPiSessions();
        const projects = await getProjectFoldersFromPiSessions();
        return { projects, sessions };
      },
      openProject: async ({ folderPath }) => {
        logger.trace("Opening project", { folderPath });
        const result = await agentProcessManager.openProject(folderPath);
        if (result.folderPath) {
          notifyProjectOpened(result.folderPath, result.projectRoot ?? result.folderPath);
        }
        return result;
      },
      closeProject: async ({ folderPath }) => {
        logger.trace("Closing project", { folderPath });
        await agentProcessManager.closeProject(folderPath);
        notifyProjectsChanged();
        notifySessionsChanged();
      },
      openSession: async ({ sessionId }) => {
        logger.trace("Opening session", { sessionId });
        const tab = await agentProcessManager.openSession(sessionId);
        if (tab) {
          webviewRpc.send.tabCreated({ tab });
          webviewRpc.send.tabActivated({ tabId: tab.id });
          const hydration = agentProcessManager.getMessageHydrationResult(tab.id);
          if (hydration) {
            webviewRpc.send.tabMessagesHydrated({ tabId: tab.id, ...hydration });
          }
          notifySessionsChanged();
        }
        return tab;
      },
      openPiSession: async ({ folderPath, piSessionId }) => {
        logger.trace("Opening pi session as tab", { folderPath, piSessionId });
        const tab = await agentProcessManager.openPiSession(folderPath, piSessionId);
        webviewRpc.send.tabCreated({ tab });
        webviewRpc.send.tabActivated({ tabId: tab.id });
        notifyProjectsChanged();
        notifySessionsChanged();
        return tab;
      },
      retryTabMessageHydration: async ({ tabId }) => {
        logger.debug("Retrying tab message hydration", { tabId });
        return agentProcessManager.retryTabMessageHydration(tabId);
      },
      setComposerDraft: async ({ tabId, value }) => {
        logger.trace("Setting composer draft", { tabId });
        await agentProcessManager.setComposerDraft(tabId, value);
      },
      findProjectFiles: async ({ folderPath, query, includeDirectories }) => {
        logger.trace("Finding project files", { folderPath, query });
        const paths = await findProjectFiles(folderPath, query, includeDirectories);
        return { paths };
      },
      openFilePicker: async (options) => {
        logger.trace("Opening file picker", { options });
        const files = await openFilePicker(options);
        return { files };
      },
      agentRequest: async ({ tabId, command }) => {
        logger.debug("Agent request from renderer", { tabId, commandType: command.type });
        return agentProcessManager.sendCommand(tabId, command);
      },
      abortAgent: async ({ tabId }) => {
        logger.info("Aborting agent", { tabId });
        agentProcessManager.abortTab(tabId);
      },
      restartAgent: async ({ tabId }) => {
        logger.info("Restarting agent", { tabId });
        await agentProcessManager.restartTabAgent(tabId);
      },
      previewRevertTab: async ({ tabId, messageIndex }) => {
        assertRevertAllowed();
        logger.info("Previewing revert for tab", { tabId, messageIndex });
        return agentProcessManager.previewRevertTab(tabId, messageIndex);
      },
      revertTab: async ({ tabId, messageIndex }) => {
        assertRevertAllowed();
        logger.info("Reverting tab to message", { tabId, messageIndex });
        const tab = await agentProcessManager.revertTab(tabId, messageIndex);

        // Build diff summary from rewind checkpoints.
        let diffSummary: string | undefined;
        if (tab.revertMessageId) {
          const userMessageIds = getUserMessageIds(tab.messages);
          diffSummary = await rewindManager
            .getRevertDiffSummary(tabId, tab.revertMessageId, userMessageIds)
            .catch(() => "");
        }
        return { tab, diffSummary: diffSummary || undefined };
      },
      unrevertTab: async ({ tabId }) => {
        assertRevertAllowed();
        logger.info("Unreverting tab", { tabId });
        const tab = await agentProcessManager.unrevertTab(tabId);
        return { tab };
      },
      commitRevertTab: async ({ tabId, messageIndex }) => {
        assertRevertAllowed();
        logger.info("Committing revert for tab", { tabId, messageIndex });
        const tab = agentProcessManager.commitRevertTab(tabId, messageIndex);
        return { tab };
      },
      getDiff: async ({ tabId, scope }) => {
        let diffs: FileDiff[];
        switch (scope) {
          case "last-message":
            diffs = await rewindManager.getTurnDiff(tabId).catch(() => []);
            break;
          case "everything":
            diffs = await rewindManager.getFullDiff(tabId).catch(() => []);
            break;
          case "working-tree":
            diffs = await rewindManager.getWorkingTreeDiff(tabId).catch(() => []);
            break;
          default:
            diffs = [];
        }
        return { diffs };
      },
      getAgentStatus: async ({ tabId }) => {
        return agentProcessManager.getStatus(tabId);
      },
      getRecentAgentEvents: async ({ tabId }) => {
        return agentProcessManager.getRecentEvents(tabId);
      },
      reportImpression: async (params) => {
        if (!isHermanEnabled()) return;
        logger.trace("Reporting ad impression", {
          campaignId: params.campaignId,
          placement: params.placement,
        });
        const state = await loadState();
        if (!state.session) return;
        const response = await reportImpression(state.session.token, params);
        await handleAuthResponse(response);
      },
      reportAdClick: async (params) => {
        if (!isHermanEnabled()) return { destinationUrl: undefined };
        logger.trace("Reporting ad click", {
          campaignId: params.campaignId,
          placement: params.placement,
        });
        const state = await loadState();
        if (!state.session) return { destinationUrl: undefined };
        const response = await reportAdClick(state.session.token, params);
        const data = await handleAuthResponse<{ destinationUrl?: string }>(response);
        if (data?.destinationUrl) {
          Utils.openExternal(data.destinationUrl);
        }
        return data ?? { destinationUrl: undefined };
      },
      focusWindow: async () => {
        if (win.isMinimized()) {
          win.unminimize();
        }
        win.show();
        win.activate();
      },
      showNativeNotification: async ({ title, body, subtitle, tabId }) => {
        pendingNotificationTabId = tabId;
        Utils.showNotification({ title, body, subtitle });
      },
      getSettings: async () => {
        const state = await loadWindowState();
        return {
          ...desktopSettings,
          credentialStoreError: getCredentialStoreError(),
          settingsActiveTab: state.settingsActiveTab,
        };
      },
      saveSettings: async ({ settings }) => {
        const wasEnabled = isHermanEnabled();
        const { settingsActiveTab, credentialStoreError: _, ...rest } = settings;
        const previousProviders = desktopSettings.providers;
        desktopSettings = rest as typeof desktopSettings;
        await saveSettings(desktopSettings);
        if (settingsActiveTab) {
          await saveWindowState({ settingsActiveTab });
        }
        const providersChanged =
          JSON.stringify(previousProviders) !== JSON.stringify(desktopSettings.providers);
        if (wasEnabled !== isHermanEnabled() || providersChanged) {
          if (wasEnabled !== isHermanEnabled()) {
            ApplicationMenu.setApplicationMenu(buildApplicationMenu());
          }
          if (providersChanged) {
            await syncAgentConfigAndRefreshAgents();
          } else {
            void agentProcessManager.refreshSession();
          }
        }
      },
      getProviderCredentials: async ({ providerId }) => {
        return getCredential(providerId);
      },
      saveProviderCredentials: async ({ providerId, credential, skipRefresh }) => {
        await setCredential(providerId, credential);
        if (!skipRefresh) {
          await syncAgentConfigAndRefreshAgents();
        }
      },
      removeProviderCredentials: async ({ providerId, skipRefresh }) => {
        await removeCredential(providerId);
        if (!skipRefresh) {
          await syncAgentConfigAndRefreshAgents();
        }
      },
      startOAuthLogin: async ({ providerId }) => {
        logger.info("Starting OAuth login", { providerId });
        const { authUrl, state } = await startOAuthLogin(providerId);
        return { authUrl, state };
      },
      pollOAuthLogin: async ({ providerId, state }) => {
        return pollOAuthLogin(providerId, state);
      },
      cancelOAuthLogin: async ({ providerId }) => {
        await cancelOAuthLogin(providerId);
      },
      getAvailableProviders: async () => {
        return BUILTIN_PROVIDERS;
      },
      refreshHermanModels: async ({ tabId }) => {
        agentProcessManager.sendRaw(tabId, {
          type: "prompt",
          message: HERMAN_REFRESH_MODELS_MESSAGE,
        });
      },
      getHermanModelsCache: async () => {
        return { models: readHermanModelsCache() };
      },
      getGalleryTemplates: async () => {
        const templates = await loadGalleryTemplates();
        logger.trace("Returning gallery templates", { count: templates.length });
        return templates;
      },
      getTemplates: async () => {
        // Back-compat alias
        return loadGalleryTemplates();
      },
      resolveTemplateManifest: async ({ templateId }) => {
        return resolveTemplateManifest(templateId);
      },
      checkTemplateRequirements: async ({ templateId }) => {
        const manifest = await resolveTemplateManifest(templateId);
        const results = await checkRequirements(manifest.frontmatter.requirements);
        return { results };
      },
      startWizardSession: async ({ templateId, description, modelId }) => {
        const wizardSessionId = await wizardSessionManager.start(templateId, description, modelId);
        return { wizardSessionId };
      },
      setWizardModel: async ({ wizardSessionId, modelId }) => {
        wizardSessionManager.setModel(wizardSessionId, modelId);
      },
      resumeWizardSession: async ({ wizardSessionId }) => {
        await wizardSessionManager.resume(wizardSessionId);
      },
      getWizardRecovery: async () => {
        return wizardSessionManager.getRecovery();
      },
      discardWizardRecovery: async () => {
        await wizardSessionManager.discardRecovery();
      },
      respondWizardQuestions: async ({ wizardSessionId, requestId, answers }) => {
        wizardSessionManager.respond(wizardSessionId, requestId, answers);
      },
      cancelWizard: async ({ wizardSessionId }) => {
        await wizardSessionManager.cancel(wizardSessionId);
      },
      adoptWizardSession: async ({ projectPath, wizardSessionId }) => {
        const wizard = wizardSessionManager.get(wizardSessionId);

        // Set up a clean git repo and write herman.yaml with the resolved config.
        // This replaces the old agent QA prompt instruction to "make sure the git
        // repository is fresh" and ensures the worktree (created by createTab in
        // rookie mode) includes the manifest.
        const manifest = wizard?.getResolvedManifest();
        if (manifest && projectPath) {
          try {
            await setupProjectRepo(projectPath, manifest);
          } catch (error) {
            // The project is still usable even if repo setup failed.
            // Log and continue — the user should not be blocked from opening.
            logger.warning("setupProjectRepo failed during wizard handoff", {
              projectPath,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        // Stop the wizard bridge; the new tab starts a fresh pi session.
        await wizard?.detach();
        wizardSessionManager.remove(wizardSessionId);

        // Open the finished project directly (no session worktree) so the
        // wizard's uncommitted changes remain visible.
        const tab = await agentProcessManager.adoptWizardSession(projectPath, wizardSessionId);
        webviewRpc.send.tabCreated({ tab });
        webviewRpc.send.tabActivated({ tabId: tab.id });
        notifyProjectsChanged();
        notifySessionsChanged();
        return tab;
      },
      getSessionChanges: async ({ tabId }) => {
        const tab = agentProcessManager.getTab(tabId);
        if (!tab) return { isWorktree: false, changedFiles: 0, canApply: false };
        return getSessionChanges(tab);
      },
      applySession: async ({ tabId }) => {
        const tab = agentProcessManager.getTab(tabId);
        if (!tab || !tab.worktree) {
          return { status: "error" as const, error: "No draft session found" };
        }
        return agentProcessManager.syncSessionToMain(tabId);
      },
      discardSession: async ({ tabId }) => {
        const tab = agentProcessManager.getTab(tabId);
        if (!tab || !tab.worktree) return;
        await stopDevServer(tab.folderPath);
        await removeSessionWorktree(tab);
        const newActiveId = await agentProcessManager.closeTab(tabId);
        webviewRpc.send.tabClosed({ tabId });
        if (newActiveId) {
          webviewRpc.send.tabActivated({ tabId: newActiveId });
        }
        notifySessionsChanged();
      },
      startPreview: async ({ folderPath, serverId, devCommand, devPort, all }) => {
        const manifest = await readProjectManifest(folderPath);
        const installCommand = all ? (manifest?.install ?? detectInstallCommand(folderPath)) : undefined;
        if (all || (!devCommand && !serverId)) {
          if (manifest?.servers?.length) {
            return startAllDevServers(folderPath, manifest.servers, installCommand);
          }
        }
        const server = serverId
          ? manifest?.servers?.find((s) => s.id === serverId)
          : manifest?.primary ?? manifest?.servers?.[0];
        return startDevServer(folderPath, {
          serverId: server?.id ?? serverId ?? "web",
          command: devCommand ?? server?.command,
          port: devPort ?? server?.port,
          exportUrlAs: server?.exportUrlAs,
          primary: true,
          installCommand,
        });
      },
      stopPreview: async ({ folderPath, serverId }) => {
        await stopDevServer(folderPath, serverId);
      },
      restartPreview: async ({ folderPath, serverId, devCommand, devPort, all }) => {
        await stopDevServer(folderPath, serverId);
        const manifest = await readProjectManifest(folderPath);
        if (all || (!devCommand && !serverId)) {
          if (manifest?.servers?.length) {
            return startAllDevServers(folderPath, manifest.servers);
          }
        }
        const server = serverId
          ? manifest?.servers?.find((s) => s.id === serverId)
          : manifest?.primary ?? manifest?.servers?.[0];
        return startDevServer(folderPath, {
          serverId: server?.id ?? serverId ?? "web",
          command: devCommand ?? server?.command,
          port: devPort ?? server?.port,
          exportUrlAs: server?.exportUrlAs,
          primary: true,
        });
      },
      getPreviewStatus: async ({ folderPath, serverId }) => {
        return getDevServerStatus(folderPath, serverId);
      },
      getProjectManifest: async ({ folderPath }) => {
        return readProjectManifest(folderPath);
      },
      getSkills: async ({ projectDir }) => {
        const { loadSettings } = await import("./settings.js");
        const settings = await loadSettings();
        const skills = listAllSkills(projectDir, settings.disabledSkills);
        return { skills };
      },
      installSkill: async ({ name, content }) => {
        return installSkill(name, content);
      },
      searchSkills: async ({ query }) => {
        const results = await searchSkills(query);
        return { results };
      },
      installSkillFromCommand: async ({ command }) => {
        return installSkillFromCommand(command);
      },
      removeSkill: async ({ name }) => {
        removeSkill(name);
      },
      setSkillEnabled: async ({ name, enabled }) => {
        const { loadSettings, saveSettings } = await import("./settings.js");
        const settings = await loadSettings();
        const current = settings.disabledSkills ?? [];
        settings.disabledSkills = toggleSkill(name, enabled, current);
        await saveSettings(settings);
      },
    },
    messages: {
      requestActivation: () => {
        logger.info("Activation requested from renderer");
        beginActivationFromRenderer();
      },
      cancelActivation: () => {
        logger.info("Activation cancelled from renderer");
        stopActivationPolling();
      },
      copyUserCode: () => {
        if (currentActivation) {
          logger.debug("Copying user code to clipboard");
          Utils.clipboardWriteText(currentActivation.userCode);
        }
      },
      openVerificationUrl: () => {
        if (currentActivation) {
          logger.info("Opening verification URL", { url: currentActivation.activationUrl });
          Utils.openExternal(currentActivation.activationUrl);
        }
      },
      signOut: async () => {
        logger.info("Sign out requested from renderer");
        await doSignOut();
      },
      checkForUpdate: async () => {
        logger.info("Checking for update");
        await Updater.checkForUpdate();
      },
      downloadUpdate: async () => {
        logger.info("Downloading update");
        await Updater.downloadUpdate();
      },
      applyUpdate: async () => {
        logger.info("Applying update");
        await Updater.applyUpdate();
      },
      openProject: () => {
        logger.info("Open project requested from renderer");
        void openProjectFolder();
      },
    },
  },
});

const webviewUrl = config.devUrl || "views://main/index.html";

const win = new BrowserWindow({
  title: "Herman",
  url: webviewUrl,
  frame: { x: frame.x, y: frame.y, width: frame.width, height: frame.height },
  titleBarStyle: "hiddenInset",
  trafficLightOffset: { x: 12, y: 10 },
  rpc: mainRPC,
});

const webviewRpc = win.webview.rpc!;

const agentProcessManager = new AgentProcessManager({
  serverUrl: config.serverUrl,
  getToken: async () => {
    const state = await loadState();
    return state.session?.token;
  },
  getHermanEnabled: () => isHermanEnabled(),
  getMode,
  webviewRpc: {
    send: {
      agentEvent: (payload) => {
        const { tabId, event } = payload;
        const adEvent =
          event.type === "extension_ui_request" && event.method === "notify"
            ? parseAdEventFromNotify(event.message)
            : undefined;
        if (adEvent) {
          logger.trace("Ad event from agent", {
            placement: adEvent.placement,
            campaignId: adEvent.campaign.id,
          });
          webviewRpc.send.adEvent({
            tabId,
            placement: adEvent.placement,
            campaign: adEvent.campaign,
          });
        }
        if (event.type === "herman/agent_proxy_error" && event.code === "unauthorized") {
          logger.warning("Agent reported unauthorized; signing out", { tabId });
          void doSignOut();
        }
        webviewRpc.send.agentEvent({ tabId, event });
      },
      agentStatusChanged: (payload) => {
        const { tabId, state, stderr } = payload;
        if (state === "crashed" && stderr) {
          logger.error("Agent crashed", { tabId, stderr: stderr.slice(0, 2000) });
        } else {
          logger.debug("Agent status changed", { tabId, state });
        }
        webviewRpc.send.agentStatusChanged({ tabId, state, stderr });
      },
      tabFolderChanged: (payload) => {
        const { tabId, folderPath } = payload;
        logger.trace("Tab folder changed", { tabId, folderPath });
        webviewRpc.send.tabFolderChanged({ tabId, folderPath });
      },
      sessionsChanged: (payload) => {
        webviewRpc.send.sessionsChanged(payload);
      },
      tabMessagesHydrated: (payload) => {
        webviewRpc.send.tabMessagesHydrated(payload);
      },
    },
  },
});

setPreviewStatusHandler((payload) => {
  webviewRpc.send.previewStatusChanged(payload);
});

const wizardSessionManager = new WizardSessionManager((event) => {
  webviewRpc.send.wizardEvent({ event });
});

// Restore a paused wizard from disk before the renderer asks for recovery.
void wizardSessionManager.restoreFromDisk().catch((error) => {
  logger.warning("Failed to restore wizard checkpoint", { error });
});

let isFocused = false;
let isVisible = true;
let isMinimized = false;
let pendingNotificationTabId: TabId | undefined;
const adTelemetry = new AdTelemetry(
  () => isFocused,
  () => isVisible && !isMinimized,
);

Updater.onStatusChange((entry) => {
  logger.debug("Updater status changed", { status: entry.status, message: entry.message });
  webviewRpc.send.updateStatus({
    status: entry.status,
    message: entry.message,
  });
});

win.on("focus", () => {
  isFocused = true;
  adTelemetry.update();
  webviewRpc.send.adVisibilityChanged(adTelemetry.getVisibility());
  if (pendingNotificationTabId) {
    const tabId = pendingNotificationTabId;
    pendingNotificationTabId = undefined;
    void agentProcessManager.activateTab(tabId).then(() => {
      webviewRpc.send.tabActivated({ tabId });
    });
  }
});
win.on("blur", () => {
  isFocused = false;
  adTelemetry.update();
  webviewRpc.send.adVisibilityChanged(adTelemetry.getVisibility());
});
win.on("show", () => {
  isVisible = true;
  adTelemetry.update();
  webviewRpc.send.adVisibilityChanged(adTelemetry.getVisibility());
});
win.on("hide", () => {
  isVisible = false;
  adTelemetry.update();
  webviewRpc.send.adVisibilityChanged(adTelemetry.getVisibility());
});
win.on("minimize", () => {
  isMinimized = true;
  adTelemetry.update();
  webviewRpc.send.adVisibilityChanged(adTelemetry.getVisibility());
});
win.on("deminimize", () => {
  isMinimized = false;
  adTelemetry.update();
  webviewRpc.send.adVisibilityChanged(adTelemetry.getVisibility());
});
win.on("resize", () => saveFrameDebounced());
win.on("move", () => saveFrameDebounced());

wireNavigationRules(win, webviewUrl);

function notifySessionChanged(session: Awaited<ReturnType<typeof loadState>>["session"]) {
  webviewRpc.send.sessionChanged(session);
}

function notifyProjectsChanged() {
  const { projects } = agentProcessManager.getProjectsAndSessions();
  webviewRpc.send.projectsChanged({ projects });
}

function notifySessionsChanged() {
  const { sessions } = agentProcessManager.getProjectsAndSessions();
  webviewRpc.send.sessionsChanged({ sessions });
}

function notifyProjectOpened(folderPath: string, projectRoot: string) {
  const { projects } = agentProcessManager.getProjectsAndSessions();
  webviewRpc.send.projectOpened({ folderPath, projectRoot, projects });
}

async function openProjectFolder() {
  const result = await agentProcessManager.openProject();
  if (result.folderPath) {
    notifyProjectOpened(result.folderPath, result.projectRoot ?? result.folderPath);
  }
}

async function handleAuthResponse<T>(response: Response): Promise<T | undefined> {
  if (response.status === 401) {
    logger.warning("Server returned 401; signing out");
    await doSignOut();
    return undefined;
  }
  if (!response.ok) {
    logger.warning("Server request failed", {
      status: response.status,
      statusText: response.statusText,
    });
    return undefined;
  }
  try {
    return (await response.json()) as T;
  } catch (error) {
    logger.warning("Failed to parse server response", {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

async function doSignOut() {
  logger.info("Signing out");
  await clearSession();
  await agentProcessManager.clearAllTabs();
  notifySessionChanged(undefined);
}

async function resetAppState() {
  logger.info("Resetting app state");
  stopActivationPolling();
  await clearAllState();
  await clearWindowState();
  await clearAllTabHistory();
  await clearAllComposerDrafts();
  await agentProcessManager.clearAllTabs();
  notifySessionChanged(undefined);
  const { tabs, activeTabId, projects, sessions } = await agentProcessManager.restore();
  webviewRpc.send.tabsRestored({ tabs, activeTabId, projects, sessions });
  if (activeTabId) {
    webviewRpc.send.tabActivated({ tabId: activeTabId });
  }
}

type ActivationState = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  activationUrl: string;
  expiresAt: number;
  interval: number;
};

function buildActivationUrl(verificationUri: string, userCode: string): string {
  const url = new URL(verificationUri);
  url.searchParams.set("user_code", userCode);
  return url.toString();
}

let currentActivation: ActivationState | null = null;
let activationTimer: ReturnType<typeof setTimeout> | null = null;

async function beginActivationFromRenderer() {
  const code = await startDeviceActivation();
  beginActivationPolling(code);
  webviewRpc.send.updateStatus({
    status: "activation-code",
    message: `Your code is ${code.userCode}`,
  });
  if (currentActivation) {
    Utils.openExternal(currentActivation.activationUrl);
  }
}

function stopActivationPolling() {
  if (activationTimer) {
    clearTimeout(activationTimer);
    activationTimer = null;
  }
  currentActivation = null;
}

function beginActivationPolling(code: Awaited<ReturnType<typeof startDeviceActivation>>) {
  stopActivationPolling();
  currentActivation = {
    deviceCode: code.deviceCode,
    userCode: code.userCode,
    verificationUri: code.verificationUri,
    activationUrl: buildActivationUrl(code.verificationUri, code.userCode),
    expiresAt: Date.now() + code.expiresIn * 1000,
    interval: code.interval * 1000,
  };
  scheduleActivationPoll();
}

function scheduleActivationPoll() {
  if (!currentActivation) return;
  activationTimer = setTimeout(pollActivation, currentActivation.interval);
}

async function pollActivation() {
  if (!currentActivation) return;

  if (Date.now() > currentActivation.expiresAt) {
    logger.info("Activation code expired");
    stopActivationPolling();
    webviewRpc.send.updateStatus({
      status: "activation-expired",
      message: "The activation code expired. Please request a new one.",
    });
    return;
  }

  logger.trace("Polling device activation");
  const result = await checkDeviceActivation(currentActivation.deviceCode);

  if (result.status === "unauthorized") {
    logger.info("Device activation unauthorized");
    stopActivationPolling();
    await doSignOut();
    return;
  }

  if (result.status === "authorized" && result.accessToken) {
    logger.info("Device activation authorized");
    const session = { token: result.accessToken };
    await saveSession(session);
    stopActivationPolling();
    try {
      await agentProcessManager.refreshSession();
      notifySessionChanged(session);
      webviewRpc.send.activationComplete(session);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("Failed to refresh agent sessions after activation", { error: message });
      const activeTabId = agentProcessManager.getActiveTabId();
      if (activeTabId) {
        webviewRpc.send.agentStatusChanged({
          tabId: activeTabId,
          state: "crashed",
          stderr: message,
        });
      }
    }
    return;
  }

  if (result.status === "error") {
    logger.error("Device activation error", { error: result.error });
    stopActivationPolling();
    webviewRpc.send.updateStatus({
      status: "activation-error",
      message: result.error ?? "Activation failed.",
    });
    return;
  }

  scheduleActivationPoll();
}

async function validateSession(token: string): Promise<boolean> {
  if (!isHermanEnabled()) return true;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(`${config.serverUrl}/api/agent/models`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    return response.status !== 401;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isAbort = error instanceof Error && error.name === "AbortError";
    if (isAbort) {
      logger.debug("Skipping session validation (offline or timed out)", { error: message });
    } else {
      logger.debug("Could not validate session with Herman server", { error: message });
    }
    return true;
  } finally {
    clearTimeout(timeout);
  }
}

async function restoreApp() {
  try {
    // Kick off the shared agent config sync (non-blocking): writes auth/models/
    // settings into ~/.herman/agent and installs bundled extensions once. Tab
    // spawns await it before spawning the subprocess, but UI hydration from
    // session JSONL runs in parallel and is not blocked.
    void syncAgentConfig();

    const state = await loadState();

    if (state.session && !(await validateSession(state.session.token))) {
      logger.warning("Stored session is invalid; clearing session");
      await clearSession();
      state.session = undefined;
    }

    const { tabs, activeTabId, projects, sessions } = await agentProcessManager.restore();
    if (state.session) {
      logger.info("Restoring previous session");
      notifySessionChanged(state.session);
    } else {
      logger.info("No previous session found");
    }

    webviewRpc.send.tabsRestored({ tabs, activeTabId, projects, sessions });
    agentProcessManager.emitMessageHydrationForOpenTabs();
    if (activeTabId) {
      webviewRpc.send.tabActivated({ tabId: activeTabId });
    }
    for (const tab of tabs) {
      webviewRpc.send.tabFolderChanged({ tabId: tab.id, folderPath: tab.folderPath, projectRoot: tab.projectRoot });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Failed to restore app state", { error: message });
    const activeTabId = agentProcessManager.getActiveTabId();
    if (activeTabId) {
      webviewRpc.send.agentStatusChanged({ tabId: activeTabId, state: "crashed", stderr: message });
    }
  }
}

let frameSaveTimer: ReturnType<typeof setTimeout> | null = null;

function saveFrameDebounced() {
  if (frameSaveTimer) clearTimeout(frameSaveTimer);
  frameSaveTimer = setTimeout(async () => {
    const bounds = win.getFrame();
    await saveWindowState({ frame: bounds });
  }, 500);
}

let zoomLevel = 1.0;

async function handleMenuAction(action?: string) {
  if (!action) return;

  switch (action) {
    case "quit": {
      await agentProcessManager.closeAll();
      await stopAllDevServers();
      process.exit();
      break;
    }
    case "close-window":
      win.close();
      break;
    case "about":
      webviewRpc.send.updateStatus({ status: "about", message: "Herman v0.0.1" });
      break;
    case "check-for-update":
      void Updater.checkForUpdate();
      break;
    case "file.new-tab": {
      const tab = await agentProcessManager.createTab();
      webviewRpc.send.tabCreated({ tab });
      webviewRpc.send.tabActivated({ tabId: tab.id });
      break;
    }
    case "file.close-tab": {
      const activeTabId = agentProcessManager.getActiveTabId();
      if (activeTabId) {
        const newActiveId = await agentProcessManager.closeTab(activeTabId);
        webviewRpc.send.tabClosed({ tabId: activeTabId });
        if (newActiveId) {
          webviewRpc.send.tabActivated({ tabId: newActiveId });
        }
      }
      break;
    }
    case "file.open-folder": {
      void openProjectFolder();
      break;
    }
    case "view.toggle-sidebar":
      webviewRpc.send.updateStatus({ status: "toggle-sidebar", message: "" });
      break;
    case "zoom-in":
      zoomLevel = Math.min(zoomLevel + 0.1, 3.0);
      win.webview.setPageZoom(zoomLevel);
      break;
    case "zoom-out":
      zoomLevel = Math.max(zoomLevel - 0.1, 0.5);
      win.webview.setPageZoom(zoomLevel);
      break;
    case "zoom-reset":
      zoomLevel = 1.0;
      win.webview.setPageZoom(zoomLevel);
      break;
    case "tab.next": {
      const nextId = await agentProcessManager.activateNextTab();
      if (nextId) webviewRpc.send.tabActivated({ tabId: nextId });
      break;
    }
    case "tab.previous": {
      const prevId = await agentProcessManager.activatePreviousTab();
      if (prevId) webviewRpc.send.tabActivated({ tabId: prevId });
      break;
    }
    case "tab.select-1":
    case "tab.select-2":
    case "tab.select-3":
    case "tab.select-4":
    case "tab.select-5":
    case "tab.select-6":
    case "tab.select-7":
    case "tab.select-8":
    case "tab.select-9": {
      const index = Number(action.split("-")[1]) - 1;
      const tabId = await agentProcessManager.activateTabAtIndex(index);
      if (tabId) webviewRpc.send.tabActivated({ tabId });
      break;
    }
    case "session.abort": {
      const activeTabId = agentProcessManager.getActiveTabId();
      if (activeTabId) agentProcessManager.abortTab(activeTabId);
      break;
    }
    case "session.set-model":
      webviewRpc.send.updateStatus({ status: "open-model-selector", message: "" });
      break;
    case "session.sign-out":
      void doSignOut();
      break;
    case "dev.reset":
      void resetAppState();
      break;
    case "dev.test-notification": {
      const activeTabId = agentProcessManager.getActiveTabId();
      if (activeTabId) {
        Utils.showNotification({
          title: "Herman",
          body: `Test notification from the Developer menu ${Math.ceil(Math.random() * 100)}`,
          silent: false,
        });
        pendingNotificationTabId = activeTabId;
      }
      break;
    }
  }
}

function extractUrl(detail: unknown): string | undefined {
  if (typeof detail === "string") return detail;
  if (detail && typeof detail === "object" && "url" in detail && typeof detail.url === "string") {
    return detail.url;
  }
  return undefined;
}

function isAllowedNavigation(url: string, allowedOrigin?: string): boolean {
  if (allowedOrigin && url.startsWith(allowedOrigin)) return true;
  return url.startsWith("views://");
}

function wireNavigationRules(mainWindow: BrowserWindow, allowedOrigin?: string) {
  const rules: string[] = [];
  if (allowedOrigin) rules.push(`${allowedOrigin}/*`);
  rules.push("views://*");
  mainWindow.webview.setNavigationRules(rules);

  (mainWindow.webview as { on?: (name: string, handler: (event: unknown) => void) => void }).on?.(
    "will-navigate",
    (event: unknown) => {
      const { data } = event as { data: { detail: unknown }; response?: { allow: boolean } };
      const targetUrl = extractUrl(data.detail);
      if (!targetUrl) {
        (event as { response?: { allow: boolean } }).response = { allow: false };
        return;
      }
      if (isAllowedNavigation(targetUrl, allowedOrigin)) return;

      try {
        Utils.openExternal(targetUrl);
      } catch (err) {
        logger.warning("Failed to open external URL", {
          url: targetUrl,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      (event as { response?: { allow: boolean } }).response = { allow: false };
    },
  );

  (mainWindow.webview as { on?: (name: string, handler: (event: unknown) => void) => void }).on?.(
    "new-window-open",
    (event: unknown) => {
      const { data } = event as { data: { detail: unknown }; response?: { allow: boolean } };
      const targetUrl = extractUrl(data.detail);
      if (!targetUrl) {
        (event as { response?: { allow: boolean } }).response = { allow: false };
        return;
      }
      if (isAllowedNavigation(targetUrl, allowedOrigin)) return;

      try {
        Utils.openExternal(targetUrl);
      } catch (err) {
        logger.warning("Failed to open external URL", {
          url: targetUrl,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      (event as { response?: { allow: boolean } }).response = { allow: false };
    },
  );
}

restoreApp();
