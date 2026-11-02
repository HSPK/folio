import { decodedAppearance } from "../../api/contracts";
import { applyAppearance } from "@folio/editor-runtime";
import { clearTimer } from "../../types/elements";
import { errorContext } from "../../types/errors";
import { settingsState } from "../preferences/settings";
import { publicState } from "../sharing/public";
import { api } from "./api";
import { appState } from "./bootstrap";
import { notice } from "./dom";
export function stopAppearancePolling(): void {
  clearTimer(appState.appearanceTimer);
  appState.appearanceTimer = null;
  appState.appearanceGeneration += 1;
  appState.appearanceController?.abort();
  appState.appearanceController = null;
}
export function scheduleAppearancePolling(): void {
  clearTimer(appState.appearanceTimer);
  appState.appearanceTimer = null;
  if (appState.connectionState === "ready" && document.visibilityState === "visible" && document.hasFocus()) {
    appState.appearanceTimer = window.setTimeout(() => void refreshAppearance(), 2000);
  }
}
export function appearanceNotice(message: string): void {
  if (appState.ui.appearanceMessage.textContent === message && appState.ui.appearanceMessage.hidden === !message)
    return;
  notice(appState.ui.appearanceMessage, message, message ? "warning" : "");
}
export async function refreshAppearance(force = false): Promise<void> {
  if (publicState.publicView) return;
  if (appState.connectionState !== "ready" || document.visibilityState === "hidden") return;
  if (appState.appearanceController && !force) return;
  if (!force && !document.hasFocus()) return;
  clearTimer(appState.appearanceTimer);
  appState.appearanceTimer = null;
  appState.appearanceController?.abort();
  const controller = new AbortController();
  appState.appearanceController = controller;
  const ticket = ++appState.appearanceGeneration;
  let timedOut = false;
  const timeout = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 5000);
  try {
    const settings = await api("/api/appearance", {
      decode: decodedAppearance,
      signal: controller.signal,
    });
    clearTimer(timeout);
    if (ticket !== appState.appearanceGeneration || controller.signal.aborted) return;
    const result = await applyAppearance(settings);
    settingsState.sharedAppearance = settings;
    if (ticket !== appState.appearanceGeneration || controller.signal.aborted) return;
    appearanceNotice(result.warning);
  } catch (errorCause) {
    const error = errorContext(errorCause);
    if (ticket !== appState.appearanceGeneration || (controller.signal.aborted && !timedOut)) return;
    appearanceNotice(
      `Appearance settings could not be loaded. ${timedOut ? "The request timed out." : error.message} Your note is unchanged.`,
    );
  } finally {
    clearTimer(timeout);
    if (appState.appearanceController === controller) {
      appState.appearanceController = null;
      scheduleAppearancePolling();
    }
  }
}
