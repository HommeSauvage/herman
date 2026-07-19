/**
 * Compatibility facade for the preview subsystem.
 * Implementation lives in `./preview/`.
 */
export {
  __getPreviewManagerForTests,
  buildExportEnv,
  displayUrlForPort,
  type EnsurePreviewOpts,
  ensurePreviewStarted,
  findFreePort,
  folderScope,
  getDevServerStatus,
  PortRegistry,
  type PortReservation,
  PREVIEW_READY_POLL_MS,
  PREVIEW_READY_TIMEOUT_MS,
  type PreviewStartRequest,
  type PreviewStartResponse,
  previewPortRegistry,
  probeUrlForPort,
  restartPreview,
  setPreviewLineHandler,
  setPreviewLogHandler,
  setPreviewStatusHandler,
  stopAllDevServers,
  stopAllPreviewsForProject,
  stopPreviewsForScope,
  tabScope,
  waitForReady,
  wizardScope,
} from "./preview/index.js";
