import { describe, expect, it } from "vitest";

import { PortRegistry } from "../../../src/bun/preview/port-registry.js";

describe("PortRegistry", () => {
  it("hands out unique ports under concurrent reservation", async () => {
    const registry = new PortRegistry();
    const reservations = await Promise.all(
      Array.from({ length: 50 }, (_, i) => registry.reserve(40_000, `tab:${i}`)),
    );
    const ports = reservations.map((r) => r.port);
    expect(new Set(ports).size).toBe(50);
    for (const r of reservations) {
      expect(r.port).toBeGreaterThanOrEqual(40_000);
    }
    await Promise.all(reservations.map((r) => r.release()));
    for (const r of reservations) {
      await registry.free(r.port);
    }
  });

  it("held ports are skipped for other owners", async () => {
    const registry = new PortRegistry();
    const first = await registry.reserve(41_000, "tab:a");
    const second = await registry.reserve(41_000, "tab:b");
    expect(second.port).toBeGreaterThan(first.port);
    expect(registry.getPortOwner(first.port)).toBe("tab:a");
    await first.release();
    await registry.free(first.port, "tab:a");
    await second.release();
    await registry.free(second.port, "tab:b");
  });

  it("release closes the hold socket but keeps logical ownership until freed", async () => {
    const registry = new PortRegistry();
    const reservation = await registry.reserve(42_000, "tab:a");
    await reservation.release();
    // Ownership persists after the hold is released (the child owns it now).
    expect(registry.getPortOwner(reservation.port)).toBe("tab:a");
    // The same owner can re-bind the port after release.
    const rebound = await registry.reserve(reservation.port, "tab:a");
    expect(rebound.port).toBe(reservation.port);
    await rebound.release();
    await registry.freeOwner("tab:a");
    expect(registry.getPortOwner(reservation.port)).toBeUndefined();
  });

  it("freeOwner releases every port owned by a scope", async () => {
    const registry = new PortRegistry();
    const a1 = await registry.reserve(43_000, "tab:a");
    const a2 = await registry.reserve(43_001, "tab:a");
    const b1 = await registry.reserve(43_100, "tab:b");
    await registry.freeOwner("tab:a");
    expect(registry.getPortOwner(a1.port)).toBeUndefined();
    expect(registry.getPortOwner(a2.port)).toBeUndefined();
    expect(registry.getPortOwner(b1.port)).toBe("tab:b");
    await registry.freeOwner("tab:b");
  });

  it("claim records ownership without a socket hold", async () => {
    const registry = new PortRegistry();
    registry.claim(44_444, "tab:a");
    expect(registry.getPortOwner(44_444)).toBe("tab:a");
    // Another scope's claim does not steal ownership.
    registry.claim(44_444, "tab:b");
    expect(registry.getPortOwner(44_444)).toBe("tab:a");
    await registry.free(44_444, "tab:b");
    // free with a non-matching owner is a no-op.
    expect(registry.getPortOwner(44_444)).toBe("tab:a");
    await registry.free(44_444, "tab:a");
    expect(registry.getPortOwner(44_444)).toBeUndefined();
  });
});
