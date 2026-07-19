import type { OutgoingMessages } from "../../../shared/rpc.js";

type MessageName = keyof OutgoingMessages;
type MessageHandler<N extends MessageName = MessageName> = (payload: OutgoingMessages[N]) => void;

type PendingEntry = {
  name: MessageName;
  handler: MessageHandler;
  /** True once flushed onto the loaded implementation. */
  registered: boolean;
};

export type MessageListenerFacade = {
  addMessageListener: <N extends MessageName>(name: N, handler: MessageHandler<N>) => void;
  removeMessageListener: <N extends MessageName>(name: N, handler: MessageHandler<N>) => void;
};

/**
 * Pending-listener registry for the lazy desktop RPC facade.
 *
 * `add`/`remove` are synchronous and Promise-free. When the underlying
 * implementation loads, surviving pairs are flushed exactly once.
 */
export class PendingMessageListenerRegistry {
  private readonly pending = new Set<PendingEntry>();
  private impl: MessageListenerFacade | undefined;
  private loadPromise: Promise<MessageListenerFacade> | undefined;
  private readonly loadImpl: () => Promise<MessageListenerFacade>;

  constructor(loadImpl: () => Promise<MessageListenerFacade>) {
    this.loadImpl = loadImpl;
  }

  /** Test/HMR helper: swap the loaded implementation. */
  setImpl(impl: MessageListenerFacade | undefined): void {
    this.impl = impl;
  }

  getImpl(): MessageListenerFacade | undefined {
    return this.impl;
  }

  /** Whether a given (name, handler) pair is currently tracked. */
  has(name: MessageName, handler: MessageHandler): boolean {
    for (const entry of this.pending) {
      if (entry.name === name && entry.handler === handler) return true;
    }
    return false;
  }

  /** Count of tracked pairs (pending or registered). */
  size(): number {
    return this.pending.size;
  }

  addMessageListener<N extends MessageName>(name: N, handler: MessageHandler<N>): void {
    // Deduplicate identical (name, handler) pairs.
    for (const entry of this.pending) {
      if (entry.name === name && entry.handler === handler) {
        this.ensureLoaded();
        return;
      }
    }

    const entry: PendingEntry = {
      name,
      handler: handler as MessageHandler,
      registered: false,
    };
    this.pending.add(entry);

    if (this.impl) {
      this.impl.addMessageListener(name, handler);
      entry.registered = true;
      return;
    }

    this.ensureLoaded();
  }

  removeMessageListener<N extends MessageName>(name: N, handler: MessageHandler<N>): void {
    for (const entry of this.pending) {
      if (entry.name === name && entry.handler === handler) {
        this.pending.delete(entry);
        if (entry.registered && this.impl) {
          this.impl.removeMessageListener(name, handler);
        }
        return;
      }
    }

    // Already removed from pending, but still forward if impl is loaded
    // (defensive — should be rare).
    this.impl?.removeMessageListener(name, handler);
  }

  private ensureLoaded(): void {
    if (this.impl || this.loadPromise) return;
    this.loadPromise = this.loadImpl()
      .then((rpc) => {
        this.impl = rpc;
        this.flush();
        return rpc;
      })
      .catch((err) => {
        this.loadPromise = undefined;
        throw err;
      });
  }

  private flush(): void {
    if (!this.impl) return;
    for (const entry of this.pending) {
      if (entry.registered) continue;
      this.impl.addMessageListener(entry.name, entry.handler);
      entry.registered = true;
    }
  }
}
