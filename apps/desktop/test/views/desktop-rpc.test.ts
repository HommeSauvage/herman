import { describe, expect, it } from "bun:test";

import {
  type MessageListenerFacade,
  PendingMessageListenerRegistry,
} from "../../src/views/main/lib/pending-message-listeners.js";

type Call = [string, unknown];

function makeFacade(): MessageListenerFacade & { added: Call[]; removed: Call[] } {
  const added: Call[] = [];
  const removed: Call[] = [];
  return {
    added,
    removed,
    addMessageListener: (name, handler) => {
      added.push([name, handler]);
    },
    removeMessageListener: (name, handler) => {
      removed.push([name, handler]);
    },
  };
}

function makeDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("PendingMessageListenerRegistry", () => {
  it("queues addMessageListener before the implementation loads, then flushes once it does", async () => {
    const facade = makeFacade();
    const deferred = makeDeferred<MessageListenerFacade>();
    const registry = new PendingMessageListenerRegistry(() => deferred.promise);
    const handler = () => {};

    registry.addMessageListener("previewLog", handler);

    expect(registry.has("previewLog", handler)).toBe(true);
    expect(registry.size()).toBe(1);
    expect(facade.added.length).toBe(0);
    expect(registry.getImpl()).toBeUndefined();

    deferred.resolve(facade);
    await tick();

    expect(registry.getImpl()).toBe(facade);
    expect(facade.added).toEqual([["previewLog", handler]]);
  });

  it("dedupes identical (name, handler) pairs added multiple times", () => {
    const registry = new PendingMessageListenerRegistry(() => new Promise(() => {}));
    const handler = () => {};

    registry.addMessageListener("previewLog", handler);
    registry.addMessageListener("previewLog", handler);
    registry.addMessageListener("previewLog", handler);

    expect(registry.size()).toBe(1);
  });

  it("treats distinct handlers for the same message name as separate entries", () => {
    const registry = new PendingMessageListenerRegistry(() => new Promise(() => {}));
    const handlerA = () => {};
    const handlerB = () => {};

    registry.addMessageListener("previewLog", handlerA);
    registry.addMessageListener("previewLog", handlerB);

    expect(registry.size()).toBe(2);
  });

  it("cancels a pending registration when removed before the implementation loads", async () => {
    const facade = makeFacade();
    const deferred = makeDeferred<MessageListenerFacade>();
    const registry = new PendingMessageListenerRegistry(() => deferred.promise);
    const handler = () => {};

    registry.addMessageListener("previewLog", handler);
    registry.removeMessageListener("previewLog", handler);

    expect(registry.size()).toBe(0);
    expect(registry.has("previewLog", handler)).toBe(false);

    deferred.resolve(facade);
    await tick();

    // Never flushed onto the implementation since it was removed first.
    expect(facade.added.length).toBe(0);
  });

  it("registers immediately (bypassing the pending queue) once an implementation is already set", () => {
    const facade = makeFacade();
    const registry = new PendingMessageListenerRegistry(() => Promise.resolve(facade));
    registry.setImpl(facade);
    const handler = () => {};

    registry.addMessageListener("previewLog", handler);

    expect(facade.added).toEqual([["previewLog", handler]]);
    expect(registry.size()).toBe(1);
  });

  it("forwards removeMessageListener directly to the implementation once loaded", async () => {
    const facade = makeFacade();
    const deferred = makeDeferred<MessageListenerFacade>();
    const registry = new PendingMessageListenerRegistry(() => deferred.promise);
    const handler = () => {};

    registry.addMessageListener("previewLog", handler);
    deferred.resolve(facade);
    await tick();
    expect(facade.added).toEqual([["previewLog", handler]]);

    registry.removeMessageListener("previewLog", handler);

    expect(facade.removed).toEqual([["previewLog", handler]]);
    expect(registry.size()).toBe(0);
    expect(registry.has("previewLog", handler)).toBe(false);
  });

  it("flushes multiple distinct pending entries once loaded, preserving registration order", async () => {
    const facade = makeFacade();
    const deferred = makeDeferred<MessageListenerFacade>();
    const registry = new PendingMessageListenerRegistry(() => deferred.promise);
    const statusHandler = () => {};
    const logHandler = () => {};

    registry.addMessageListener("previewStatusChanged", statusHandler);
    registry.addMessageListener("previewLog", logHandler);

    deferred.resolve(facade);
    await tick();

    expect(facade.added).toEqual([
      ["previewStatusChanged", statusHandler],
      ["previewLog", logHandler],
    ]);
  });

  it("only calls the loader once for concurrent addMessageListener calls before load resolves", async () => {
    let loadCount = 0;
    const facade = makeFacade();
    const deferred = makeDeferred<MessageListenerFacade>();
    const registry = new PendingMessageListenerRegistry(() => {
      loadCount += 1;
      return deferred.promise;
    });

    registry.addMessageListener("previewLog", () => {});
    registry.addMessageListener("previewStatusChanged", () => {});

    deferred.resolve(facade);
    await tick();

    expect(loadCount).toBe(1);
  });
});
