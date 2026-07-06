import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";

import { highlightCode } from "../lib/shiki.js";

export function CodeBlock({ code, language }: { code: string; language?: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    setFailed(false);
    highlightCode(code, language)
      .then((result) => {
        if (!cancelled) setHtml(result);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [code, language]);

  async function copy() {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="group relative my-3 overflow-hidden rounded-lg border border-white/[0.06] bg-[#0d0d0f]">
      <div className="flex items-center justify-between border-b border-white/[0.06] bg-white/[0.02] px-3 py-1.5">
        <span className="text-faint text-[10px] font-medium tracking-wider uppercase">
          {language ?? "code"}
        </span>
        <button
          onClick={copy}
          className="text-faint hover:text-text rounded-md p-1 transition hover:bg-white/[0.06] active:scale-[0.96]"
          aria-label="Copy code"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
      <div className="overflow-x-auto p-4 text-xs [&_pre]:!bg-transparent [&_pre]:!p-0">
        {html ? (
          <div dangerouslySetInnerHTML={{ __html: html }} />
        ) : failed ? (
          <pre className="!bg-transparent !p-0 font-mono">
            <code>{code}</code>
          </pre>
        ) : null}
      </div>
    </div>
  );
}
