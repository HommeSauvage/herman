import { Tooltip, TooltipContent, TooltipTrigger } from "@herman/ui/components/tooltip";
import { cn } from "@herman/ui/lib/utils";
import { Check, Copy, RotateCcw } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";

import type { Message } from "../../../shared/rpc.js";
import { useStreamingTextThrottle } from "../hooks/use-streaming-throttle.js";
import { desktopRpc } from "../lib/desktop-rpc.js";
import { setupCodeBlockButtons } from "../lib/markdown-dom.js";
import { parseMarkdown, parseMarkdownSync } from "../lib/markdown-parser.js";
import { ToolRow } from "./tool-row.js";
import { proseClasses } from "./ui/prose-classes.js";

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
                      aria-label="Undo Herman's changes from here"
                      className={cn(
                        "text-faint hover:text-text inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-white/[0.06] active:scale-[0.96]",
                      )}
                    />
                  }
                >
                  <RotateCcw size={13} />
                </TooltipTrigger>
                <TooltipContent side="top">Undo Herman&apos;s changes from here</TooltipContent>
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

  if (message.role === "thinking") {
    return <ThinkingMessage message={message} />;
  }

  return <AssistantMessage message={message} />;
});

function ThinkingMessage({ message }: { message: Extract<Message, { role: "thinking" }> }) {
  const isStreaming = !!message.isStreaming;
  const content = useStreamingTextThrottle(message.content, isStreaming);

  return (
    <div
      data-component="thinking-message"
      className="text-dim group/thinking min-w-0 text-sm leading-relaxed"
    >
      <div className="text-ghost mb-1 text-xs font-medium">Thinking</div>
      <div className="border-l-2 border-white/[0.06] pl-3">
        <div className="whitespace-pre-wrap break-words">{content}</div>
        {isStreaming && (
          <span
            data-slot="streaming-cursor"
            className="bg-signal ml-0.5 inline-block h-[1.1em] w-[2px] translate-y-[0.1em] rounded-full align-baseline"
            aria-hidden
          />
        )}
      </div>
    </div>
  );
}

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

  return (
    <div
      data-component="assistant-message"
      data-streaming={isStreaming ? "true" : "false"}
      className="text-body group/assistant min-w-0 text-sm leading-relaxed"
    >
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
        !message.errorMessage &&
        message.stopReason !== "error" &&
        message.stopReason !== "aborted" && <span className="text-faint">…</span>
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
