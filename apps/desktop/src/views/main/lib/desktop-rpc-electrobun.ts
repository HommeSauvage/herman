import { getLogger } from "@logtape/logtape";
import { Electroview } from "electrobun/view";

import type { HermanDesktopRPC } from "../../../shared/rpc.js";

const logger = getLogger(["herman-desktop", "view", "desktop-rpc"]);

type WebviewMessages = HermanDesktopRPC["webview"]["messages"];
type MessageName = keyof WebviewMessages;

const messageListeners = new Map<MessageName, Set<(payload: unknown) => void>>();

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
      tabFolderChanged: messageHandler("tabFolderChanged"),
      projectsChanged: messageHandler("projectsChanged"),
      sessionsChanged: messageHandler("sessionsChanged"),
      projectOpened: messageHandler("projectOpened"),
      agentEvent: messageHandler("agentEvent"),
      agentStatusChanged: messageHandler("agentStatusChanged"),
      adEvent: messageHandler("adEvent"),
      adVisibilityChanged: messageHandler("adVisibilityChanged"),
      previewStatusChanged: messageHandler("previewStatusChanged"),
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
        logger.debug("[desktop-rpc] send", { message });
        transport.send?.(message);
        logger.debug("[desktop-rpc] send done", {
          durationMs: Number((performance.now() - start).toFixed(2)),
        });
      },
      registerHandler(handler) {
        const wrappedHandler: typeof handler = (message) => {
          const summary =
            message && typeof message === "object"
              ? {
                  ...message,
                  payload: (message as { payload?: unknown }).payload ? "<payload>" : undefined,
                }
              : message;
          logger.debug("[desktop-rpc] receive", { message: summary });
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
