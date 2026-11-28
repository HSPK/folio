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

export const listen: Lifetime["listen"] = (
  target: Pick<EventTarget, "addEventListener">,
  type: string,
  listener: unknown,
  options?: boolean | AddEventListenerOptions,
) => applicationLifetime().listen(target, type, listener as EventListenerOrEventListenerObject, options);
