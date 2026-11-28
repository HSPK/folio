import { projectModel } from "../../state/projects";
import { authenticationSession } from "../../state/authentication";
import { documentSession } from "../../state/document";
import { libraryCatalog } from "../../state/library";
import { decodedPreferences as validatedPreferences } from "../../api/preferences";
import { createPreferenceDefaults, createHiddenPathMatcher, parseHiddenPatterns } from "@folio/model";
import { beginSettingsView, initializeSettingsSaving, preferencesRevision, settingsChanged } from "./saving";
import { applyAppearance } from "@folio/editor-runtime";
import type { Appearance, Preferences, SettingsSnapshot, WebPreferences } from "../../types/domain";
import { element, datasetValue, htmlChildren, requiredQuery, requireValue } from "../../types/elements";
import { errorContext } from "../../types/errors";
import { loadAccounts } from "../accounts/accounts";
import { closeMenus, handleAuthenticationFailure, selectNavigation, restoreSidebar } from "../accounts/authentication";
import { api } from "../core/api";
import { appearanceNotice } from "../core/appearance";
import { appState } from "../core/bootstrap";
import { notice, setText } from "../core/dom";
import { readLayoutPreference, setPageWidth, setSidebarWidth } from "../core/layout";
import { confirmAction, hasDialogConfirmation, showDialog } from "../dialogs/dialogs";
import { applicationSignal, listen, onApplicationDispose } from "../lifecycle";
import { setView } from "../navigation/files";
import { renderFiles, scheduleTreeRefresh } from "../navigation/library";

import { publicState } from "../sharing/public";
import { primaryShortcut } from "../../../shared/keyboard";
class SettingsState {
  sharedAppearance!: Appearance;
  webPreferences!: WebPreferences;
  preferencesLoaded!: boolean;
  hiddenPatterns!: string[];
  hiddenPath!: (path: string) => boolean;
  settingsSnapshot!: SettingsSnapshot | null;
  selectedSettingsTab!: string;
  settingsSearchOrigin!: {
    section: string;
    scrollTop: number;
  } | null;
  settingsSearchFrame!: number;
  settingsSearchStatus!: HTMLSpanElement;

  settingsSectionSelect!: HTMLSelectElement;
  settingsSectionButtons!: HTMLButtonElement[];
  settingsSectionOptions!: Map<string, HTMLOptionElement>;
}
export const settingsState = new SettingsState();
export function initializePreferencesSettings(): void {
  settingsState.sharedAppearance = { theme: "system", latinFont: "sans-serif", cjkFont: "sans-serif" };
  settingsState.webPreferences = createPreferenceDefaults();
  settingsState.preferencesLoaded = false;
  settingsState.hiddenPatterns = [];
  try {
    settingsState.hiddenPatterns = parseHiddenPatterns(readLayoutPreference(appState.HIDDEN_PATTERNS_KEY) ?? "");
  } catch (errorCause) {
    const error = errorContext(errorCause);
    console.warn("Ignoring invalid stored library hide patterns.", error);
    settingsState.hiddenPatterns = [];
  }
  settingsState.hiddenPath = createHiddenPathMatcher(settingsState.hiddenPatterns);
  settingsState.settingsSnapshot = null;
  settingsState.selectedSettingsTab = "editor";
  settingsState.settingsSearchOrigin = null;
  settingsState.settingsSearchFrame = 0;
  settingsState.settingsSearchStatus = document.createElement("span");
  const searchStatus = settingsState.settingsSearchStatus;
  onApplicationDispose(() => {
    cancelAnimationFrame(settingsState.settingsSearchFrame);
    searchStatus.remove();
    settingsState.settingsSectionSelect?.replaceChildren();
  });
  settingsState.settingsSearchStatus.className = "visually-hidden";
  settingsState.settingsSearchStatus.setAttribute("role", "status");
  element("settings-search").after(settingsState.settingsSearchStatus);

  initializeSettingsSaving({
    collect: collectSettings,
    apply: applySharedPreferences,
    preview: previewAppearanceSettings,
    shortcut: updateCommandShortcut,
    checkpoint: (snapshot) => {
      settingsState.settingsSnapshot = snapshot;
    },
  });
  settingsState.settingsSectionSelect = element("settings-section");
  settingsState.settingsSectionButtons = [...document.querySelectorAll<HTMLButtonElement>("[data-settings-tab]")];
  settingsState.settingsSectionOptions = new Map();
  for (const group of document.querySelectorAll<HTMLElement>("[data-settings-group]")) {
    const options = document.createElement("optgroup");
    options.label = datasetValue(group, "settingsGroup");
    for (const button of group.querySelectorAll<HTMLButtonElement>("[data-settings-tab]")) {
      const key = datasetValue(button, "settingsTab");
      const panel = document.querySelector<HTMLElement>(`[data-settings-panel="${key}"]`);
      button.id = `settings-tab-${key}`;
      requireValue(panel).id = `settings-panel-${key}`;
      requireValue(panel).setAttribute("role", "tabpanel");
      requireValue(panel).setAttribute("aria-labelledby", button.id);
      button.setAttribute("aria-controls", requireValue(panel).id);
      const option = document.createElement("option");
      option.value = key;
      option.textContent = button.textContent;
      options.append(option);
      settingsState.settingsSectionOptions.set(key, option);
    }
    settingsState.settingsSectionSelect.append(options);
  }
  updateCommandShortcut(appState.commandShortcut);
  listen(element("settings-open"), "click", () => {
    requiredQuery(document, "#more-menu > button", HTMLElement).focus({ preventScroll: true });
    openSettings();
  });
  listen(element("settings-close"), "click", () => void cancelSettings());
  listen(element("settings-cancel"), "click", () => void cancelSettings(true));

  listen(element("settings-dialog"), "cancel", (event) => {
    event.preventDefault();
    cancelSettings();
  });
  // The panel sits beside the library; pressing anywhere outside it returns to the document.
  listen(element("settings-dialog"), "pointerdown", (event) => {
    if (event.target !== element("settings-dialog")) return;
    const bounds = element("settings-dialog").getBoundingClientRect();
    const inside =
      event.clientX >= bounds.left &&
      event.clientX <= bounds.right &&
      event.clientY >= bounds.top &&
      event.clientY <= bounds.bottom;
    if (!inside && !hasDialogConfirmation(element("settings-dialog"))) cancelSettings();
  });
  listen(element("settings-search"), "input", filterSettings);
  listen(element("settings-page-width"), "change", () => setPageWidth(element("settings-page-width").value));
  listen(element("settings-sidebar-width"), "input", () => {
    const width = Number(element("settings-sidebar-width").value);
    element("settings-sidebar-value").value = `${width} px`;
    setSidebarWidth(width);
  });
  listen(element("settings-command-shortcut"), "change", () => {
    updateCommandShortcut(element("settings-command-shortcut").value);
  });
  for (const id of [
    "settings-theme",
    "settings-latin-font",
    "settings-cjk-font",
    "settings-font-size",
    "settings-line-height",
    "settings-density",
  ] as const) {
    listen(element(id), "input", previewAppearanceSettings);
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-settings-tab]")) {
    listen(button, "click", () => selectSettingsTab(datasetValue(button, "settingsTab")));
    listen(button, "keydown", (event) => {
      if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const options = settingsState.settingsSectionButtons.filter((option) => !option.hidden);
      const index = options.indexOf(button);
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? options.length - 1
            : (index + (event.key === "ArrowUp" ? -1 : 1) + options.length) % options.length;
      selectSettingsTab(datasetValue(options[next], "settingsTab"));
      options[next].focus();
    });
  }
  listen(settingsState.settingsSectionSelect, "change", () =>
    selectSettingsTab(settingsState.settingsSectionSelect.value),
  );
}
export function visibleLibraryFiles() {
  return libraryCatalog.files.filter((file) => !settingsState.hiddenPath(file.path));
}
export function visibleLibraryDirectories() {
  return libraryCatalog.directories.filter((directory) => !settingsState.hiddenPath(directory.path));
}
function selectSettingsTab(tab: string): void {
  if (!settingsState.settingsSectionOptions.has(tab)) throw new Error(`Unknown settings section: ${tab}`);
  if (tab === "users" && authenticationSession.user?.role !== "admin") tab = "editor";
  settingsState.selectedSettingsTab = tab;
  for (const button of settingsState.settingsSectionButtons) {
    const selected = button.dataset.settingsTab === tab;
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
    if (selected && element("settings-dialog").open && button.getClientRects().length) {
      button.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }
  for (const panel of document.querySelectorAll<HTMLElement>("[data-settings-panel]")) {
    panel.hidden = panel.dataset.settingsPanel !== tab;
  }
  element("settings-empty").hidden = true;
  syncSettingsNavigation();
  locateSettingsMatch();
  if (tab === "users") void loadAccounts();
}
function locateSettingsMatch(): void {
  cancelAnimationFrame(settingsState.settingsSearchFrame);
  if (!element("settings-search").value.trim()) return;
  settingsState.settingsSearchFrame = requestAnimationFrame(() => {
    settingsState.settingsSearchFrame = 0;
    if (!element("settings-dialog").open || !element("settings-search").value.trim()) return;
    const content = element("settings-dialog").querySelector<HTMLElement>(".settings-content");
    const matches = [
      ...element("settings-dialog").querySelectorAll<HTMLElement>(".settings-panel:not([hidden]) [data-search-match]"),
    ];
    settingsState.settingsSearchStatus.textContent = matches.length
      ? `${matches.length} matching setting${matches.length === 1 ? "" : "s"} in this section.`
      : element("settings-empty").hidden
        ? "Matching section."
        : "No matching settings.";
    if (matches[0])
      requireValue(content).scrollTop +=
        matches[0].getBoundingClientRect().top - requireValue(content).getBoundingClientRect().top - 16;
    else requireValue(content).scrollTop = 0;
  });
}
function syncSettingsNavigation(): void {
  let visible = 0;
  for (const button of settingsState.settingsSectionButtons) {
    const option = settingsState.settingsSectionOptions.get(datasetValue(button, "settingsTab"));
    requireValue(option).hidden = button.hidden;
    requireValue(option).disabled = Boolean(button.hidden);
    if (!button.hidden) visible++;
  }
  for (const group of htmlChildren(settingsState.settingsSectionSelect))
    group.hidden = htmlChildren(group).every((option) => option.hidden);
  settingsState.settingsSectionSelect.disabled = visible === 0;
  settingsState.settingsSectionSelect.value = requireValue(
    settingsState.settingsSectionOptions.get(settingsState.selectedSettingsTab),
  ).hidden
    ? ""
    : settingsState.selectedSettingsTab;
}
function filterSettings(): void {
  const query = element("settings-search").value.trim().toLowerCase();
  cancelAnimationFrame(settingsState.settingsSearchFrame);
  const content = element("settings-dialog").querySelector<HTMLElement>(".settings-content");
  if (!query) {
    for (const card of element("settings-dialog").querySelectorAll<HTMLElement>("[data-search-match]"))
      card.removeAttribute("data-search-match");
    for (const button of settingsState.settingsSectionButtons) {
      button.hidden = button.hasAttribute("data-admin-only") && authenticationSession.user?.role !== "admin";
    }
    selectSettingsTab(settingsState.settingsSearchOrigin?.section ?? settingsState.selectedSettingsTab);
    if (settingsState.settingsSearchOrigin)
      requireValue(content).scrollTop = settingsState.settingsSearchOrigin.scrollTop;
    settingsState.settingsSearchOrigin = null;
    settingsState.settingsSearchStatus.textContent = "";
    return;
  }
  settingsState.settingsSearchOrigin ??= {
    section: settingsState.selectedSettingsTab,
    scrollTop: requireValue(content).scrollTop,
  };
  const terms = query.split(/\s+/);
  const matches = (text: string) => terms.every((term) => text.toLowerCase().includes(term));
  let firstVisible = null;
  let selectedVisible = false;
  for (const button of settingsState.settingsSectionButtons) {
    const panel = document.querySelector<HTMLElement>(`[data-settings-panel="${datasetValue(button, "settingsTab")}"]`);
    for (const card of requireValue(panel).querySelectorAll<HTMLElement>(".setting-card, .project-field")) {
      card.toggleAttribute("data-search-match", matches(card.textContent));
    }
    const visible =
      (!button.hasAttribute("data-admin-only") || authenticationSession.user?.role === "admin") &&
      matches(`${button.textContent} ${requireValue(panel).textContent}`);
    button.hidden = !visible;
    if (visible) firstVisible ??= datasetValue(button, "settingsTab");
    if (visible && button.getAttribute("aria-selected") === "true") selectedVisible = true;
  }
  if (!selectedVisible && firstVisible) selectSettingsTab(firstVisible);
  if (!firstVisible) {
    for (const panel of document.querySelectorAll<HTMLElement>("[data-settings-panel]")) panel.hidden = true;
    element("settings-empty").hidden = false;
  }
  syncSettingsNavigation();
  locateSettingsMatch();
}
function updateCommandShortcut(value: string): void {
  appState.commandShortcut = value === "primary-shift-p" ? value : "primary-k";
  element("command-palette-open").title =
    `Commands (${primaryShortcut(appState.commandShortcut === "primary-shift-p" ? "Shift+P" : "K")})`;
  requiredQuery(element("command-palette-open"), "kbd", HTMLElement).textContent = primaryShortcut(
    appState.commandShortcut === "primary-shift-p" ? "Shift+P" : "K",
  );
}

function applySharedPreferences(value: Preferences, initial = false): void {
  settingsState.sharedAppearance = value.appearance;
  settingsState.webPreferences = value.web;
  settingsState.hiddenPatterns = parseHiddenPatterns(settingsState.webPreferences.hiddenPatterns.join("\n"));
  settingsState.hiddenPath = createHiddenPathMatcher(settingsState.hiddenPatterns);
  const root = document.documentElement;
  root.style.setProperty("--document-size", `${settingsState.webPreferences.fontSizePx}px`);
  root.style.setProperty("--document-line-height", String(settingsState.webPreferences.lineHeightPercent / 100));
  root.style.setProperty("--source-size", `${Math.max(12, settingsState.webPreferences.fontSizePx - 2)}px`);
  root.dataset.density = settingsState.webPreferences.density;
  root.dataset.reducedMotion = String(settingsState.webPreferences.reducedMotion);
  root.dataset.highContrast = String(settingsState.webPreferences.highContrast);
  root.dataset.strongFocus = String(settingsState.webPreferences.strongFocus);
  appState.editor.setLineWrapping(settingsState.webPreferences.sourceLineWrap);
  appState.editor.setThreshold(settingsState.webPreferences.largeDocumentThresholdKib * 1024);
  appState.inlineEditor.setSpellcheck(settingsState.webPreferences.spellcheck);
  void applyAppearance(settingsState.sharedAppearance).then((result) => appearanceNotice(result.warning));
  if (initial && !documentSession.current) {
    setView(
      {
        live: "rich",
        source: "editor",
        compare: "split",
        read: "preview",
      }[settingsState.webPreferences.defaultView],
    );
    selectNavigation(settingsState.webPreferences.defaultSidebar);
    restoreSidebar(!appState.compactLayout.matches && settingsState.webPreferences.sidebarOpen);
  }
  if (libraryCatalog.loaded) renderFiles();
  scheduleTreeRefresh();
}
let recentPreferences: { owner: symbol; time: number } | undefined;
export async function refreshSharedPreferences(signal?: AbortSignal, reuseRecent = false): Promise<void> {
  if (publicState.publicView) return;
  const owner = applicationSignal();
  const scope = authenticationSession.scope;
  if (reuseRecent && recentPreferences?.owner === scope.key && performance.now() - recentPreferences.time < 30_000)
    return;
  const revision = preferencesRevision();
  const requestSignal = AbortSignal.any([owner, scope.signal, ...(signal ? [signal] : [])]);
  const current = () =>
    !requestSignal.aborted && authenticationSession.isCurrent(scope) && revision === preferencesRevision();
  try {
    const preferences = await api("/api/preferences", {
      decode: validatedPreferences,
      signal: requestSignal,
      timeoutMs: 15000,
    });
    if (!current()) return;
    if (!preferences.web.hiddenPatterns.length && settingsState.hiddenPatterns.length) {
      preferences.web.hiddenPatterns = [...settingsState.hiddenPatterns];
    }
    applySharedPreferences(preferences, !settingsState.preferencesLoaded);
    settingsState.preferencesLoaded = true;
    recentPreferences = { owner: scope.key, time: performance.now() };
  } catch (errorCause) {
    if (!current()) return;
    const error = errorContext(errorCause);
    if (isConnectionLoss(error) && signal) throw error;
    if (!handleAuthenticationFailure(error)) appearanceNotice(`Settings failed: ${error.message}`);
  }
}
function populateSettings(): void {
  element("settings-image-compression").value = settingsState.webPreferences.imageCompression;
  element("settings-image-max-edge").value = String(settingsState.webPreferences.imageMaxEdge);
  element("settings-image-quality").value = String(settingsState.webPreferences.imageQuality);
  requiredQuery(document, "#settings-image-quality-value", HTMLOutputElement).value =
    `${settingsState.webPreferences.imageQuality}%`;
  element("settings-image-directory").value =
    projectModel.active?.imageDirectory ?? settingsState.webPreferences.imageDirectory;
  element("settings-image-directory").disabled = authenticationSession.mode === "users" && !projectModel.active?.owned;
  element("settings-auto-save").value = String(settingsState.webPreferences.autoSaveDelayMs);
  element("settings-default-view").value = settingsState.webPreferences.defaultView;
  element("settings-line-wrap").checked = settingsState.webPreferences.sourceLineWrap;
  element("settings-spellcheck").checked = settingsState.webPreferences.spellcheck;
  element("settings-theme").value = settingsState.sharedAppearance.theme;
  element("settings-latin-font").value = settingsState.sharedAppearance.latinFont;
  element("settings-cjk-font").value = settingsState.sharedAppearance.cjkFont;
  element("settings-font-size").value = String(settingsState.webPreferences.fontSizePx);
  element("settings-font-size-value").value = `${settingsState.webPreferences.fontSizePx} px`;
  element("settings-line-height").value = String(settingsState.webPreferences.lineHeightPercent);
  element("settings-line-height-value").value = `${settingsState.webPreferences.lineHeightPercent}%`;
  element("settings-density").value = settingsState.webPreferences.density;
  setText(element("settings-library-label"), projectModel.active ? "Current project" : "Current folder");
  element("settings-projects-open").hidden = authenticationSession.mode !== "users";
  element("settings-library-root").value =
    projectModel.active?.name ??
    appState.currentRoot?.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "") ??
    "Not connected";
  element("hidden-patterns").value = settingsState.hiddenPatterns.join("\n");
  element("settings-tree-refresh").value = String(settingsState.webPreferences.treeRefreshSeconds);
  element("settings-page-width").value = document.documentElement.dataset.pageWidth || "balanced";
  element("settings-sidebar-width").value = String(appState.preferredSidebarWidth);
  element("settings-sidebar-value").value = `${appState.preferredSidebarWidth} px`;
  element("settings-default-sidebar").value = settingsState.webPreferences.defaultSidebar;
  element("settings-sidebar-open").checked = settingsState.webPreferences.sidebarOpen;
  element("settings-large-threshold").value = String(settingsState.webPreferences.largeDocumentThresholdKib);
  element("settings-preview-delay").value = String(settingsState.webPreferences.previewDelayMs);
  element("settings-outline-delay").value = String(settingsState.webPreferences.outlineDelayMs);
  element("settings-reduced-motion").checked = settingsState.webPreferences.reducedMotion;
  element("settings-high-contrast").checked = settingsState.webPreferences.highContrast;
  element("settings-strong-focus").checked = settingsState.webPreferences.strongFocus;
  element("settings-command-shortcut").value = appState.commandShortcut;
}
function collectSettings() {
  const patterns = parseHiddenPatterns(element("hidden-patterns").value);
  return validatedPreferences({
    appearance: {
      theme: element("settings-theme").value,
      latinFont: element("settings-latin-font").value.trim(),
      cjkFont: element("settings-cjk-font").value.trim(),
    },
    web: {
      imageCompression: element("settings-image-compression").value,
      imageMaxEdge: Number(element("settings-image-max-edge").value),
      imageQuality: Number(element("settings-image-quality").value),
      imageDirectory: projectModel.active
        ? settingsState.webPreferences.imageDirectory
        : element("settings-image-directory").value.trim(),
      autoSaveDelayMs: Number(element("settings-auto-save").value),
      defaultView: element("settings-default-view").value,
      sourceLineWrap: element("settings-line-wrap").checked,
      spellcheck: element("settings-spellcheck").checked,
      fontSizePx: Number(element("settings-font-size").value),
      lineHeightPercent: Number(element("settings-line-height").value),
      density: element("settings-density").value,
      defaultSidebar: element("settings-default-sidebar").value,
      sidebarOpen: element("settings-sidebar-open").checked,
      hiddenPatterns: patterns,
      treeRefreshSeconds: Number(element("settings-tree-refresh").value),
      largeDocumentThresholdKib: Number(element("settings-large-threshold").value),
      previewDelayMs: Number(element("settings-preview-delay").value),
      outlineDelayMs: Number(element("settings-outline-delay").value),
      reducedMotion: element("settings-reduced-motion").checked,
      highContrast: element("settings-high-contrast").checked,
      strongFocus: element("settings-strong-focus").checked,
    },
  });
}
export function openSettings(): void {
  const tab = settingsState.selectedSettingsTab;
  if (publicState.publicView) return;
  if (element("settings-dialog").open || !element("auth-screen").hidden) return;
  closeMenus();
  populateSettings();
  element("settings-search").value = "";
  settingsState.settingsSearchOrigin = null;
  settingsState.settingsSnapshot = {
    preferences: {
      appearance: { ...settingsState.sharedAppearance },
      web: { ...settingsState.webPreferences, hiddenPatterns: [...settingsState.hiddenPatterns] },
    },
    pageWidth: document.documentElement.dataset.pageWidth || "balanced",
    sidebarWidth: appState.preferredSidebarWidth,
    commandShortcut: appState.commandShortcut,
  };
  beginSettingsView();
  notice(element("settings-error"), "");
  filterSettings();
  showDialog(element("settings-dialog"));
  selectSettingsTab(tab);
  // Opening settings is not a search: focus the dialog itself and leave the field for those who want it.
  element("settings-dialog").focus({ preventScroll: true });
}
export async function cancelSettings(discard = false): Promise<boolean> {
  if (
    !discard &&
    settingsChanged() &&
    !(await confirmAction("Discard your unsaved settings?", {
      label: "Discard changes",
      tone: "destructive",
      dialog: element("settings-dialog"),
      signal: authenticationSession.scope.signal,
    }))
  )
    return false;
  if (settingsState.settingsSnapshot) {
    applySharedPreferences(settingsState.settingsSnapshot.preferences);
    setPageWidth(settingsState.settingsSnapshot.pageWidth);
    setSidebarWidth(settingsState.settingsSnapshot.sidebarWidth);
    updateCommandShortcut(settingsState.settingsSnapshot.commandShortcut);
  }
  settingsState.settingsSnapshot = null;
  if (element("settings-dialog").open) element("settings-dialog").close();
  return true;
}

function previewAppearanceSettings(): void {
  const fontSize = Number(element("settings-font-size").value);
  const lineHeight = Number(element("settings-line-height").value);
  element("settings-font-size-value").value = `${fontSize} px`;
  element("settings-line-height-value").value = `${lineHeight}%`;
  document.documentElement.style.setProperty("--document-size", `${fontSize}px`);
  document.documentElement.style.setProperty("--document-line-height", String(lineHeight / 100));
  document.documentElement.dataset.density = element("settings-density").value;
  void applyAppearance({
    theme: element("settings-theme").value,
    latinFont: element("settings-latin-font").value.trim() || settingsState.sharedAppearance.latinFont,
    cjkFont: element("settings-cjk-font").value.trim() || settingsState.sharedAppearance.cjkFont,
  });
}

import { isConnectionLoss } from "../core/recovery";
