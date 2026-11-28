import { fileLabel } from "@folio/model";
import { projectModel } from "../../state/projects";
import { authenticationSession } from "../../state/authentication";
import { documentSession } from "../../state/document";
import { activePanelPath, libraryCatalog } from "../../state/library";
import { shell } from "../../state/shell";
import { batch, createSignal } from "solid-js";
import type { Command } from "../../types/domain";
import { element, requireValue } from "../../types/elements";
import { closeMenus, setSidebar, toggleFocusMode } from "../accounts/authentication";
import { collaborationLocked } from "../collaboration/collaboration";
import { showDialog } from "../dialogs/dialogs";
import { openHistory } from "../documents/history";
import { navigateTo } from "../documents/navigation";
import { saveDocument } from "../documents/saving";
import { startTreeRename, setView } from "../navigation/files";
import { createTreeEntry } from "../navigation/creation";
import { refreshFiles } from "../navigation/library";
import { openSettings } from "../preferences/settings";

import { projectCanCreate, projectWritable } from "../projects/permissions";
import { openWorkspaceSearch } from "../search/search";
import { publicState } from "../sharing/public";
import { openWorkspace } from "../workspace/workspace";
import { appState, dirty } from "./bootstrap";
import { documentNotice } from "./dom";
import { setPageWidth } from "./layout";
const [commandIndex, setCommandIndex] = createSignal(0);
const [visibleCommands, setVisibleCommands] = createSignal<readonly Command[]>([], {
  equals: (previous, next) =>
    previous.length === next.length && previous.every((command, index) => command === next[index]),
});
export { commandIndex, visibleCommands };
let commandItems: Command[];
export function initializeCoreCommands(): void {
  const noteVisible = () => Boolean(!activePanelPath() && documentSession.current);
  setCommandIndex(0);
  setVisibleCommands([]);
  const primaryKey = navigator.platform.toLowerCase().includes("mac") ? "Cmd" : "Ctrl";
  commandItems = [
    {
      name: "New note",
      action: () => createTreeEntry("file"),
      enabled: () => !element("new-note").disabled,
    },
    {
      name: "Save note",
      key: `${primaryKey}+S`,
      action: () => void saveDocument(),
      enabled: () => noteVisible() && dirty() && !documentSession.saving && !appState.creating,
    },
    { name: "View: Live", action: () => setView("rich", true), enabled: noteVisible },
    { name: "View: Source", action: () => setView("editor", true), enabled: noteVisible },
    { name: "View: Compare", action: () => setView("split", true), enabled: noteVisible },
    { name: "View: Read", action: () => setView("preview", true), enabled: noteVisible },
    { name: "Page width: Focused", action: () => setPageWidth("focused", true) },
    { name: "Page width: Balanced", action: () => setPageWidth("balanced", true) },
    { name: "Page width: Wide", action: () => setPageWidth("wide", true) },
    {
      name: "Toggle sidebar",
      key: `${primaryKey}+Shift+L`,
      action: () => setSidebar(document.body.dataset.sidebar !== "open", true),
    },
    { name: "Distraction free", action: toggleFocusMode },
    { name: "Open settings", action: () => openSettings() },
    {
      name: "Refresh files",
      action: () => void refreshFiles(),
      enabled: () => appState.connectionState === "ready" && !libraryCatalog.loading,
    },
    {
      name: "Search notes",
      key: `${primaryKey}+P`,
      action: () => void openWorkspaceSearch(),
      enabled: () => authenticationSession.mode === "users" && !publicState.publicView,
    },
    {
      name: "Favorites and recent notes",
      action: () => void openWorkspace(),
      enabled: () => authenticationSession.mode === "users" && !publicState.publicView,
    },
    {
      name: "Rename current file",
      action: () => {
        appState.contextFile = { path: requireValue(documentSession.current).path, kind: "file" };
        startTreeRename();
      },
      enabled: () =>
        Boolean(noteVisible() && documentSession.resourceId && projectCanCreate() && !publicState.publicView),
    },
    {
      name: "Version history",
      action: () => void openHistory(),
      enabled: () =>
        Boolean(noteVisible() && documentSession.resourceId && projectModel.active?.owned && !publicState.publicView),
    },
    {
      name: "Edit current link",
      action: () => {
        if (!appState.inlineEditor.editLink()) documentNotice("No link at cursor", "warning");
      },
      enabled: () => Boolean(noteVisible() && shell.view === "rich" && projectWritable() && !collaborationLocked()),
    },
    ...["Table", "Task list", "Image", "Formula"].map((name) => ({
      name: `Insert ${name.toLowerCase()}`,
      action: () => {
        if (!appState.inlineEditor.insertBlock(name)) documentNotice("No editable paragraph at cursor", "warning");
      },
      enabled: () => Boolean(noteVisible() && shell.view === "rich" && projectWritable() && !collaborationLocked()),
    })),
  ];
}
export function selectCommand(index: number): void {
  const length = visibleCommands().length;
  if (!length) return;
  const next = (index + length) % length;
  if (next === commandIndex()) return;
  setCommandIndex(next);
  element("command-list").children[next]?.scrollIntoView({ block: "nearest" });
}
export function filterCommands(): void {
  element("command-list").scrollTop = 0;
  const query = element("command-query").value.trim().toLowerCase();
  const commands = commandItems.filter(
    (command) =>
      command.enabled?.() !== false &&
      (!publicState.publicView ||
        !["New note", "Open settings", "Refresh files", "Toggle sidebar", "Distraction free"].includes(command.name)) &&
      (!query || command.name.toLowerCase().includes(query)),
  );
  // One search reaches notes as well as actions: matching notes follow the commands.
  if (query)
    commands.push(
      ...libraryCatalog.files
        .filter((file) => fileLabel(file).toLowerCase().includes(query) || file.path.toLowerCase().includes(query))
        .slice(0, 12)
        .map((file) => ({
          name: fileLabel(file),
          key: file.path,
          action: () => void navigateTo(file.id ?? file.path),
        })),
    );
  batch(() => {
    setVisibleCommands(commands);
    setCommandIndex(0);
  });
}
export function openCommandPanel(): void {
  if (element("command-dialog").open || !element("auth-screen").hidden) return;
  closeMenus();
  element("command-query").value = "";
  filterCommands();
  showDialog(element("command-dialog"));
  element("command-query").focus();
}
export function runCommand(index = commandIndex()): void {
  const command = visibleCommands()[index];
  if (!command) return;
  element("command-dialog").close();
  command.action();
}
export function opensCommandPanel(event: KeyboardEvent) {
  if (!(event.ctrlKey || event.metaKey)) return false;
  return appState.commandShortcut === "primary-shift-p"
    ? event.shiftKey && event.key.toLowerCase() === "p"
    : !event.shiftKey && event.key.toLowerCase() === "k";
}
