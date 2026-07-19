import { getLogger } from "@logtape/logtape";
import type { DesktopRpc, OutgoingMessages } from "../../../shared/rpc.js";
import {
  type MessageListenerFacade,
  PendingMessageListenerRegistry,
} from "./pending-message-listeners.js";

const logger = getLogger(["herman-desktop", "view", "desktop-rpc"]);

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
  return impl as DesktopRpc;
}

const listenerRegistry = new PendingMessageListenerRegistry(async () => {
  const rpc = await loadImpl();
  return rpc as MessageListenerFacade;
});

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
                logger.warning("Unknown send method", { method: String(method) });
                return undefined;
              }
              return fn(...args);
            };
          },
        },
      );
    }

    if (prop === "addMessageListener") {
      return <N extends keyof OutgoingMessages>(
        name: N,
        handler: (payload: OutgoingMessages[N]) => void,
      ) => {
        listenerRegistry.addMessageListener(name, handler);
      };
    }

    if (prop === "removeMessageListener") {
      return <N extends keyof OutgoingMessages>(
        name: N,
        handler: (payload: OutgoingMessages[N]) => void,
      ) => {
        listenerRegistry.removeMessageListener(name, handler);
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

/** Test-only access to the pending-listener registry. */
export function __getPendingListenerRegistryForTests(): PendingMessageListenerRegistry {
  return listenerRegistry;
}
