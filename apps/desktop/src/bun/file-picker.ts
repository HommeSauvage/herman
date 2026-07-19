import { stat } from "node:fs/promises";
import { basename, extname } from "node:path";

import { Utils } from "electrobun/bun";

import type { OpenFilePickerOptions, PickedFile } from "../shared/rpc.js";

/** Maximum file size (in bytes) for which we'll inline a preview data URL.
 *  Beyond this, the preview is omitted and the chip will fall back to a
 *  generic file-type icon.  5 MB is plenty for thumbnails while keeping
 *  the IPC payload small. */
const PREVIEW_MAX_BYTES = 5 * 1024 * 1024;

/** A small set of well-known MIME types we can confidently derive from
 *  a file extension when the OS doesn't supply one (e.g. files selected
 *  via the native dialog often come back with `application/octet-stream`
 *  or an empty type on Linux).  This mirrors opencode's fallback list. */
const EXTENSION_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  pdf: "application/pdf",
  json: "application/json",
  md: "text/markdown",
  txt: "text/plain",
};

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"]);

/** Best-effort mime detection: trust the OS hint, then fall back to a
 *  well-known extension table.  We avoid full content sniffing because
 *  most attachments we care about (text, code, common formats) already
 *  report a correct mime from the OS. */
function detectMime(filePath: string, osMime: string): string {
  if (osMime && osMime !== "application/octet-stream") {
    return osMime;
  }
  const ext = extname(filePath).slice(1).toLowerCase();
  return EXTENSION_MIME[ext] ?? "application/octet-stream";
}

/** Read a small image file and return a `data:` URL suitable for use as
 *  an `<img src>`.  Returns undefined for non-image files or files
 *  larger than {@link PREVIEW_MAX_BYTES}. */
async function readPreviewDataUrl(
  filePath: string,
  mime: string,
  size: number,
): Promise<string | undefined> {
  if (!IMAGE_MIMES.has(mime)) return undefined;
  if (size > PREVIEW_MAX_BYTES) return undefined;
  try {
    const file = Bun.file(filePath);
    const buffer = await file.arrayBuffer();
    // Re-encode the bytes as base64.  For very large images this can
    // still be expensive, but we cap size above so it's bounded.
    const base64 = Buffer.from(buffer).toString("base64");
    return `data:${mime};base64,${base64}`;
  } catch {
    return undefined;
  }
}

/** Open the native OS file picker and return the list of picked files
 *  with metadata suitable for displaying as attachment chips.  The
 *  caller (renderer) only ever sees absolute paths plus a small
 *  inline preview for image files.  We never read text files here
 *  because the renderer doesn't need their contents — pi-agent
 *  will read them by path. */
export async function openFilePicker(options: OpenFilePickerOptions = {}): Promise<PickedFile[]> {
  const { multiple = true, defaultPath } = options;

  let paths: string[];
  try {
    paths = await Utils.openFileDialog({
      startingFolder: defaultPath ?? undefined,
      // "*" / "public.item" lets the dialog accept any file.  pi-agent
      //  is happy to read anything, so we don't restrict by extension.
      allowedFileTypes: "*",
      canChooseFiles: true,
      canChooseDirectory: false,
      allowsMultipleSelection: multiple,
    });
  } catch (error) {
    // The user dismissing the dialog is not an error; surface everything
    // else for the UI to display.
    throw new Error(
      `File picker failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!paths || paths.length === 0) return [];

  // `Utils.openFileDialog` on some platforms returns a single-element
  // array containing a comma-joined string.  Detect and split that case.
  const normalized = paths.flatMap((p) => (p.includes(",") ? p.split(",") : [p]));

  const results: PickedFile[] = [];
  for (const filePath of normalized) {
    const trimmed = filePath.trim();
    if (!trimmed) continue;
    try {
      const info = await stat(trimmed);
      if (!info.isFile()) continue; // skip directories the user might have selected
      const name = basename(trimmed);
      // The native picker doesn't give us a mime, so we derive one from
      // the extension.  Good enough for the chip's icon and for the
      // preview gate below.
      const mime = detectMime(trimmed, "");
      const previewDataUrl = await readPreviewDataUrl(trimmed, mime, info.size);
      results.push({
        path: trimmed,
        name,
        size: info.size,
        mime,
        previewDataUrl,
      });
    } catch {
      // Skip files we can't stat (broken symlinks, permission errors).
      // We don't abort the whole batch — the user probably wants the
      // remaining files to still appear as attachments.
    }
  }

  return results;
}
