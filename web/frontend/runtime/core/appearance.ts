import { decodedAppearance } from "../../api/contracts";
import { applyAppearance } from "@folio/editor-runtime";
import { element, clearTimer } from "../../types/elements";
import { errorContext } from "../../types/errors";
import { settingsState } from "../preferences/settings";
import { publicState } from "../sharing/public";
import { api } from "./api";
import { appState } from "./bootstrap";
import { connectionFailure } from "../accounts/authentication";
import { isConnectionLoss } from "./recovery";
import { ApiError, notice } from "./dom";
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
  if (element("appearance-message").textContent === message && element("appearance-message").hidden === !message)
    return;
  notice(element("appearance-message"), message, message ? "warning" : "");
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
    if (isConnectionLoss(error) || timedOut) {
      appearanceNotice("");
      connectionFailure(timedOut ? new ApiError("Timed out", 408) : error);
    } else appearanceNotice(`Appearance load failed: ${error.message}`);
  } finally {
    clearTimer(timeout);
    if (appState.appearanceController === controller) {
      appState.appearanceController = null;
      scheduleAppearancePolling();
    }
  }
}
