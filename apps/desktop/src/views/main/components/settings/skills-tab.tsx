import { cn } from "@herman/ui/lib/utils";
import { Download, FolderOpen, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { SkillInfo } from "../../../../shared/rpc.js";
import { useAgentStore } from "../../lib/agent-store.js";
import { desktopRpc } from "../../lib/desktop-rpc.js";

function sourceLabel(source: SkillInfo["source"]): string {
  switch (source) {
    case "herman":
      return "Herman";
    case "user":
      return "~/.agents";
    case "project":
      return "Project";
  }
}

function sourceColor(source: SkillInfo["source"]): string {
  switch (source) {
    case "herman":
      return "bg-signal/10 text-signal border-signal/20";
    case "user":
      return "bg-blue-500/10 text-blue-400 border-blue-500/20";
    case "project":
      return "bg-amber-500/10 text-amber-400 border-amber-500/20";
  }
}

export function SkillsTab() {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [installUrl, setInstallUrl] = useState("");
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const installInputRef = useRef<HTMLInputElement>(null);

  const activeTabFolderPath = useAgentStore((s) => {
    const activeTabId = s.activeTabId;
    return activeTabId ? s.tabs[activeTabId]?.folderPath : undefined;
  });

  const loadSkills = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await desktopRpc.request.getSkills({
        projectDir: activeTabFolderPath,
      });
      setSkills(result.skills);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load skills");
    } finally {
      setLoading(false);
    }
  }, [activeTabFolderPath]);

  useEffect(() => {
    void loadSkills();
  }, [loadSkills]);

  const handleInstallFromUrl = useCallback(async () => {
    const url = installUrl.trim();
    if (!url) return;

    setInstalling(true);
    setInstallError(null);
    try {
      // Extract skill name from URL (last path segment, strip .git or trailing slash)
      const urlObj = new URL(url);
      let name = urlObj.pathname.split("/").filter(Boolean).pop() ?? "skill";
      name = name.replace(/\.git$/, "");

      // Fetch the SKILL.md content from the URL
      let fetchUrl = url;
      if (url.endsWith("/")) {
        fetchUrl = `${url}SKILL.md`;
      } else if (url.endsWith(".git")) {
        // GitHub raw URL conversion for common patterns
        const githubMatch = url.match(/github\.com\/(.+?)\/(.+?)(?:\.git)?$/);
        if (githubMatch) {
          const [, owner, repo] = githubMatch;
          fetchUrl = `https://raw.githubusercontent.com/${owner}/${repo}/main/SKILL.md`;
        }
      } else if (!url.endsWith(".md")) {
        fetchUrl = `${url}/SKILL.md`;
      }

      const response = await fetch(fetchUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch skill (HTTP ${response.status})`);
      }
      const content = await response.text();

      // Validate basic frontmatter
      if (!content.includes("---")) {
        throw new Error("File does not appear to be a valid SKILL.md (missing frontmatter)");
      }

      await desktopRpc.request.installSkill({ name, content });
      setInstallUrl("");
      setInstallError(null);
      void loadSkills();
    } catch (err) {
      setInstallError(err instanceof Error ? err.message : "Failed to install skill");
    } finally {
      setInstalling(false);
    }
  }, [installUrl, loadSkills]);

  const handleRemove = useCallback(
    async (name: string) => {
      try {
        await desktopRpc.request.removeSkill({ name });
        void loadSkills();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to remove skill");
      }
    },
    [loadSkills],
  );

  return (
    <div className="mx-auto max-w-2xl">
      <h1 className="text-text mb-6 text-xl font-semibold">Skills</h1>

      {/* Install section */}
      <section className="mb-8">
        <h2 className="text-text mb-1 text-sm font-medium">Install a skill</h2>
        <p className="text-dim mb-3 text-xs leading-relaxed">
          Install a skill from a URL. The skill must be an Agent Skills-compatible directory with a
          SKILL.md file. Installed skills are stored in ~/.herman/skills/.
        </p>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <FolderOpen
              size={14}
              className="text-ghost pointer-events-none absolute top-1/2 left-3 -translate-y-1/2"
            />
            <input
              ref={installInputRef}
              type="url"
              value={installUrl}
              onChange={(e) => setInstallUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleInstallFromUrl();
              }}
              placeholder="https://github.com/user/skill-repo"
              className="bg-void border-white/[0.06] placeholder:text-ghost/40 focus:border-signal/30 text-text w-full rounded-lg border py-2 pr-3 pl-9 text-sm outline-none transition placeholder:text-xs focus:shadow-[0_0_24px_rgba(34,197,94,0.06)]"
            />
          </div>
          <button
            type="button"
            onClick={() => void handleInstallFromUrl()}
            disabled={installing || !installUrl.trim()}
            className={cn(
              "bg-signal/10 text-signal border-signal/20 hover:bg-signal/20 flex shrink-0 items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium transition active:scale-[0.97]",
              "disabled:opacity-40 disabled:cursor-not-allowed",
            )}
          >
            <Download size={14} />
            {installing ? "Installing…" : "Install"}
          </button>
        </div>
        {installError && (
          <p className="text-red-400 mt-2 text-xs">{installError}</p>
        )}
      </section>

      {/* Skills list */}
      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-text text-sm font-medium">
            Installed skills
            {skills.length > 0 && (
              <span className="text-ghost ml-1 text-xs font-normal">({skills.length})</span>
            )}
          </h2>
        </div>

        {loading && (
          <div className="text-ghost py-12 text-center text-sm">Loading skills…</div>
        )}

        {error && (
          <div className="text-red-400 py-12 text-center text-sm">{error}</div>
        )}

        {!loading && !error && skills.length === 0 && (
          <div className="border-white/[0.06] bg-surface/20 flex flex-col items-center gap-3 rounded-xl border py-12 text-center">
            <div className="bg-white/[0.03] rounded-full p-3">
              <FolderOpen size={22} className="text-ghost" />
            </div>
            <div>
              <p className="text-dim text-sm font-medium">No skills installed</p>
              <p className="text-ghost mt-1 text-xs">
                Install skills above or add SKILL.md files to ~/.agents/skills/ or
                your project's .agents/skills/ directory.
              </p>
            </div>
          </div>
        )}

        {!loading &&
          !error &&
          skills.map((skill) => (
            <div
              key={skill.name}
              className="border-white/[0.06] hover:border-white/[0.12] mb-2 flex items-start gap-3 rounded-lg border p-3 transition"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-text text-sm font-medium">{skill.name}</span>
                  <span
                    className={cn(
                      "inline-block rounded-full border px-2 py-px text-[10px] font-semibold uppercase tracking-wider",
                      sourceColor(skill.source),
                    )}
                  >
                    {sourceLabel(skill.source)}
                  </span>
                </div>
                <p className="text-dim mt-1 text-xs leading-relaxed line-clamp-2">
                  {skill.description}
                </p>
                <p className="text-ghost mt-1 truncate text-[10px] font-mono">
                  {skill.filePath}
                </p>
              </div>
              {skill.source === "herman" && (
                <button
                  type="button"
                  onClick={() => void handleRemove(skill.name)}
                  className="text-ghost hover:text-red-400 shrink-0 rounded p-1 transition"
                  title={`Remove ${skill.name}`}
                >
                  <Trash2 size={14} />
                </button>
              )}
            </div>
          ))}
      </section>
    </div>
  );
}
