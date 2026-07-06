import type { AdPlacement, AgentCommand, AgentEvent } from "../../../shared/agent-protocol.js";
import type { AgentStatus, DesktopRpc, OutgoingMessages } from "../../../shared/rpc.js";

let impl: DesktopRpc | undefined;

async function loadImpl(): Promise<DesktopRpc> {
  if (impl) return impl;

  const isElectrobun = typeof window !== "undefined" && "__electrobun" in window;
  if (isElectrobun) {
    const { desktopRpc } = await import("./desktop-rpc-electrobun.js");
    impl = desktopRpc;
  } else {
    const { desktopRpc } = await import("./browser-rpc.js");
    impl = desktopRpc;
  }
  return impl!;
}

export const desktopRpc = new Proxy({} as DesktopRpc, {
  get(_target, prop) {
    if (prop === "request") {
      return new Proxy(
        {},
        {
          get(_reqTarget, method) {
            return async (...args: unknown[]) => {
              const rpc = await loadImpl();
              const fn = (rpc.request as Record<string, unknown>)[method as string] as
                | ((...args: unknown[]) => unknown)
                | undefined;
              if (!fn) throw new Error(`Unknown request method: ${String(method)}`);
              return fn(...args);
            };
          },
        },
      );
    }

    if (prop === "send") {
      return new Proxy(
        {},
        {
          get(_sendTarget, method) {
            return async (...args: unknown[]) => {
              const rpc = await loadImpl();
              const fn = (rpc.send as Record<string, unknown> | undefined)?.[method as string] as
                | ((...args: unknown[]) => unknown)
                | undefined;
              if (!fn) {
                console.warn(`Unknown send method: ${String(method)}`);
                return undefined;
              }
              return fn(...args);
            };
          },
        },
      );
    }

    if (prop === "addMessageListener" || prop === "removeMessageListener") {
      return (...args: unknown[]) => {
        if (impl) {
          return (impl as unknown as Record<string, (...args: unknown[]) => void>)[prop as string](
            ...args,
          );
        }
        loadImpl()
          .then((rpc) =>
            (rpc as unknown as Record<string, (...args: unknown[]) => void>)[prop as string](
              ...args,
            ),
          )
          .catch((err: unknown) => {
            console.error(
              `[desktop-rpc] Failed to register message listener "${String(prop)}":`,
              err instanceof Error ? err.message : String(err),
            );
          });
      };
    }

    return async (...args: unknown[]) => {
      const rpc = await loadImpl();
      const fn = (rpc as Record<string, unknown>)[prop as string] as
        | ((...args: unknown[]) => unknown)
        | undefined;
      if (!fn) throw new Error(`Unknown RPC method: ${String(prop)}`);
      return fn(...args);
    };
  },
});
