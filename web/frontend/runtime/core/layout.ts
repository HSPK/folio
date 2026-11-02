import { errorContext } from "../../types/errors";
import { appState } from "./bootstrap";

export function initializeCoreLayout(): void {
  appState.preferredSidebarWidth = Number.parseInt(readLayoutPreference(appState.SIDEBAR_WIDTH_KEY) ?? "", 10);
  if (!Number.isFinite(appState.preferredSidebarWidth)) appState.preferredSidebarWidth = appState.SIDEBAR_DEFAULT;
  appState.commandShortcut = readLayoutPreference(appState.COMMAND_SHORTCUT_KEY) ?? "primary-k";
  if (!["primary-k", "primary-shift-p"].includes(appState.commandShortcut)) appState.commandShortcut = "primary-k";
  setSidebarWidth(appState.preferredSidebarWidth);
  setPageWidth(readLayoutPreference(appState.PAGE_WIDTH_KEY));
}

export function readLayoutPreference(key: string) {
  try {
    return window.localStorage.getItem(key);
  } catch (errorCause) {
    const error = errorContext(errorCause);

    console.warn(`Could not read ${key}.`, error);
    return null;
  }
}

export function storeLayoutPreference(key: string, value: string | number): void {
  try {
    window.localStorage.setItem(key, String(value));
  } catch (errorCause) {
    const error = errorContext(errorCause);

    console.warn(`Could not save ${key}.`, error);
  }
}

export function visibleSidebarWidth(width: number) {
  const viewportMaximum = Math.max(appState.SIDEBAR_MIN, window.innerWidth - 320);
  return Math.round(Math.min(appState.SIDEBAR_MAX, viewportMaximum, Math.max(appState.SIDEBAR_MIN, width)));
}

export function setSidebarWidth(width: number, persist = false): void {
  appState.preferredSidebarWidth = Math.round(Math.min(appState.SIDEBAR_MAX, Math.max(appState.SIDEBAR_MIN, width)));
  const visible = visibleSidebarWidth(appState.preferredSidebarWidth);
  document.documentElement.style.setProperty("--sidebar-width", `${visible}px`);
  appState.ui.sidebarResizer.setAttribute("aria-valuenow", String(visible));
  if (persist) storeLayoutPreference(appState.SIDEBAR_WIDTH_KEY, appState.preferredSidebarWidth);
}

export function setPageWidth(value: string | null | undefined, persist = false): void {
  const width = typeof value === "string" && appState.pageWidths.has(value) ? value : "balanced";
  document.documentElement.dataset.pageWidth = width;
  for (const button of document.querySelectorAll<HTMLElement>("[data-page-width]")) {
    button.setAttribute("aria-pressed", String(button.dataset.pageWidth === width));
  }
  if (persist) storeLayoutPreference(appState.PAGE_WIDTH_KEY, width);
}
