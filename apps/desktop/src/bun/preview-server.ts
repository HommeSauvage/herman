/**
 * Compatibility facade for the preview subsystem.
 * Implementation lives in `./preview/`.
 */
export {
  PREVIEW_READY_TIMEOUT_MS,
  PREVIEW_READY_POLL_MS,
  probeUrlForPort,
  findFreePort,
  buildExportEnv,
  displayUrlForPort,
  waitForReady,
  setPreviewStatusHandler,
  setPreviewLogHandler,
  setPreviewLineHandler,
  ensurePreviewStarted,
  restartPreview,
  stopPreviewsForScope,
  stopAllPreviewsForProject,
  stopAllDevServers,
  getDevServerStatus,
  tabScope,
  folderScope,
  wizardScope,
  PortRegistry,
  previewPortRegistry,
  __getPreviewManagerForTests,
  type EnsurePreviewOpts,
  type PreviewStartResponse,
  type PreviewStartRequest,
  type PortReservation,
} from "./preview/index.js";
