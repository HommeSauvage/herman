import { ArrowLeft, BookOpen, FileText, Loader2, Sparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { getLogger } from "@logtape/logtape";

import { cn } from "@herman/ui/lib/utils";

import type { ProjectDoc } from "../../../shared/rpc.js";
import { getProjectName } from "../../../shared/tab-utils.js";
import { desktopRpc } from "../lib/desktop-rpc.js";
import { parseMarkdown, parseMarkdownSync } from "../lib/markdown-parser.js";
import { ContentWidth, SectionLabel, SignalButton, proseClasses } from "./ui/index.js";

const logger = getLogger(["herman-desktop", "view", "wizard-docs"]);

function docBaseName(href: string): string | null {
  const match = href.match(/([^/]+\.md)(?:#.*)?$/i);
  return match?.[1] ?? null;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Render markdown to sanitized HTML. A Shiki/highlighter failure must not
 * block reading — fall back to the sync parser (no syntax highlighting),
 * then to escaped plain text.
 */
async function renderDocHtml(file: string, content: string): Promise<string> {
  try {
    return await parseMarkdown(content);
  } catch (error) {
    logger.warning("Async markdown parse failed; using sync fallback", {
      file,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    return parseMarkdownSync(content);
  } catch (error) {
    logger.error("Sync markdown parse failed; rendering plain text", {
      file,
      error: error instanceof Error ? error.message : String(error),
    });
    return `<pre>${escapeHtml(content)}</pre>`;
  }
}

export function WizardDocsView({
  projectPath,
  onBack,
  onOpenProject,
}: {
  projectPath: string;
  onBack: () => void;
  onOpenProject: () => void;
}) {
  const [docs, setDocs] = useState<ProjectDoc[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [htmlCache, setHtmlCache] = useState<Record<string, string>>({});
  const scrollRef = useRef<HTMLDivElement>(null);

  const projectName = getProjectName(projectPath);

  useEffect(() => {
    let cancelled = false;
    desktopRpc.request
      .getProjectDocs({ projectPath })
      .then((result) => {
        if (cancelled) return;
        setDocs(result.docs);
        setSelectedFile((prev) => prev ?? result.docs[0]?.fileName ?? null);
      })
      .catch((err) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("Failed to load project docs", { error: msg });
        setError(msg);
      });
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  const selected = useMemo(
    () => docs?.find((d) => d.fileName === selectedFile) ?? null,
    [docs, selectedFile],
  );

  // Render the selected doc's markdown (async: Shiki + DOMPurify).
  useEffect(() => {
    if (!selected) return;
    const file = selected.fileName;
    if (htmlCache[file]) return;
    let cancelled = false;
    void renderDocHtml(file, selected.content).then((html) => {
      if (cancelled) return;
      setHtmlCache((prev) => (prev[file] ? prev : { ...prev, [file]: html }));
    });
    return () => {
      cancelled = true;
    };
  }, [selected, htmlCache]);

  // Start each doc at the top.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [selectedFile]);

  // In-app navigation for relative .md links; external links open in the
  // browser; every other link is swallowed so a stray anchor can never
  // navigate the webview away from the docs browser.
  const handleContentClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const anchor = (event.target as HTMLElement).closest("a[href]");
      if (!anchor) return;
      event.preventDefault();
      const href = anchor.getAttribute("href") ?? "";
      const mdFile = docBaseName(href);
      if (mdFile && docs?.some((d) => d.fileName === mdFile)) {
        setSelectedFile(mdFile);
        return;
      }
      if (/^https?:\/\//i.test(href)) {
        void desktopRpc.request.openExternal({ url: href });
      }
    },
    [docs],
  );

  const html = selected ? htmlCache[selected.fileName] : undefined;

  return (
    <div className="flex h-full w-full min-w-0 flex-col">
      {/* Header — mimics the Rookie Home session list header */}
      <div className="border-b border-mist px-6 py-3">
        <ContentWidth size="page" className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="text-ghost hover:text-dim flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs transition hover:bg-fog"
          >
            <ArrowLeft size={13} />
            Back
          </button>
          <div className="text-ghost h-4 w-px bg-white/[0.08]" />
          <div className="text-text min-w-0 flex-1 truncate text-sm font-semibold">
            {projectName} Documentation
          </div>
          <SignalButton size="md" glow className="shrink-0" onClick={onOpenProject}>
            <Sparkles size={14} />
            Open Project
          </SignalButton>
        </ContentWidth>
      </div>

      {error ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <p className="text-dim text-sm">Couldn't load the docs: {error}</p>
          <SignalButton size="md" onClick={onOpenProject}>
            Open Project
          </SignalButton>
        </div>
      ) : docs === null ? (
        <div className="flex flex-1 items-center justify-center gap-2">
          <Loader2 size={18} className="text-signal animate-spin" />
          <span className="text-dim text-sm">Loading your docs…</span>
        </div>
      ) : docs.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
          <div className="text-ghost flex h-12 w-12 items-center justify-center rounded-xl bg-white/[0.02]">
            <BookOpen size={20} strokeWidth={1.5} />
          </div>
          <p className="text-dim max-w-xs text-sm">
            No docs were found in this project yet. You can ask Herman about anything instead.
          </p>
          <SignalButton size="md" glow onClick={onOpenProject}>
            <Sparkles size={14} />
            Open Project
          </SignalButton>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* Docs sidebar */}
          <div className="w-60 shrink-0 overflow-y-auto border-r border-mist px-3 py-4">
            <SectionLabel className="px-3 pb-2">Guides</SectionLabel>
            <div className="flex flex-col gap-0.5">
              {docs.map((doc) => {
                const active = doc.fileName === selectedFile;
                return (
                  <button
                    key={doc.fileName}
                    onClick={() => setSelectedFile(doc.fileName)}
                    className={cn(
                      "flex items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition",
                      active ? "bg-fog text-text" : "text-dim hover:bg-fog hover:text-text",
                    )}
                  >
                    <FileText
                      size={14}
                      strokeWidth={1.5}
                      className={cn("shrink-0", active ? "text-signal" : "text-ghost")}
                    />
                    <span className="min-w-0 truncate">{doc.title}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Reading pane */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-6">
            <ContentWidth size="chat">
              {selected && html ? (
                <>
                  <div
                    className={cn("text-body min-w-0 text-sm leading-relaxed", proseClasses)}
                    onClick={handleContentClick}
                    dangerouslySetInnerHTML={{ __html: html }}
                  />
                  <div className="mt-10 flex flex-col items-center gap-2 border-t border-mist pt-6 text-center">
                    <SignalButton size="lg" glow onClick={onOpenProject}>
                      <Sparkles size={16} />
                      Open Project
                    </SignalButton>
                    <p className="text-ghost text-[11px]">
                      You can always find these docs in your project's herman-docs folder.
                    </p>
                  </div>
                </>
              ) : (
                <div className="flex items-center justify-center gap-2 py-16">
                  <Loader2 size={16} className="text-signal animate-spin" />
                  <span className="text-dim text-sm">Rendering…</span>
                </div>
              )}
            </ContentWidth>
          </div>
        </div>
      )}
    </div>
  );
}
