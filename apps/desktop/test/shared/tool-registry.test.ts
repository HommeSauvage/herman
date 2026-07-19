import { describe, expect, it } from "vitest";

import {
  TOOL_REGISTRY,
  getRequiredTier0Ids,
  getStrategy,
  getToolEntry,
  orderByDependency,
} from "../../src/shared/tool-registry.js";

describe("tool registry", () => {
  it("entries have unique ids and required fields", () => {
    const ids = new Set<string>();
    for (const entry of TOOL_REGISTRY) {
      expect(ids.has(entry.id)).toBe(false);
      ids.add(entry.id);
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.why.length).toBeGreaterThan(0);
      expect(entry.check.length).toBeGreaterThan(0);
      expect([0, 1, 2]).toContain(entry.tier);
    }
  });

  it("every dependency references a known tool", () => {
    for (const entry of TOOL_REGISTRY) {
      for (const dep of entry.dependsOn ?? []) {
        expect(getToolEntry(dep)).toBeDefined();
      }
    }
  });

  it("macOS tier-0 baseline is git, brew, bun", () => {
    expect(getRequiredTier0Ids("macos")).toEqual(["git", "brew", "bun"]);
  });

  it("brew is not required off macOS; windows/linux baseline is git + bun", () => {
    expect(getRequiredTier0Ids("windows")).toEqual(["git", "bun"]);
    expect(getRequiredTier0Ids("linux")).toEqual(["git", "bun"]);
  });

  it("tier-1 template tools have macOS brew strategies", () => {
    for (const id of ["php", "composer", "node"]) {
      const entry = getToolEntry(id);
      expect(entry).toBeDefined();
      expect(getStrategy(entry!, "macos")?.kind).toBe("brew-formula");
    }
  });

  it("docker is manual everywhere (guided install, never silent)", () => {
    const docker = getToolEntry("docker")!;
    for (const platform of ["macos", "windows", "linux"] as const) {
      expect(getStrategy(docker, platform)?.kind).toBe("manual");
    }
  });
});

describe("orderByDependency", () => {
  it("dependencies come before dependents", () => {
    // Stable: ready items keep input order; blocked items wait for the next pass.
    expect(orderByDependency(["php", "brew", "git"])).toEqual(["brew", "git", "php"]);
    expect(orderByDependency(["composer", "php", "brew"])).toEqual(["brew", "composer", "php"]);
  });

  it("input order is preserved when there are no dependencies", () => {
    expect(orderByDependency(["bun", "git"])).toEqual(["bun", "git"]);
  });

  it("unknown ids are tolerated and keep order", () => {
    expect(orderByDependency(["mystery", "php"])).toEqual(["mystery", "php"]);
  });

  it("dependencies outside the requested set don't block", () => {
    // php depends on brew, but brew isn't requested → php installs anyway.
    expect(orderByDependency(["php"])).toEqual(["php"]);
  });
});
