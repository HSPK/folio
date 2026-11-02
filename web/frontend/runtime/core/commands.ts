import { projectModel } from "../../state/projects";
import { authenticationSession } from "../../state/authentication";
import { documentSession } from "../../state/document";
import { libraryCatalog } from "../../state/library";
import { shell } from "../../state/shell";
import type { Command } from "../../types/domain";
import { htmlChildren, requireValue } from "../../types/elements";
import { closeMenus, setSidebar, toggleFocusMode } from "../accounts/authentication";
import { collaborationLocked } from "../collaboration/collaboration";
import { showDialog } from "../dialogs/dialogs";
import { openHistory } from "../documents/history";
import { saveDocument } from "../documents/saving";
import { openNewNote, openRenameDialog, setView } from "../navigation/files";
import { refreshFiles } from "../navigation/library";
import { openSettings } from "../preferences/settings";

import { projectCanCreate, projectWritable } from "../projects/permissions";
import { openWorkspaceSearch } from "../search/search";
import { publicState } from "../sharing/public";
import { openWorkspace } from "../workspace/workspace";
import { appState, dirty } from "./bootstrap";
import { documentNotice } from "./dom";
import { setPageWidth } from "./layout";
class CommandState {
  commandIndex!: number;
  visibleCommands!: Command[];
  primaryKey!: string;
  commandItems!: Command[];
}
export const commandState = new CommandState();
export function initializeCoreCommands(): void {
  commandState.commandIndex = 0;
  commandState.visibleCommands = [];
  commandState.primaryKey = navigator.platform.toLowerCase().includes("mac") ? "Cmd" : "Ctrl";
  commandState.commandItems = [
    {
      name: "New note",
      action: openNewNote,
      enabled: () => appState.connectionState === "ready" && !appState.creating && !appState.movingEntry,
    },
    {
      name: "Save note",
      key: `${commandState.primaryKey}+S`,
      action: () => void saveDocument(),
      enabled: () => Boolean(documentSession.current && dirty() && !documentSession.saving && !appState.creating),
    },
    { name: "View: Live", action: () => setView("rich", true), enabled: () => Boolean(documentSession.current) },
    { name: "View: Source", action: () => setView("editor", true), enabled: () => Boolean(documentSession.current) },
    { name: "View: Compare", action: () => setView("split", true), enabled: () => Boolean(documentSession.current) },
    { name: "View: Read", action: () => setView("preview", true), enabled: () => Boolean(documentSession.current) },
    { name: "Page width: Focused", action: () => setPageWidth("focused", true) },
    { name: "Page width: Balanced", action: () => setPageWidth("balanced", true) },
    { name: "Page width: Wide", action: () => setPageWidth("wide", true) },
    {
      name: "Toggle sidebar",
      key: `${commandState.primaryKey}+Shift+L`,
      action: () => setSidebar(document.body.dataset.sidebar !== "open"),
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
      key: `${commandState.primaryKey}+P`,
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
        openRenameDialog();
      },
      enabled: () => Boolean(documentSession.current && projectCanCreate() && !publicState.publicView),
    },
    {
      name: "Version history",
      action: () => void openHistory(),
      enabled: () => Boolean(documentSession.current && projectModel.active?.owned && !publicState.publicView),
    },
    {
      name: "Edit current link",
      action: () => {
        if (!appState.inlineEditor.editLink()) documentNotice("Place the cursor in a link to edit it.", "warning");
      },
      enabled: () => Boolean(documentSession.current && shell.view === "rich"),
    },
    ...["Table", "Task list", "Image", "Formula"].map((name) => ({
      name: `Insert ${name.toLowerCase()}`,
      action: () => {
        if (!appState.inlineEditor.insertBlock(name))
          documentNotice("Place the cursor in an editable Live paragraph first.", "warning");
      },
      enabled: () =>
        Boolean(documentSession.current && shell.view === "rich" && projectWritable() && !collaborationLocked()),
    })),
  ];
}
export function selectCommand(index: number): void {
  if (!commandState.visibleCommands.length) return;
  commandState.commandIndex = (index + commandState.visibleCommands.length) % commandState.visibleCommands.length;
  for (const [buttonIndex, button] of htmlChildren(appState.ui.commandList).entries()) {
    button.setAttribute("aria-selected", String(buttonIndex === commandState.commandIndex));
  }
  appState.ui.commandList.children[commandState.commandIndex]?.scrollIntoView({ block: "nearest" });
}
export function renderCommandPanel(): void {
  const query = appState.ui.commandQuery.value.trim().toLowerCase();
  commandState.visibleCommands = commandState.commandItems.filter(
    (command) =>
      command.enabled?.() !== false &&
      (!publicState.publicView ||
        !["New note", "Open settings", "Refresh files", "Toggle sidebar"].includes(command.name)) &&
      (!query || command.name.toLowerCase().includes(query)),
  );
  commandState.commandIndex = Math.min(commandState.commandIndex, Math.max(0, commandState.visibleCommands.length - 1));
  appState.ui.commandList.replaceChildren(
    ...commandState.visibleCommands.map((command, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", String(index === commandState.commandIndex));
      const name = document.createElement("span");
      name.className = "command-name";
      name.textContent = command.name;
      button.append(name);
      if (command.key) {
        const key = document.createElement("span");
        key.className = "command-key";
        key.textContent = command.key;
        button.append(key);
      }
      button.addEventListener("pointermove", () => selectCommand(index));
      button.addEventListener("click", () => runCommand(index));
      return button;
    }),
  );
  appState.ui.commandEmpty.hidden = commandState.visibleCommands.length > 0;
}
export function openCommandPanel(): void {
  if (appState.ui.commandDialog.open || !appState.ui.authScreen.hidden) return;
  closeMenus();
  appState.ui.commandQuery.value = "";
  commandState.commandIndex = 0;
  renderCommandPanel();
  showDialog(appState.ui.commandDialog);
  appState.ui.commandQuery.focus();
}
export function closeCommandPanel(): void {
  if (appState.ui.commandDialog.open) appState.ui.commandDialog.close();
}
export function runCommand(index = commandState.commandIndex): void {
  const command = commandState.visibleCommands[index];
  if (!command) return;
  closeCommandPanel();
  command.action();
}
export function opensCommandPanel(event: KeyboardEvent) {
  if (!(event.ctrlKey || event.metaKey)) return false;
  return appState.commandShortcut === "primary-shift-p"
    ? event.shiftKey && event.key.toLowerCase() === "p"
    : !event.shiftKey && event.key.toLowerCase() === "k";
}
