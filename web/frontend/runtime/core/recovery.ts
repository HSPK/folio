import { listen, onApplicationDispose } from "../lifecycle";

export function isConnectionLoss(error: { network?: boolean; status?: number }) {
  return error.network || [408, 502, 503, 504].includes(error.status ?? 0);
}

export const connectivity = { serviceLost: false, roomLost: false };
let schedule: (() => void) | undefined;
let reset: (() => void) | undefined;

/** Re-establish the session, never replay the request that detected the outage. */
export function initializeConnectionRecovery(reconnect: () => Promise<void>, offline: () => void) {
  let timer: number | undefined;
  let running = false;
  let delay = 2000;
  let disposed = false;
  const queue = () => {
    if (!disposed && !running && timer === undefined && connectivity.serviceLost && navigator.onLine)
      timer = window.setTimeout(attempt, delay);
  };
  async function attempt() {
    window.clearTimeout(timer);
    timer = undefined;
    if (disposed || running || !connectivity.serviceLost || !navigator.onLine) return;
    running = true;
    delay = Math.min(delay * 2, 30000);
    try {
      await reconnect();
    } finally {
      running = false;
      queue();
    }
  }
  schedule = queue;
  reset = () => {
    window.clearTimeout(timer);
    timer = undefined;
    delay = 2000;
  };
  listen(window, "online", attempt);
  listen(window, "offline", offline);
  onApplicationDispose(() => {
    disposed = true;
    clearServiceOutage();
    connectivity.roomLost = false;
    schedule = reset = undefined;
  });
}

export function reportServiceOutage() {
  connectivity.serviceLost = true;
  schedule?.();
}

export function clearServiceOutage() {
  connectivity.serviceLost = false;
  reset?.();
}
