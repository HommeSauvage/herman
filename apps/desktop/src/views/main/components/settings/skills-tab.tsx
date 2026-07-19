import { cn } from "@herman/ui/lib/utils";
import { Download, FolderOpen, Power, PowerOff, Search, Terminal, Trash2 } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import type { SkillInfo, SkillSearchResult } from "../../../../shared/rpc.js";
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

type InstallMode = "git" | "command" | "search";

const MODES: { value: InstallMode; label: string; icon: ReactNode }[] = [
  { value: "git", label: "Git URL", icon: <FolderOpen size={12} /> },
  { value: "command", label: "Command", icon: <Terminal size={12} /> },
  { value: "search", label: "Search", icon: <Search size={12} /> },
];

export function SkillsTab() {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);

  const [mode, setMode] = useState<InstallMode>("git");

  const [installUrl, setInstallUrl] = useState("");
  const [installCommand, setInstallCommand] = useState("");
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SkillSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

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

  const resetMessages = useCallback(() => {
    setInstallError(null);
    setSearchError(null);
  }, []);

  const handleModeChange = useCallback(
    (nextMode: InstallMode) => {
      setMode(nextMode);
      resetMessages();
    },
    [resetMessages],
  );

  const validateSkillContent = useCallback(
    (content: string): { name?: string; description?: string } => {
      if (!content.startsWith("---")) {
        throw new Error("File does not appear to be a valid SKILL.md (missing frontmatter)");
      }
      const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      const endIndex = normalized.indexOf("\n---", 3);
      if (endIndex === -1) {
        throw new Error("File does not appear to be a valid SKILL.md (unclosed frontmatter)");
      }
      const yamlString = normalized.slice(4, endIndex);
      const result: { name?: string; description?: string } = {};
      for (const line of yamlString.split("\n")) {
        const match = line.match(/^(\w[\w-]*):\s*(.*)$/);
        if (match) {
          const key = match[1];
          const value = match[2].trim().replace(/^['"](.*)['"]$/, "$1");
          if (key === "name" || key === "description") {
            result[key] = value;
          }
        }
      }
      if (!result.description?.trim()) {
        throw new Error("SKILL.md is missing a description in its frontmatter");
      }
      return result;
    },
    [],
  );

  const buildSkillFetchUrl = useCallback((rawUrl: string): string[] => {
    const urlObj = new URL(rawUrl);
    const url = `${urlObj.origin}${urlObj.pathname}`;
    const githubMatch = url.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
    if (githubMatch) {
      const [, owner, repo] = githubMatch;
      return [
        `https://raw.githubusercontent.com/${owner}/${repo}/main/SKILL.md`,
        `https://raw.githubusercontent.com/${owner}/${repo}/master/SKILL.md`,
      ];
    }
    if (url.endsWith("/")) {
      return [`${url}SKILL.md`];
    }
    if (url.endsWith(".md")) {
      return [url];
    }
    return [`${url}/SKILL.md`];
  }, []);

  const handleInstallFromUrl = useCallback(async () => {
    const url = installUrl.trim();
    if (!url) return;

    setInstalling(true);
    setInstallError(null);
    try {
      const urlObj = new URL(url);
      let name = urlObj.pathname.split("/").filter(Boolean).pop() ?? "skill";
      name = name.replace(/\.git$/, "");

      const fetchUrls = buildSkillFetchUrl(url);
      let content = "";
      let lastError: Error | undefined;
      for (const fetchUrl of fetchUrls) {
        const response = await fetch(fetchUrl);
        if (response.ok) {
          content = await response.text();
          break;
        }
        lastError = new Error(`Failed to fetch skill (HTTP ${response.status})`);
      }
      if (!content) {
        throw lastError ?? new Error("Failed to fetch skill");
      }
      const frontmatter = validateSkillContent(content);

      await desktopRpc.request.installSkill({ name: frontmatter.name || name, content });
      setInstallUrl("");
      setInstallError(null);
      void loadSkills();
    } catch (err) {
      setInstallError(err instanceof Error ? err.message : "Failed to install skill");
    } finally {
      setInstalling(false);
    }
  }, [installUrl, loadSkills, buildSkillFetchUrl, validateSkillContent]);

  const handleInstallFromCommand = useCallback(async () => {
    const command = installCommand.trim();
    if (!command) return;

    setInstalling(true);
    setInstallError(null);
    try {
      await desktopRpc.request.installSkillFromCommand({ command });
      setInstallCommand("");
      setInstallError(null);
      void loadSkills();
    } catch (err) {
      setInstallError(err instanceof Error ? err.message : "Failed to install skill");
    } finally {
      setInstalling(false);
    }
  }, [installCommand, loadSkills]);

  const handleSearch = useCallback(async () => {
    const query = searchQuery.trim();
    if (!query) return;

    setSearching(true);
    setSearchError(null);
    setSearchResults([]);
    try {
      const { results } = await desktopRpc.request.searchSkills({ query });
      setSearchResults(results);
      if (results.length === 0) {
        setSearchError("No skills found");
      }
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : "Failed to search skills");
    } finally {
      setSearching(false);
    }
  }, [searchQuery]);

  const handleInstallFromSearch = useCallback(
    async (pkg: string) => {
      setInstalling(true);
      setInstallError(null);
      setSearchError(null);
      try {
        await desktopRpc.request.installSkillFromCommand({
          command: `npx skills add ${pkg}`,
        });
        void loadSkills();
      } catch (err) {
        setInstallError(err instanceof Error ? err.message : "Failed to install skill");
      } finally {
        setInstalling(false);
      }
    },
    [loadSkills],
  );

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

  const handleToggle = useCallback(
    async (name: string, enabled: boolean) => {
      setToggling(name);
      try {
        await desktopRpc.request.setSkillEnabled({ name, enabled });
        void loadSkills();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to update skill");
      } finally {
        setToggling(null);
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
        <p className="text-dim mb-4 text-xs leading-relaxed">
          Install from a git URL, paste an install command like{" "}
          <code className="text-text bg-white/[0.06] rounded px-1 py-0.5 text-[10px]">
            npx skills add owner/repo@skill
          </code>
          , or search the skills registry.
        </p>

        {/* Mode selector */}
        <div className="border-white/[0.06] mb-4 flex gap-1 rounded-lg border p-1">
          {MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              onClick={() => handleModeChange(m.value)}
              className={cn(
                "flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition",
                mode === m.value
                  ? "bg-signal/10 text-signal"
                  : "text-dim hover:bg-white/[0.04] hover:text-text",
              )}
            >
              {m.icon}
              {m.label}
            </button>
          ))}
        </div>

        {/* Git URL install */}
        {mode === "git" && (
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
        )}

        {/* Command install */}
        {mode === "command" && (
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Terminal
                size={14}
                className="text-ghost pointer-events-none absolute top-1/2 left-3 -translate-y-1/2"
              />
              <input
                type="text"
                value={installCommand}
                onChange={(e) => setInstallCommand(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleInstallFromCommand();
                }}
                placeholder="npx skills add owner/repo@skill"
                className="bg-void border-white/[0.06] placeholder:text-ghost/40 focus:border-signal/30 text-text w-full rounded-lg border py-2 pr-3 pl-9 text-sm outline-none transition placeholder:text-xs focus:shadow-[0_0_24px_rgba(34,197,94,0.06)]"
              />
            </div>
            <button
              type="button"
              onClick={() => void handleInstallFromCommand()}
              disabled={installing || !installCommand.trim()}
              className={cn(
                "bg-signal/10 text-signal border-signal/20 hover:bg-signal/20 flex shrink-0 items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium transition active:scale-[0.97]",
                "disabled:opacity-40 disabled:cursor-not-allowed",
              )}
            >
              <Download size={14} />
              {installing ? "Installing…" : "Install"}
            </button>
          </div>
        )}

        {/* Search install */}
        {mode === "search" && (
          <div className="space-y-3">
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Search
                  size={14}
                  className="text-ghost pointer-events-none absolute top-1/2 left-3 -translate-y-1/2"
                />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleSearch();
                  }}
                  placeholder="Search skills…"
                  className="bg-void border-white/[0.06] placeholder:text-ghost/40 focus:border-signal/30 text-text w-full rounded-lg border py-2 pr-3 pl-9 text-sm outline-none transition placeholder:text-xs focus:shadow-[0_0_24px_rgba(34,197,94,0.06)]"
                />
              </div>
              <button
                type="button"
                onClick={() => void handleSearch()}
                disabled={searching || !searchQuery.trim()}
                className={cn(
                  "bg-signal/10 text-signal border-signal/20 hover:bg-signal/20 flex shrink-0 items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium transition active:scale-[0.97]",
                  "disabled:opacity-40 disabled:cursor-not-allowed",
                )}
              >
                <Search size={14} />
                {searching ? "Searching…" : "Search"}
              </button>
            </div>

            {searchResults.length > 0 && (
              <div className="space-y-2">
                {searchResults.map((result) => (
                  <div
                    key={result.package}
                    className="border-white/[0.06] hover:border-white/[0.12] flex items-center gap-3 rounded-lg border p-3 transition"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-text text-sm font-medium">{result.package}</span>
                        <span className="text-ghost text-xs">{result.installs}</span>
                      </div>
                      <a
                        href={result.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-dim hover:text-text mt-1 block truncate text-[10px]"
                      >
                        {result.url}
                      </a>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleInstallFromSearch(result.package)}
                      disabled={installing}
                      className={cn(
                        "bg-signal/10 text-signal border-signal/20 hover:bg-signal/20 flex shrink-0 items-center gap-2 rounded-lg border px-3 py-1.5 text-xs font-medium transition active:scale-[0.97]",
                        "disabled:opacity-40 disabled:cursor-not-allowed",
                      )}
                    >
                      <Download size={12} />
                      Install
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {(installError || searchError) && (
          <p className="text-red-400 mt-2 text-xs">{installError || searchError}</p>
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

        {loading && <div className="text-ghost py-12 text-center text-sm">Loading skills…</div>}

        {error && <div className="text-red-400 py-12 text-center text-sm">{error}</div>}

        {!loading && !error && skills.length === 0 && (
          <div className="border-white/[0.06] bg-surface/20 flex flex-col items-center gap-3 rounded-xl border py-12 text-center">
            <div className="bg-white/[0.03] rounded-full p-3">
              <FolderOpen size={22} className="text-ghost" />
            </div>
            <div>
              <p className="text-dim text-sm font-medium">No skills installed</p>
              <p className="text-ghost mt-1 text-xs">
                Install skills above or add SKILL.md files to ~/.agents/skills/ or your project's
                .agents/skills/ directory.
              </p>
            </div>
          </div>
        )}

        {!loading &&
          !error &&
          skills.map((skill) => (
            <div
              key={skill.name}
              className={cn(
                "border-white/[0.06] hover:border-white/[0.12] mb-2 flex items-start gap-3 rounded-lg border p-3 transition",
                skill.disabled && "opacity-50",
              )}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-text text-sm font-medium">{skill.name}</span>
                  <span
                    className={cn(
                      "inline-block rounded-full border px-2 py-px text-[10px] font-semibold tracking-wider",
                      sourceColor(skill.source),
                    )}
                  >
                    {sourceLabel(skill.source)}
                  </span>
                  {skill.disabled && <span className="text-ghost text-[10px]">(disabled)</span>}
                </div>
                <p className="text-dim mt-1 text-xs leading-relaxed line-clamp-2">
                  {skill.description}
                </p>
                <p className="text-ghost mt-1 truncate text-[10px] font-mono">{skill.filePath}</p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {skill.source === "herman" && (
                  <button
                    type="button"
                    onClick={() => void handleToggle(skill.name, !!skill.disabled)}
                    disabled={toggling === skill.name}
                    className={cn(
                      "shrink-0 rounded p-1 transition",
                      skill.disabled
                        ? "text-ghost hover:text-signal"
                        : "text-ghost hover:text-amber-400",
                    )}
                    title={skill.disabled ? `Enable ${skill.name}` : `Disable ${skill.name}`}
                  >
                    {skill.disabled ? <Power size={14} /> : <PowerOff size={14} />}
                  </button>
                )}
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
            </div>
          ))}
      </section>
    </div>
  );
}
