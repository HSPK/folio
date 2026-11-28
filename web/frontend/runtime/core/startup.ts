import { abortable } from "../../../shared/async";
import { authenticationSession } from "../../state/authentication";
import { appState } from "./bootstrap";

interface StartupReads {
  reads: Map<string, Promise<Response>>;
  started: Set<string>;
  at: number;
}
const page = window as Window & {
  folioStart?: (StartupReads & { reader?: string }) | null;
  folioShareStart?: StartupReads | null;
};

export function finishStartupReads() {
  page.folioStart = null;
  page.folioShareStart = null;
}

export function startupFetch(owner: AbortSignal) {
  const generation = authenticationSession.generation;
  return (path: string, options: RequestInit) => {
    const startup = page.folioStart;
    const headers = options.headers as Record<string, string>;
    const share = page.folioShareStart;
    if (share && authenticationSession.mode === "public" && headers["X-Folio-Share"] && !options.body) {
      const key = JSON.stringify([options.method, headers["X-Folio-Share"], path]);
      share.started.add(key);
      const result = share.reads.get(key);
      share.reads.delete(key);
      if (result && !headers["If-None-Match"] && performance.now() - share.at < 1500)
        return abortable(result, options.signal ?? owner);
    }
    const status = path === "/api/auth/status" && generation === authenticationSession.generation;
    if (status && !startup) finishStartupReads(); // Prevent the async script from starting a second request.
    if (startup && !appState.token && !options.body) {
      if (
        status ||
        (generation + 1 === authenticationSession.generation &&
          authenticationSession.mode === "users" &&
          startup.reader === authenticationSession.user?.username)
      ) {
        const key = JSON.stringify([options.method, headers["X-Folio-Project"] ?? "", path]);
        startup.started.add(key);
        const result = startup.reads.get(key);
        if (
          result &&
          !headers["If-None-Match"] &&
          (!path.startsWith("/api/document?") || performance.now() - startup.at < 1500)
        ) {
          startup.reads.delete(key);
          return abortable(result, options.signal ?? owner);
        }
      }
    }
    return fetch(path, options);
  };
}
