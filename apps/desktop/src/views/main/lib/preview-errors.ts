import type { PreviewRuntimeError } from "../components/preview-error-banner.js";

export const MAX_RUNTIME_ERRORS = 30;
export const MAX_ERROR_MESSAGE_CHARS = 2000;
export const MAX_FORMATTED_ERRORS_CHARS = 12_000;

export function truncateMessage(message: string, max = MAX_ERROR_MESSAGE_CHARS): string {
  if (message.length <= max) return message;
  return message.slice(0, max);
}

export function appendRuntimeError(
  prev: PreviewRuntimeError[],
  entry: Omit<PreviewRuntimeError, "id">,
  nextId: number,
): { errors: PreviewRuntimeError[]; nextId: number; changed: boolean } {
  const message = truncateMessage(entry.message);
  const last = prev[prev.length - 1];
  if (last && last.source === entry.source && last.message === message) {
    return { errors: prev, nextId, changed: false };
  }
  const next = [
    ...prev,
    {
      ...entry,
      id: `${entry.source}-${nextId}`,
      message,
    },
  ];
  return {
    errors: next.length > MAX_RUNTIME_ERRORS ? next.slice(-MAX_RUNTIME_ERRORS) : next,
    nextId: nextId + 1,
    changed: true,
  };
}

export function formatRuntimeErrors(errors: PreviewRuntimeError[]): string {
  return errors
    .map((e) => `[${e.source}] ${e.message}`)
    .join("\n\n")
    .slice(0, MAX_FORMATTED_ERRORS_CHARS);
}

export function buildAskHermanPrompt(
  error: string,
  context: "preview" | "save" | "runtime",
): string {
  if (context === "preview") {
    return `The preview server for this project failed to start or crashed with this error:

${error}

Please investigate and fix it so the preview can run again. Check the project configuration, dependencies, install command, and dev server setup.`;
  }
  if (context === "runtime") {
    return `The server is showing errors. Please investigate and fix them.

Errors:
${error}

Check both the frontend (browser/runtime) and the dev server. After fixing, the preview should load without these errors.`;
  }
  return `Saving the draft changes to the main project failed with this error:

${error}

Please fix the issue so the changes can be applied safely.`;
}
