import { Lifetime } from "../../shared/lifetime";

let lifetime: Lifetime | undefined;

/** Own application listeners and requests across mounting, failure, and disposal. */
export function beginApplicationLifetime() {
  if (lifetime && !lifetime.signal.aborted) {
    throw new Error("Folio's application services are already running.");
  }
  lifetime = new Lifetime();
  return lifetime;
}

/** Reject work from an already disposed application rather than using stale DOM. */
export function applicationSignal(): AbortSignal {
  return applicationLifetime().signal;
}

export function applicationLifetime(): Lifetime {
  if (!lifetime || lifetime.signal.aborted) {
    throw new DOMException("The application is no longer active.", "AbortError");
  }
  return lifetime;
}

export function onApplicationDispose(cleanup: () => void) {
  return applicationLifetime().defer(cleanup);
}

export function ownApplicationResource<T extends { destroy(): void }>(resource: T): T {
  onApplicationDispose(() => resource.destroy());
  return resource;
}

/** Bind persistent controller listeners to the application lifetime. */
type ListenerTarget = Pick<EventTarget, "addEventListener">;

export function listen<K extends keyof WindowEventMap>(
  target: Window,
  type: K,
  listener: (event: WindowEventMap[K]) => void,
  options?: boolean | AddEventListenerOptions,
): void;
export function listen<K extends keyof DocumentEventMap>(
  target: Document,
  type: K,
  listener: (event: DocumentEventMap[K]) => void,
  options?: boolean | AddEventListenerOptions,
): void;
export function listen<K extends keyof HTMLElementEventMap>(
  target: ListenerTarget,
  type: K,
  listener: (event: HTMLElementEventMap[K]) => void,
  options?: boolean | AddEventListenerOptions,
): void;
export function listen(
  target: ListenerTarget,
  type: string,
  listener: EventListenerOrEventListenerObject,
  options?: boolean | AddEventListenerOptions,
): void;
export function listen(
  target: ListenerTarget,
  type: string,
  listener: unknown,
  options?: boolean | AddEventListenerOptions,
) {
  const isListener = (value: unknown): value is EventListenerOrEventListenerObject =>
    typeof value === "function" ||
    (value !== null && typeof value === "object" && "handleEvent" in value && typeof value.handleEvent === "function");
  if (!isListener(listener)) throw new Error(`Invalid event listener for ${type}.`);
  const configuration = typeof options === "boolean" ? { capture: options } : options;
  const signal = configuration?.signal
    ? AbortSignal.any([configuration.signal, applicationSignal()])
    : applicationSignal();
  target.addEventListener(type, listener, { ...configuration, signal });
}
