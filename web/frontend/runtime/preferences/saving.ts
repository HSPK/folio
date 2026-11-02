import { decodedPreferences } from "../../api/preferences";
import type { Preferences, SettingsSnapshot } from "../../models/preferences";
import { createSettingsSaver, SettingsSaveError } from "../../services/settings-saving";
import { authenticationSession } from "../../state/authentication";
import { projectModel } from "../../state/projects";
import { requireValue } from "../../types/elements";
import { errorContext } from "../../types/errors";
import { isAbortError } from "../../api/error";
import { api } from "../core/api";
import { appState } from "../core/bootstrap";
import { documentNotice, notice } from "../core/dom";
import { setPageWidth, setSidebarWidth, storeLayoutPreference } from "../core/layout";
import { applicationSignal, listen, onApplicationDispose } from "../lifecycle";
import { changeProject } from "../projects/gateway";

interface SettingsUiPorts {
  collect: () => Preferences;
  apply: (preferences: Preferences) => void;
  preview: () => void;
  shortcut: (value: string, persist?: boolean) => void;
  checkpoint: (snapshot: SettingsSnapshot | null) => void;
}

let view: { id: symbol; selection: symbol; project: typeof projectModel.active } | null = null;
let revision = 0;
export const preferencesRevision = () => revision;
export function beginSettingsView() {
  view = { id: Symbol("settings-view"), selection: projectModel.selection, project: projectModel.active };
}

function formSignature() {
  return JSON.stringify(
    [
      ...appState.ui.settingsForm.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
        "input, select, textarea",
      ),
    ]
      .filter(
        (node) =>
          node.id !== "settings-search" &&
          node.id !== "settings-section" &&
          !node.closest('[data-settings-panel="users"]'),
      )
      .map((node) => [
        node.id,
        node instanceof HTMLInputElement && node.type === "checkbox" ? node.checked : node.value,
      ]),
  );
}

export function initializeSettingsSaving(ports: SettingsUiPorts): void {
  const owner = applicationSignal();
  view = null;
  revision++;
  let operation: symbol | null = null;
  const saver = createSettingsSaver({
    signal: owner,
    scope: () => authenticationSession.scope,
    project: projectModel.get,
    updateProject: (id, imageDirectory) => changeProject({ action: "share", id, imageDirectory }),
    writePreferences: (body, signal) =>
      api("/api/preferences", { decode: decodedPreferences, method: "PUT", body, signal, timeoutMs: 15000 }),
  });
  listen(appState.ui.settingsDialog, "close", () => {
    if (!appState.ui.settingsDialog.open) view = null;
  });
  onApplicationDispose(() => {
    view = null;
    revision++;
  });
  listen(appState.ui.settingsForm, "submit", async (event) => {
    event.preventDefault();
    if (operation) return;
    const opened = requireValue(view, "Settings view");
    const scope = authenticationSession.scope;
    const current = () => !owner.aborted && authenticationSession.isCurrent(scope);
    if (opened.selection !== projectModel.selection) {
      notice(appState.ui.settingsError, "The active project changed. Reopen Settings before saving.", "error");
      return;
    }
    const saving = Symbol("settings-save");
    operation = saving;
    appState.element("settings-save").disabled = true;
    notice(appState.ui.settingsError, "");
    try {
      const preferences = ports.collect();
      const layout = {
        pageWidth: appState.ui.settingsPageWidth.value,
        sidebarWidth: Number(appState.ui.settingsSidebarWidth.value),
        commandShortcut: appState.ui.settingsCommandShortcut.value,
      };
      const signature = formSignature();
      const directory = appState.element("settings-image-directory").value.trim();
      const project =
        opened.project?.owned && directory !== opened.project.imageDirectory
          ? { id: opened.project.id, imageDirectory: directory }
          : null;
      revision++;
      const result = await saver.save({ preferences, project });
      if (!current()) return;
      revision++;
      const unchanged = view === opened && opened.selection === projectModel.selection && formSignature() === signature;
      ports.apply(result.preferences);
      storeLayoutPreference(appState.HIDDEN_PATTERNS_KEY, result.preferences.web.hiddenPatterns.join("\n"));
      storeLayoutPreference(appState.PAGE_WIDTH_KEY, layout.pageWidth);
      storeLayoutPreference(appState.SIDEBAR_WIDTH_KEY, layout.sidebarWidth);
      storeLayoutPreference(appState.COMMAND_SHORTCUT_KEY, layout.commandShortcut);
      if (appState.ui.settingsDialog.open) ports.checkpoint({ preferences: result.preferences, ...layout });
      if (unchanged || !appState.ui.settingsDialog.open) {
        setPageWidth(layout.pageWidth);
        setSidebarWidth(layout.sidebarWidth);
        ports.shortcut(layout.commandShortcut);
      } else {
        ports.preview();
      }
      if (unchanged) {
        ports.checkpoint(null);
        appState.ui.settingsDialog.close();
      } else if (appState.ui.settingsDialog.open) {
        notice(
          appState.ui.settingsError,
          opened.selection === projectModel.selection
            ? "Submitted settings were saved. Newer edits remain unsaved."
            : "Settings for the original project were saved. Reopen Settings for the active project.",
          "warning",
        );
      } else documentNotice("Settings saved.");
    } catch (cause) {
      if (!current() || isAbortError(cause)) return;
      const error = errorContext(cause);
      const message =
        cause instanceof SettingsSaveError && cause.projectSaved
          ? `The project image directory was saved, but other settings could not be confirmed. ${error.message} Retry to save the remaining settings.`
          : error.message;
      if (view === opened && appState.ui.settingsDialog.open) notice(appState.ui.settingsError, message, "error");
      else documentNotice(message, "error");
    } finally {
      if (operation === saving) {
        operation = null;
        if (!owner.aborted) appState.element("settings-save").disabled = false;
      }
    }
  });
}
