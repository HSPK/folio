type ListenerTarget = Pick<EventTarget, "addEventListener">;

/** Own resources in creation order and release them in reverse order, including failed setup. */
export class Lifetime {
  readonly #controller = new AbortController();
  readonly #cleanup = new Set<() => void>();

  get signal() {
    return this.#controller.signal;
  }

  defer(cleanup: () => void) {
    if (this.signal.aborted) {
      cleanup();
      return () => {};
    }
    this.#cleanup.add(cleanup);
    return () => {
      this.#cleanup.delete(cleanup);
    };
  }

  listen<K extends keyof WindowEventMap>(
    target: Window,
    type: K,
    listener: (event: WindowEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
  listen<K extends keyof DocumentEventMap>(
    target: Document,
    type: K,
    listener: (event: DocumentEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
  listen<K extends keyof HTMLElementEventMap>(
    target: ListenerTarget,
    type: K,
    listener: (event: HTMLElementEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions,
  ): void;
  listen(
    target: ListenerTarget,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
  listen(target: ListenerTarget, type: string, listener: unknown, options?: boolean | AddEventListenerOptions) {
    this.signal.throwIfAborted();
    const isListener = (value: unknown): value is EventListenerOrEventListenerObject =>
      typeof value === "function" ||
      (typeof value === "object" &&
        value !== null &&
        "handleEvent" in value &&
        typeof value.handleEvent === "function");
    if (!isListener(listener)) throw new TypeError(`Invalid listener for ${type}.`);
    const configuration = typeof options === "boolean" ? { capture: options } : options;
    const signal = configuration?.signal ? AbortSignal.any([configuration.signal, this.signal]) : this.signal;
    target.addEventListener(type, listener, { ...configuration, signal });
  }

  dispose() {
    if (this.signal.aborted) return;
    this.#controller.abort();
    const errors: unknown[] = [];
    for (const cleanup of [...this.#cleanup].reverse()) {
      this.#cleanup.delete(cleanup);
      try {
        cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "Some owned resources could not be released.");
  }
}
