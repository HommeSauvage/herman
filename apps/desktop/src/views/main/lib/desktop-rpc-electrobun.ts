import { getLogger } from "@logtape/logtape";
import { Electroview } from "electrobun/view";

import type { HermanDesktopRPC } from "../../../shared/rpc.js";

const logger = getLogger(["herman-desktop", "view", "desktop-rpc"]);

type WebviewMessages = HermanDesktopRPC["webview"]["messages"];
type MessageName = keyof WebviewMessages;

const messageListeners = new Map<MessageName, Set<(payload: unknown) => void>>();

// Track getTabs request IDs so we can suppress their noisy routine logs.
// The response doesn't carry the method name, so we map id -> method.
const getTabsRequestIds = new Set<number | string>();

function getMessageMethod(message: unknown): string | undefined {
  if (message && typeof message === "object" && "method" in message) {
    return String((message as { method?: unknown }).method ?? "unknown");
  }
  return undefined;
}

function getMessageId(message: unknown): number | string | undefined {
  if (message && typeof message === "object" && "id" in message) {
    return (message as { id?: number | string }).id;
  }
  return undefined;
}

function emitMessage<N extends MessageName>(name: N, payload: WebviewMessages[N]) {
  messageListeners.get(name)?.forEach((handler) => handler(payload));
}

function messageHandler<N extends MessageName>(name: N) {
  return (payload: WebviewMessages[N]) => emitMessage(name, payload);
}

const rpc = Electroview.defineRPC<HermanDesktopRPC>({
  maxRequestTime: 30_000,
  handlers: {
    requests: {},
    messages: {
      activationComplete: messageHandler("activationComplete"),
      sessionChanged: messageHandler("sessionChanged"),
      updateStatus: messageHandler("updateStatus"),
      tabsRestored: messageHandler("tabsRestored"),
      tabCreated: messageHandler("tabCreated"),
      tabMessagesHydrated: messageHandler("tabMessagesHydrated"),
      tabClosed: messageHandler("tabClosed"),
      tabActivated: messageHandler("tabActivated"),
      sessionStateChanged: messageHandler("sessionStateChanged"),
      projectsChanged: messageHandler("projectsChanged"),
      sessionsChanged: messageHandler("sessionsChanged"),
      projectOpened: messageHandler("projectOpened"),
      agentEvent: messageHandler("agentEvent"),
      agentStatusChanged: messageHandler("agentStatusChanged"),
      adEvent: messageHandler("adEvent"),
      adVisibilityChanged: messageHandler("adVisibilityChanged"),
      previewStatusChanged: messageHandler("previewStatusChanged"),
      previewLog: messageHandler("previewLog"),
      wizardEvent: messageHandler("wizardEvent"),
    },
  },
});

if (import.meta.env.DEV && rpc.setTransport) {
  const originalSetTransport = rpc.setTransport.bind(rpc);
  rpc.setTransport = (transport) => {
    const wrapped: typeof transport = {
      ...transport,
      send(message) {
        const start = performance.now();
        const method = getMessageMethod(message);
        const isGetTabs = method === "getTabs";
        if (isGetTabs) {
          const id = getMessageId(message);
          if (id !== undefined) getTabsRequestIds.add(id);
          logger.trace("[desktop-rpc] send", { method });
        } else {
          logger.debug("[desktop-rpc] send", { message });
        }
        transport.send?.(message);
        if (!isGetTabs) {
          logger.debug("[desktop-rpc] send done", {
            durationMs: Number((performance.now() - start).toFixed(2)),
          });
        }
      },
      registerHandler(handler) {
        const wrappedHandler: typeof handler = (message) => {
          const id = getMessageId(message);
          const isGetTabsResponse = id !== undefined && getTabsRequestIds.has(id);
          if (isGetTabsResponse) {
            getTabsRequestIds.delete(id);
            logger.trace("[desktop-rpc] receive", { method: "getTabs" });
          } else {
            const summary =
              message && typeof message === "object"
                ? {
                    ...message,
                    payload: (message as { payload?: unknown }).payload ? "<none>" : undefined,
                  }
                : message;
            logger.debug("[desktop-rpc] receive", { message: summary });
          }
          handler(message);
        };
        transport.registerHandler?.(wrappedHandler);
      },
    };
    originalSetTransport(wrapped);
  };
} else if (rpc.setTransport) {
  const originalSetTransport = rpc.setTransport.bind(rpc);
  rpc.setTransport = (transport) => {
    const wrapped: typeof transport = {
      ...transport,
      send(message) {
        const method = getMessageMethod(message);
        if (method === "getTabs") {
          const id = getMessageId(message);
          if (id !== undefined) getTabsRequestIds.add(id);
          return transport.send?.(message);
        }
        logger.trace("[desktop-rpc] send", { method });
        transport.send?.(message);
      },
      registerHandler(handler) {
        const wrappedHandler: typeof handler = (message) => {
          const id = getMessageId(message);
          if (id !== undefined && getTabsRequestIds.has(id)) {
            getTabsRequestIds.delete(id);
            return handler(message);
          }
          const method = getMessageMethod(message) ?? "unknown";
          logger.trace("[desktop-rpc] receive", { method });
          handler(message);
        };
        transport.registerHandler?.(wrappedHandler);
      },
    };
    originalSetTransport(wrapped);
  };
}

new Electroview({ rpc });

export const desktopRpc = {
  request: rpc.request,
  send: rpc.send,
  addMessageListener<N extends MessageName>(
    name: N,
    handler: (payload: WebviewMessages[N]) => void,
  ) {
    if (!messageListeners.has(name)) messageListeners.set(name, new Set());
    messageListeners.get(name)!.add(handler as (payload: unknown) => void);
  },
  removeMessageListener<N extends MessageName>(
    name: N,
    handler: (payload: WebviewMessages[N]) => void,
  ) {
    messageListeners.get(name)?.delete(handler as (payload: unknown) => void);
  },
};
