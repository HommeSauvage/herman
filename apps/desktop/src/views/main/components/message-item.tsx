import { Tooltip, TooltipContent, TooltipTrigger } from "@herman/ui/components/tooltip";
import { cn } from "@herman/ui/lib/utils";
import { AlertTriangle, Check, Copy, RotateCcw } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";

import type { Message } from "../../../shared/rpc.js";
import { useStreamingTextThrottle } from "../hooks/use-streaming-throttle.js";
import { desktopRpc } from "../lib/desktop-rpc.js";
import { setupCodeBlockButtons } from "../lib/markdown-dom.js";
import { parseMarkdown, parseMarkdownSync } from "../lib/markdown-parser.js";
import { ToolRow } from "./tool-row.js";

const COPY_RESET_MS = 2000;

function CopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      await desktopRpc.request.copyToClipboard({ text }).catch(() => {});
    }
    setCopied(true);
    setTimeout(() => setCopied(false), COPY_RESET_MS);
  };

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={handleCopy}
            aria-label={copied ? "Copied" : "Copy"}
            className={cn(
              "text-faint hover:text-text inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-white/[0.06] active:scale-[0.96]",
              className,
            )}
          />
        }
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </TooltipTrigger>
      <TooltipContent side="top">{copied ? "Copied" : "Copy"}</TooltipContent>
    </Tooltip>
  );
}

export const MessageItem = memo(function MessageItem({
  message,
  showRevert,
  onRevert,
}: {
  message: Message;
  showRevert?: boolean;
  onRevert?: () => void;
}) {
  if (message.role === "user") {
    return (
      <div data-component="user-message" className="flex w-full flex-col items-end">
        <div className="group/user flex w-full max-w-[min(82%,64ch)] flex-col items-end">
          <div
            data-slot="user-message-text"
            className="text-text max-w-[min(82%,64ch)] rounded-md border border-white/[0.06] bg-white/[0.04] px-3 py-2 text-sm leading-relaxed break-words whitespace-pre-wrap"
          >
            {message.content}
          </div>
          <div className="mt-1 flex h-6 w-full items-center justify-end gap-0.5 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover/user:opacity-100">
            {showRevert && onRevert && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      onClick={onRevert}
                      aria-label="Revert to this point"
                      className={cn(
                        "text-faint hover:text-text inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-white/[0.06] active:scale-[0.96]",
                      )}
                    />
                  }
                >
                  <RotateCcw size={13} />
                </TooltipTrigger>
                <TooltipContent side="top">Revert to this point</TooltipContent>
              </Tooltip>
            )}
            <CopyButton text={message.content} />
          </div>
        </div>
      </div>
    );
  }

  if (message.role === "tool") {
    return (
      <div className="min-w-0">
        <ToolRow
          toolName={message.toolName}
          args={message.args}
          status={message.status}
          output={message.output}
        />
      </div>
    );
  }

  return <AssistantMessage message={message} />;
});

const proseClasses =
  "[&_pre]:relative [&_pre]:my-3 [&_pre]:overflow-hidden [&_pre]:rounded-lg " +
  "[&_pre]:border [&_pre]:border-white/[0.06] [&_pre]:bg-[#0d0d0f] " +
  "[&_pre>code]:block [&_pre>code]:overflow-x-auto [&_pre>code]:p-4 [&_pre>code]:text-xs " +
  "[&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1 [&_li]:ml-4 [&_li]:list-disc " +
  "[&_h1]:mt-4 [&_h1]:mb-2 [&_h1]:text-lg [&_h1]:font-semibold " +
  "[&_h2]:mt-3 [&_h2]:mb-1.5 [&_h2]:text-base [&_h2]:font-semibold " +
  "[&_h3]:mt-2.5 [&_h3]:mb-1 [&_h3]:text-sm [&_h3]:font-semibold " +
  "[&_:not(pre)>code]:text-signal [&_:not(pre)>code]:font-mono [&_:not(pre)>code]:text-[0.85em] " +
  "[&_a]:text-signal [&_a]:underline [&_a]:decoration-signal/30 " +
  "[&_a]:underline-offset-2 hover:[&_a]:decoration-signal/60 " +
  "[&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-signal/30 " +
  "[&_blockquote]:pl-3 [&_blockquote]:text-faint " +
  "[&_table]:my-2 [&_table]:w-full [&_table]:text-xs " +
  "[&_th]:border [&_th]:border-white/[0.06] [&_th]:px-2 [&_th]:py-1 " +
  "[&_th]:text-left [&_th]:font-medium " +
  "[&_td]:border [&_td]:border-white/[0.06] [&_td]:px-2 [&_td]:py-1 " +
  "[&_hr]:my-3 [&_hr]:border-t [&_hr]:border-white/[0.06]";

function AssistantMessage({ message }: { message: Extract<Message, { role: "assistant" }> }) {
  const isStreaming = !!message.isStreaming;
  const content = useStreamingTextThrottle(message.content, isStreaming);
  const [finalHtml, setFinalHtml] = useState<string | null>(null);
  const lastParsedRef = useRef<string | null>(null);

  // When streaming ends, parse with Shiki highlighting asynchronously.
  useEffect(() => {
    if (isStreaming || !content) return;

    // Avoid re-parsing the same content (LRU cache handles repeat calls,
    // but skipping the async work entirely is cheaper).
    if (lastParsedRef.current === content) return;
    lastParsedRef.current = content;

    let cancelled = false;
    parseMarkdown(content).then((result) => {
      if (!cancelled) setFinalHtml(result);
    });
    return () => {
      cancelled = true;
    };
  }, [isStreaming, content]);

  // When a new stream starts, reset parsed state.
  useEffect(() => {
    if (isStreaming) {
      setFinalHtml(null);
      lastParsedRef.current = null;
    }
  }, [isStreaming]);

  const streamingHtml = isStreaming && content ? parseMarkdownSync(content) : null;

  const hasError =
    message.stopReason === "error" ||
    message.stopReason === "aborted" ||
    !!message.errorMessage;
  const errorText =
    message.errorMessage ||
    (message.stopReason
      ? `Assistant stopped unexpectedly (${message.stopReason}).`
      : "The assistant stopped unexpectedly.");

  return (
    <div
      data-component="assistant-message"
      data-streaming={isStreaming ? "true" : "false"}
      className="text-body group/assistant min-w-0 text-sm leading-relaxed"
    >
      {hasError && (
        <div className="mb-2 flex items-start gap-2 rounded-lg border border-red-500/20 bg-red-500/[0.06] px-3 py-2 text-red-300">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-red-400" />
          <p className="min-w-0 flex-1 leading-relaxed">{errorText}</p>
        </div>
      )}
      {content ? (
        <>
          {streamingHtml ? (
            <StreamingHtml html={streamingHtml} showCursor />
          ) : finalHtml ? (
            <FinalHtml html={finalHtml} />
          ) : (
            <StreamingHtml html={parseMarkdownSync(content)} showCursor={false} />
          )}
          {!isStreaming && (
            <div
              data-slot="text-part-copy-wrapper"
              className="mt-1 flex h-6 items-center opacity-0 transition-opacity duration-150 group-hover/assistant:opacity-100 focus-within:opacity-100"
            >
              <CopyButton text={message.content} />
            </div>
          )}
        </>
      ) : (
        !hasError && <span className="text-faint">…</span>
      )}
    </div>
  );
}

/**
 * During streaming: render formatted markdown character-by-character
 * via synchronous marked parse + dangerouslySetInnerHTML.
 * The parent's useStreamingTextThrottle handles the ~24ms pacing.
 */
const StreamingHtml = memo(function StreamingHtml({
  html,
  showCursor = true,
}: {
  html: string;
  showCursor?: boolean;
}) {
  return (
    <span data-slot="text-part-body" className="contents">
      <span className={proseClasses} dangerouslySetInnerHTML={{ __html: html }} />
      {showCursor && (
        <span
          data-slot="streaming-cursor"
          className="bg-signal ml-0.5 inline-block h-[1.1em] w-[2px] translate-y-[0.1em] rounded-full align-baseline"
          aria-hidden
        />
      )}
    </span>
  );
});

/**
 * After streaming completes and the async highlighted parse finishes,
 * render the final HTML with syntax-highlighted code blocks.
 */
const FinalHtml = memo(function FinalHtml({ html }: { html: string }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    return setupCodeBlockButtons(containerRef.current);
  }, [html]);

  return (
    <div
      ref={containerRef}
      data-slot="text-part-body"
      className={proseClasses}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});
