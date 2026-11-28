import { decodedObject, decodedString } from "../../api/contracts";
import { authenticationSession } from "../../state/authentication";
import { activePanelPath } from "../../state/library";
import { projectModel } from "../../state/projects";
import { documentSession } from "../../state/document";
import { element, requiredQuery } from "../../types/elements";
import { errorContext } from "../../types/errors";
import { copyPlainText } from "../../../shared/clipboard";
import { api } from "../core/api";
import { appState } from "../core/bootstrap";
import { documentNotice } from "../core/dom";
import { navigateTo } from "../documents/navigation";
import { currentResourceId, entryResourceId } from "../documents/resources";
import { listen } from "../lifecycle";
import { refreshFiles } from "./library";
import { nameTaken } from "./creation";
import { closeFileContextMenu, openFileContextMenu, showFileDetails, startTreeRename } from "./files";
import { initializeFileProperties } from "./file-properties";
import { leaveFilePanel, openFilePanel, pdfFileUrl } from "./panels";
import { relocateEntryIcons } from "./icons";
import { openSharing } from "../projects/projects";
import { publicShareUrl, publicState } from "../sharing/public";
import { changeWorkspace } from "../workspace/workspace";
import { workspaceModel } from "../../state/workspace";

export async function duplicatePanelFile(path: string) {
  const scope = projectModel.selection;
  const extension = path.slice(path.lastIndexOf(".")),
    stem = path.slice(0, -extension.length);
  let destination = `${stem} copy${extension}`;
  for (let n = 2; nameTaken(destination); n++) destination = `${stem} copy ${n}${extension}`;
  try {
    const result = decodedObject(
      await api("/api/panel-file", {
        method: "POST",
        signal: authenticationSession.scope.signal,
        body: { path, destination },
      }),
      "duplicate",
    );
    if (scope !== projectModel.selection) return;
    relocateEntryIcons(path, decodedString(result.path, "duplicate path"), true);
    await refreshFiles();
    if (scope !== projectModel.selection) return;
    await startTreeRename({ path: decodedString(result.path, "duplicate path"), kind: "file" });
  } catch (cause) {
    if (scope === projectModel.selection) documentNotice(`Duplicate failed: ${errorContext(cause).message}`, "error");
  }
}

async function downloadFile(path: string) {
  if (/\.pdf$/i.test(path)) {
    const link = document.createElement("a");
    link.href = pdfFileUrl(path, true);
    link.download = path.slice(path.lastIndexOf("/") + 1);
    link.click();
    return;
  }
  let blob: Blob;
  const scope = projectModel.selection;
  if (/\.(md|markdown)$/i.test(path)) {
    await navigateTo(currentResourceId(path));
    if (scope !== projectModel.selection || documentSession.current?.path !== path) return;
    blob = new Blob([appState.editor.value], { type: "text/markdown" });
  } else {
    const data = await api(`/api/panel-file?${new URLSearchParams({ path, download: "true" })}`, {
      responseType: "blob",
    });
    if (!(data instanceof Blob)) throw new Error("Unreadable file.");
    blob = data;
  }
  if (scope !== projectModel.selection) return;
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = path.slice(path.lastIndexOf("/") + 1);
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function initializeFileActions() {
  initializeFileProperties();
  const more = requiredQuery(document, "#panel-more", HTMLButtonElement);
  listen(more, "click", (event) => {
    if (more.getAttribute("aria-expanded") === "true") return closeFileContextMenu();
    const path = activePanelPath();
    if (path) openFileContextMenu(event, path, "file", undefined, more);
  });
  listen(element("file-context-menu"), "click", async (event) => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest<HTMLElement>("[data-file-action],[data-note-action]");
    const entry = appState.contextFile;
    if (!entry || !button) return;
    const scope = projectModel.selection,
      path = entry.path;
    closeFileContextMenu(false);
    try {
      if (button.dataset.noteAction) {
        await navigateTo(currentResourceId(path));
        if (scope !== projectModel.selection || documentSession.current?.path !== path || activePanelPath()) return;
        const action = requiredQuery(document, `#${CSS.escape(button.dataset.noteAction)}`, HTMLButtonElement);
        if (!action.hidden && !action.disabled) action.click();
      } else if (button.dataset.fileAction === "copy-path") await copyPlainText(path);
      else if (button.dataset.fileAction === "share") {
        const project = projectModel.active,
          id = await entryResourceId(path);
        if (project && scope === projectModel.selection) await openSharing(project, path, id);
      } else if (button.dataset.fileAction === "copy-link") {
        if (publicState.publicView) await copyPlainText(publicShareUrl(publicState.publicToken));
        else {
          const project = projectModel.active,
            id = await entryResourceId(path);
          if (!project || scope !== projectModel.selection) return;
          const link = project.publicLinks?.[path];
          const url = new URL("/", location.href);
          url.searchParams.set("project", project.id);
          url.searchParams.set(/\.(md|markdown)$/i.test(path) ? "document" : "asset", id);
          await copyPlainText(link ? publicShareUrl(link.token) : url.href);
        }
      } else if (button.dataset.fileAction === "favorite") {
        const project = projectModel.active,
          id = await entryResourceId(path);
        if (project && scope === projectModel.selection)
          await changeWorkspace({
            action: "favorite",
            project: project.id,
            id,
            value: !workspaceModel.lists.favorites.some((file) => file.project === project.id && file.id === id),
          });
      } else if (button.dataset.fileAction === "tags") {
        appState.contextFile = entry;
        await showFileDetails();
        requiredQuery(document, "#file-property-tags", HTMLInputElement).focus();
      } else if (button.dataset.fileAction === "download") await downloadFile(path);
      else if (button.dataset.fileAction === "reload") {
        if (/\.(md|markdown)$/i.test(path)) await navigateTo(currentResourceId(path), "", { reload: true });
        else {
          if (activePanelPath() === path && !(await leaveFilePanel())) return;
          if (scope === projectModel.selection) await openFilePanel(path);
        }
      }
    } catch (cause) {
      if (scope === projectModel.selection) documentNotice(errorContext(cause).message, "error");
    }
  });
}
