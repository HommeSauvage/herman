import { createServer, type Server } from "node:net";

import { getLogger } from "@logtape/logtape";

const logger = getLogger(["herman-desktop", "preview", "ports"]);

const PORT_SCAN_LIMIT = 200;

/**
 * A held port. The socket stays bound (so nothing else can grab the port)
 * until `release()` is called — immediately before spawning the child that
 * will bind it for real.
 */
export type PortReservation = {
  port: number;
  release: () => Promise<void>;
};

function tryBind(port: number): Promise<Server | undefined> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(undefined));
    server.once("listening", () => resolve(server));
    server.listen(port, "127.0.0.1");
  });
}

/**
 * Single port allocator for the whole app. Reservations bind + hold a socket
 * (atomic, no probe-then-release TOCTOU race) and record a logical
 * `port → owner` mapping used for cross-session clash detection and
 * ownership-guarded readiness.
 */
export class PortRegistry {
  private readonly holds = new Map<number, { server: Server; owner: string }>();
  private readonly owners = new Map<number, string>();

  /**
   * Reserve a free port at or above `preferredPort`, skipping ports owned by
   * other scopes. The returned reservation holds the port until released.
   */
  async reserve(preferredPort: number, owner: string): Promise<PortReservation> {
    let port = Math.max(1, Math.floor(preferredPort));
    const deadline = port + PORT_SCAN_LIMIT;
    while (port < deadline) {
      const existingOwner = this.owners.get(port);
      if (existingOwner != null && existingOwner !== owner) {
        port += 1;
        continue;
      }
      const server = await tryBind(port);
      if (server) {
        this.holds.set(port, { server, owner });
        this.owners.set(port, owner);
        logger.debug("Reserved preview port", { port, owner });
        return {
          port,
          release: () => this.releaseHold(port),
        };
      }
      port += 1;
    }
    throw new Error(`No free preview port found near ${preferredPort}`);
  }

  /** Logical owner of a port (reservation or spawned server), if any. */
  getPortOwner(port: number): string | undefined {
    return this.owners.get(port);
  }

  /** Record logical ownership without a socket hold (e.g. after spawning). */
  claim(port: number, owner: string): void {
    const existing = this.owners.get(port);
    if (existing != null && existing !== owner) return;
    this.owners.set(port, owner);
  }

  /** Close the hold socket. Logical ownership is kept (the child owns it now). */
  private async releaseHold(port: number): Promise<void> {
    const hold = this.holds.get(port);
    if (!hold) return;
    this.holds.delete(port);
    await new Promise<void>((resolve) => {
      hold.server.close(() => resolve());
      // Defensive: never let a stuck close block the spawn path.
      setTimeout(resolve, 1_000).unref?.();
    });
  }

  /**
   * Drop a port's hold and logical ownership. When `owner` is given, only
   * matching ownership is released.
   */
  async free(port: number, owner?: string): Promise<void> {
    const existing = this.owners.get(port);
    if (owner != null && existing != null && existing !== owner) return;
    await this.releaseHold(port);
    if (existing != null) {
      this.owners.delete(port);
      logger.debug("Freed preview port", { port, owner: existing });
    }
  }

  /** Free every port owned by a scope (session teardown). */
  async freeOwner(owner: string): Promise<void> {
    const ports = [...this.owners.entries()]
      .filter(([, o]) => o === owner)
      .map(([port]) => port);
    for (const port of ports) {
      await this.free(port, owner);
    }
  }
}

/** App-wide singleton. */
export const previewPortRegistry = new PortRegistry();
