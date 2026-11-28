import { decodedPreferences } from "../../api/preferences";
import type { Preferences, SettingsSnapshot } from "@folio/model";
import { createSettingsSaver, SettingsSaveError } from "../../services/settings-saving";
import { authenticationSession } from "../../state/authentication";
import { projectModel } from "../../state/projects";
import { element, requireValue } from "../../types/elements";
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
  shortcut: (value: string) => void;
  checkpoint: (snapshot: SettingsSnapshot | null) => void;
}

let view: {
  selection: symbol;
  project: typeof projectModel.active;
  signature: string;
  submitted: string | null;
} | null = null;
let revision = 0;
export const preferencesRevision = () => revision;
export function beginSettingsView() {
  view = {
    selection: projectModel.selection,
    project: projectModel.active,
    signature: formSignature(),
    submitted: null,
  };
}
export const settingsChanged = () => view !== null && formSignature() !== (view.submitted ?? view.signature);

function formSignature() {
  return JSON.stringify(
    [
      ...element("settings-form").querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
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
  listen(element("settings-dialog"), "close", () => {
    if (!element("settings-dialog").open) view = null;
  });
  onApplicationDispose(() => {
    view = null;
    revision++;
  });
  listen(element("settings-form"), "submit", async (event) => {
    event.preventDefault();
    if (operation) return;
    const opened = requireValue(view, "Settings view");
    const scope = authenticationSession.scope;
    const current = () => !owner.aborted && authenticationSession.isCurrent(scope);
    if (opened.selection !== projectModel.selection) {
      notice(element("settings-error"), "Project changed, reopen Settings", "error");
      return;
    }
    const saving = Symbol("settings-save");
    operation = saving;
    element("settings-save").disabled = true;
    element("settings-save").textContent = "Saving…";
    element("settings-form").setAttribute("aria-busy", "true");
    notice(element("settings-error"), "");
    try {
      const preferences = ports.collect();
      const layout = {
        pageWidth: element("settings-page-width").value,
        sidebarWidth: Number(element("settings-sidebar-width").value),
        commandShortcut: element("settings-command-shortcut").value,
      };
      const signature = formSignature();
      opened.submitted = signature;
      const directory = element("settings-image-directory").value.trim();
      const project =
        opened.project?.owned && directory !== opened.project.imageDirectory
          ? { id: opened.project.id, imageDirectory: directory }
          : null;
      revision++;
      const result = await saver.save({ preferences, project });
      if (!current()) return;
      revision++;
      opened.signature = signature;
      const unchanged = view === opened && opened.selection === projectModel.selection && formSignature() === signature;
      ports.apply(result.preferences);
      storeLayoutPreference(appState.HIDDEN_PATTERNS_KEY, result.preferences.web.hiddenPatterns.join("\n"));
      storeLayoutPreference(appState.PAGE_WIDTH_KEY, layout.pageWidth);
      storeLayoutPreference(appState.SIDEBAR_WIDTH_KEY, layout.sidebarWidth);
      storeLayoutPreference(appState.COMMAND_SHORTCUT_KEY, layout.commandShortcut);
      if (element("settings-dialog").open) ports.checkpoint({ preferences: result.preferences, ...layout });
      if (unchanged || !element("settings-dialog").open) {
        setPageWidth(layout.pageWidth);
        setSidebarWidth(layout.sidebarWidth);
        ports.shortcut(layout.commandShortcut);
      } else {
        ports.preview();
      }
      if (unchanged) {
        ports.checkpoint(null);
        element("settings-dialog").close();
      } else if (element("settings-dialog").open) {
        notice(
          element("settings-error"),
          opened.selection === projectModel.selection ? "Saved; newer edits unsaved" : "Saved for the original project",
          "warning",
        );
      } else documentNotice("Saved");
    } catch (cause) {
      if (!current() || isAbortError(cause)) return;
      const error = errorContext(cause);
      const message =
        cause instanceof SettingsSaveError && cause.projectSaved ? `Partly saved: ${error.message}` : error.message;
      if (view === opened && element("settings-dialog").open) notice(element("settings-error"), message, "error");
      else documentNotice(message, "error");
    } finally {
      opened.submitted = null;
      if (operation === saving) {
        operation = null;
        if (!owner.aborted) {
          element("settings-save").disabled = false;
          element("settings-save").textContent = "Save";
          element("settings-form").setAttribute("aria-busy", "false");
        }
      }
    }
  });
}
