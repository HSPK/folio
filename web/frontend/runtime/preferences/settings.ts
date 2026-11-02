import { projectModel } from "../../state/projects";
import { authenticationSession } from "../../state/authentication";
import { documentSession } from "../../state/document";
import { libraryCatalog } from "../../state/library";
import { decodedPreferences as validatedPreferences } from "../../api/preferences";
import { createPreferenceDefaults } from "../../models/preferences";
import { beginSettingsView, initializeSettingsSaving, preferencesRevision } from "./saving";
import { applyAppearance } from "@folio/editor-runtime";
import { createHiddenPathMatcher, parseHiddenPatterns } from "@folio/model";
import type { Appearance, Preferences, SettingsSnapshot, WebPreferences } from "../../types/domain";
import { datasetValue, htmlChildren, requiredQuery, requireValue } from "../../types/elements";
import { errorContext } from "../../types/errors";
import { loadAccounts } from "../accounts/accounts";
import { closeMenus, handleAuthenticationFailure, selectNavigation, setSidebar } from "../accounts/authentication";
import { api } from "../core/api";
import { appearanceNotice } from "../core/appearance";
import { appState } from "../core/bootstrap";
import { closeCommandPanel } from "../core/commands";
import { notice, setText } from "../core/dom";
import { readLayoutPreference, setPageWidth, setSidebarWidth, storeLayoutPreference } from "../core/layout";
import { showDialog } from "../dialogs/dialogs";
import { applicationSignal, listen, onApplicationDispose } from "../lifecycle";
import { setView } from "../navigation/files";
import { renderFiles, scheduleTreeRefresh } from "../navigation/library";

import { publicState } from "../sharing/public";
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
  settingsUi!: ReturnType<typeof createSettingsUi>;
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
  appState.ui.settingsSearch.after(settingsState.settingsSearchStatus);
  settingsState.settingsUi = createSettingsUi();
  initializeSettingsSaving({
    collect: collectSettings,
    apply: applySharedPreferences,
    preview: previewAppearanceSettings,
    shortcut: updateCommandShortcut,
    checkpoint: (snapshot) => {
      settingsState.settingsSnapshot = snapshot;
    },
  });
  settingsState.settingsSectionSelect = appState.element("settings-section");
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
  listen(appState.ui.settingsOpen, "click", () => {
    requiredQuery(document, "#more-menu > summary", HTMLElement).focus({ preventScroll: true });
    openSettings();
  });
  listen(appState.ui.settingsClose, "click", cancelSettings);
  listen(appState.ui.settingsCancel, "click", cancelSettings);

  listen(appState.ui.settingsDialog, "cancel", (event) => {
    event.preventDefault();
    cancelSettings();
  });
  listen(appState.ui.settingsSearch, "input", filterSettings);
  listen(appState.ui.settingsPageWidth, "change", () => setPageWidth(appState.ui.settingsPageWidth.value));
  listen(appState.ui.settingsSidebarWidth, "input", () => {
    const width = Number(appState.ui.settingsSidebarWidth.value);
    appState.ui.settingsSidebarValue.value = `${width} px`;
    setSidebarWidth(width);
  });
  listen(appState.ui.settingsCommandShortcut, "change", () => {
    updateCommandShortcut(appState.ui.settingsCommandShortcut.value);
  });
  for (const name of ["theme", "latin_font", "cjk_font", "font_size", "line_height", "density"] as const) {
    listen(settingsState.settingsUi[name], "input", previewAppearanceSettings);
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
export function selectSettingsTab(tab: string): void {
  if (!settingsState.settingsSectionOptions.has(tab)) throw new Error(`Unknown settings section: ${tab}`);
  if (tab === "users" && authenticationSession.user?.role !== "admin") tab = "editor";
  settingsState.selectedSettingsTab = tab;
  for (const button of settingsState.settingsSectionButtons) {
    const selected = button.dataset.settingsTab === tab;
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
    if (selected && appState.ui.settingsDialog.open && button.getClientRects().length) {
      button.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }
  for (const panel of document.querySelectorAll<HTMLElement>("[data-settings-panel]")) {
    panel.hidden = panel.dataset.settingsPanel !== tab;
  }
  appState.element("settings-empty").hidden = true;
  syncSettingsNavigation();
  locateSettingsMatch();
  if (tab === "users") void loadAccounts();
}
export function locateSettingsMatch(): void {
  cancelAnimationFrame(settingsState.settingsSearchFrame);
  if (!appState.ui.settingsSearch.value.trim()) return;
  settingsState.settingsSearchFrame = requestAnimationFrame(() => {
    settingsState.settingsSearchFrame = 0;
    if (!appState.ui.settingsDialog.open || !appState.ui.settingsSearch.value.trim()) return;
    const content = appState.ui.settingsDialog.querySelector<HTMLElement>(".settings-content");
    const matches = [
      ...appState.ui.settingsDialog.querySelectorAll<HTMLElement>(".settings-panel:not([hidden]) [data-search-match]"),
    ];
    settingsState.settingsSearchStatus.textContent = matches.length
      ? `${matches.length} matching setting${matches.length === 1 ? "" : "s"} in this section.`
      : appState.element("settings-empty").hidden
        ? "Matching section."
        : "No matching settings.";
    if (matches[0])
      requireValue(content).scrollTop +=
        matches[0].getBoundingClientRect().top - requireValue(content).getBoundingClientRect().top - 16;
    else requireValue(content).scrollTop = 0;
  });
}
export function syncSettingsNavigation(): void {
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
export function filterSettings(): void {
  const query = appState.ui.settingsSearch.value.trim().toLowerCase();
  cancelAnimationFrame(settingsState.settingsSearchFrame);
  const content = appState.ui.settingsDialog.querySelector<HTMLElement>(".settings-content");
  if (!query) {
    for (const card of appState.ui.settingsDialog.querySelectorAll<HTMLElement>("[data-search-match]"))
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
    appState.element("settings-empty").hidden = false;
  }
  syncSettingsNavigation();
  locateSettingsMatch();
}
export function commandShortcutLabel(value = appState.commandShortcut) {
  return value === "primary-shift-p" ? "Ctrl/Cmd+Shift+P" : "Ctrl/Cmd+K";
}
export function updateCommandShortcut(value: string, persist = false): void {
  appState.commandShortcut = value === "primary-shift-p" ? value : "primary-k";
  appState.ui.commandOpen.title = `Commands (${commandShortcutLabel()})`;
  if (persist) storeLayoutPreference(appState.COMMAND_SHORTCUT_KEY, appState.commandShortcut);
}

export function applySharedPreferences(value: Preferences, initial = false): void {
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
  appState.ui.editor.setLineWrapping(settingsState.webPreferences.sourceLineWrap);
  appState.ui.editor.setThreshold(settingsState.webPreferences.largeDocumentThresholdKib * 1024);
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
    setSidebar(!appState.compactLayout.matches && settingsState.webPreferences.sidebarOpen);
  }
  if (libraryCatalog.loaded) renderFiles();
  scheduleTreeRefresh();
}
export async function refreshSharedPreferences(signal?: AbortSignal): Promise<void> {
  const owner = applicationSignal();
  const scope = authenticationSession.scope;
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
  } catch (errorCause) {
    if (!current()) return;
    const error = errorContext(errorCause);
    if (!handleAuthenticationFailure(error)) appearanceNotice(`Shared settings could not be loaded. ${error.message}`);
  }
}
export function populateSettings(): void {
  appState.element("settings-image-compression").value = settingsState.webPreferences.imageCompression;
  appState.element("settings-image-max-edge").value = String(settingsState.webPreferences.imageMaxEdge);
  appState.element("settings-image-quality").value = String(settingsState.webPreferences.imageQuality);
  appState.element("settings-image-directory").value =
    projectModel.active?.imageDirectory ?? settingsState.webPreferences.imageDirectory;
  appState.element("settings-image-directory").disabled =
    authenticationSession.mode === "users" && !projectModel.active?.owned;
  settingsState.settingsUi.auto_save.value = String(settingsState.webPreferences.autoSaveDelayMs);
  settingsState.settingsUi.default_view.value = settingsState.webPreferences.defaultView;
  settingsState.settingsUi.line_wrap.checked = settingsState.webPreferences.sourceLineWrap;
  settingsState.settingsUi.spellcheck.checked = settingsState.webPreferences.spellcheck;
  settingsState.settingsUi.theme.value = settingsState.sharedAppearance.theme;
  settingsState.settingsUi.latin_font.value = settingsState.sharedAppearance.latinFont;
  settingsState.settingsUi.cjk_font.value = settingsState.sharedAppearance.cjkFont;
  settingsState.settingsUi.font_size.value = String(settingsState.webPreferences.fontSizePx);
  settingsState.settingsUi.font_size_value.value = `${settingsState.webPreferences.fontSizePx} px`;
  settingsState.settingsUi.line_height.value = String(settingsState.webPreferences.lineHeightPercent);
  settingsState.settingsUi.line_height_value.value = `${settingsState.webPreferences.lineHeightPercent}%`;
  settingsState.settingsUi.density.value = settingsState.webPreferences.density;
  setText(appState.element("settings-library-label"), projectModel.active ? "Current project" : "Current folder");
  appState.element("settings-projects-open").hidden = authenticationSession.mode !== "users";
  settingsState.settingsUi.library_root.value =
    projectModel.active?.name ??
    appState.currentRoot?.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/, "") ??
    "Not connected";
  appState.ui.settingsHiddenPatterns.value = settingsState.hiddenPatterns.join("\n");
  settingsState.settingsUi.tree_refresh.value = String(settingsState.webPreferences.treeRefreshSeconds);
  appState.ui.settingsPageWidth.value = document.documentElement.dataset.pageWidth || "balanced";
  appState.ui.settingsSidebarWidth.value = String(appState.preferredSidebarWidth);
  appState.ui.settingsSidebarValue.value = `${appState.preferredSidebarWidth} px`;
  settingsState.settingsUi.default_sidebar.value = settingsState.webPreferences.defaultSidebar;
  settingsState.settingsUi.sidebar_open.checked = settingsState.webPreferences.sidebarOpen;
  settingsState.settingsUi.large_threshold.value = String(settingsState.webPreferences.largeDocumentThresholdKib);
  settingsState.settingsUi.preview_delay.value = String(settingsState.webPreferences.previewDelayMs);
  settingsState.settingsUi.outline_delay.value = String(settingsState.webPreferences.outlineDelayMs);
  settingsState.settingsUi.reduced_motion.checked = settingsState.webPreferences.reducedMotion;
  settingsState.settingsUi.high_contrast.checked = settingsState.webPreferences.highContrast;
  settingsState.settingsUi.strong_focus.checked = settingsState.webPreferences.strongFocus;
  appState.ui.settingsCommandShortcut.value = appState.commandShortcut;
}
export function collectSettings() {
  const patterns = parseHiddenPatterns(appState.ui.settingsHiddenPatterns.value);
  return validatedPreferences({
    appearance: {
      theme: settingsState.settingsUi.theme.value,
      latinFont: settingsState.settingsUi.latin_font.value.trim(),
      cjkFont: settingsState.settingsUi.cjk_font.value.trim(),
    },
    web: {
      imageCompression: appState.element("settings-image-compression").value,
      imageMaxEdge: Number(appState.element("settings-image-max-edge").value),
      imageQuality: Number(appState.element("settings-image-quality").value),
      imageDirectory: projectModel.active
        ? settingsState.webPreferences.imageDirectory
        : appState.element("settings-image-directory").value.trim(),
      autoSaveDelayMs: Number(settingsState.settingsUi.auto_save.value),
      defaultView: settingsState.settingsUi.default_view.value,
      sourceLineWrap: settingsState.settingsUi.line_wrap.checked,
      spellcheck: settingsState.settingsUi.spellcheck.checked,
      fontSizePx: Number(settingsState.settingsUi.font_size.value),
      lineHeightPercent: Number(settingsState.settingsUi.line_height.value),
      density: settingsState.settingsUi.density.value,
      defaultSidebar: settingsState.settingsUi.default_sidebar.value,
      sidebarOpen: settingsState.settingsUi.sidebar_open.checked,
      hiddenPatterns: patterns,
      treeRefreshSeconds: Number(settingsState.settingsUi.tree_refresh.value),
      largeDocumentThresholdKib: Number(settingsState.settingsUi.large_threshold.value),
      previewDelayMs: Number(settingsState.settingsUi.preview_delay.value),
      outlineDelayMs: Number(settingsState.settingsUi.outline_delay.value),
      reducedMotion: settingsState.settingsUi.reduced_motion.checked,
      highContrast: settingsState.settingsUi.high_contrast.checked,
      strongFocus: settingsState.settingsUi.strong_focus.checked,
    },
  });
}
export function openSettings(tab = settingsState.selectedSettingsTab): void {
  if (publicState.publicView) return;
  if (appState.ui.settingsDialog.open || !appState.ui.authScreen.hidden) return;
  closeMenus();
  closeCommandPanel();
  populateSettings();
  appState.ui.settingsSearch.value = "";
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
  notice(appState.ui.settingsError, "");
  filterSettings();
  showDialog(appState.ui.settingsDialog);
  selectSettingsTab(tab);
  appState.ui.settingsSearch.focus();
}
export function cancelSettings(): void {
  if (settingsState.settingsSnapshot) {
    applySharedPreferences(settingsState.settingsSnapshot.preferences);
    setPageWidth(settingsState.settingsSnapshot.pageWidth);
    setSidebarWidth(settingsState.settingsSnapshot.sidebarWidth);
    updateCommandShortcut(settingsState.settingsSnapshot.commandShortcut);
  }
  settingsState.settingsSnapshot = null;
  if (appState.ui.settingsDialog.open) appState.ui.settingsDialog.close();
}

export function previewAppearanceSettings(): void {
  const fontSize = Number(settingsState.settingsUi.font_size.value);
  const lineHeight = Number(settingsState.settingsUi.line_height.value);
  settingsState.settingsUi.font_size_value.value = `${fontSize} px`;
  settingsState.settingsUi.line_height_value.value = `${lineHeight}%`;
  document.documentElement.style.setProperty("--document-size", `${fontSize}px`);
  document.documentElement.style.setProperty("--document-line-height", String(lineHeight / 100));
  document.documentElement.dataset.density = settingsState.settingsUi.density.value;
  void applyAppearance({
    theme: settingsState.settingsUi.theme.value,
    latinFont: settingsState.settingsUi.latin_font.value.trim() || settingsState.sharedAppearance.latinFont,
    cjkFont: settingsState.settingsUi.cjk_font.value.trim() || settingsState.sharedAppearance.cjkFont,
  });
}
function createSettingsUi() {
  return {
    auto_save: appState.element("settings-auto-save"),
    default_view: appState.element("settings-default-view"),
    line_wrap: appState.element("settings-line-wrap"),
    spellcheck: appState.element("settings-spellcheck"),
    theme: appState.element("settings-theme"),
    latin_font: appState.element("settings-latin-font"),
    cjk_font: appState.element("settings-cjk-font"),
    font_size: appState.element("settings-font-size"),
    font_size_value: appState.element("settings-font-size-value"),
    line_height: appState.element("settings-line-height"),
    line_height_value: appState.element("settings-line-height-value"),
    density: appState.element("settings-density"),
    library_root: appState.element("settings-library-root"),
    tree_refresh: appState.element("settings-tree-refresh"),
    default_sidebar: appState.element("settings-default-sidebar"),
    sidebar_open: appState.element("settings-sidebar-open"),
    large_threshold: appState.element("settings-large-threshold"),
    preview_delay: appState.element("settings-preview-delay"),
    outline_delay: appState.element("settings-outline-delay"),
    reduced_motion: appState.element("settings-reduced-motion"),
    high_contrast: appState.element("settings-high-contrast"),
    strong_focus: appState.element("settings-strong-focus"),
    save: appState.element("settings-save"),
  };
}
