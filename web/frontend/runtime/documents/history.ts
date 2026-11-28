import { projectModel } from "../../state/projects";
import { documentSession } from "../../state/document";
import { decodedDocument, decodedHistory, decodedRevisionContent, decodedTrash } from "../../api/contracts";
import { diffLines, createButton } from "@folio/editor-runtime";
import { formatByteCount } from "@folio/model";
import type { HistoryRevision, HistoryView, TrashEntry } from "../../types/domain";
import { element, htmlChildren, requireValue } from "../../types/elements";
import { errorContext } from "../../types/errors";
import { closeMenus } from "../accounts/authentication";
import { api } from "../core/api";
import { appState, dirty } from "../core/bootstrap";
import { createListRow, documentNotice, notice } from "../core/dom";
import { confirmAction, showDialog } from "../dialogs/dialogs";
import { listen } from "../lifecycle";
import { refreshFiles } from "../navigation/library";
import { projectOwns } from "../projects/permissions";
import { closeFileContextMenu } from "../navigation/files";
import { entryResourceId } from "./resources";
import { activePanelPath } from "../../state/library";
import { leaveFilePanel } from "../navigation/panels";
import { collaboration } from "../collaboration/collaboration";

import { clearDocument, useDocument } from "./navigation";
let historyView: HistoryView | null;
let historyGeneration: number;
let historyBusy: boolean;
let historyDialog: HTMLDialogElement;
let trashDialog: HTMLDialogElement;

export function initializeDocumentsHistory(): void {
  historyView = null;
  historyGeneration = 0;
  historyBusy = false;
  historyDialog = element("history-dialog");
  trashDialog = element("trash-dialog");
  listen(element("history-open"), "click", () => void openHistory());
  listen(element("history-close"), "click", () => {
    if (!historyBusy) historyDialog.close();
  });
  listen(historyDialog, "cancel", (event) => {
    if (historyBusy) event.preventDefault();
  });
  listen(historyDialog, "close", () => {
    historyGeneration += 1;
    historyView = null;
  });
  listen(element("history-copy"), "click", async () => {
    try {
      await copyPlainText(requireValue(requireValue(historyView).selected).content);
      documentNotice("");
    } catch (errorCause) {
      const error = errorContext(errorCause);
      notice(element("history-message"), `Copy failed: ${error.message}`, "error");
    }
  });
  listen(element("history-restore"), "click", async () => {
    const view = historyView;
    if (!view?.selected || historyBusy) return;
    if (!(await confirmAction("Restore this version? Editors must reopen the note", { label: "Restore version" })))
      return;
    historyBusy = true;
    element("history-restore").disabled = true;
    notice(element("history-message"), "Restoring version…");
    try {
      if (view.project !== projectModel.active?.id || view.document !== documentSession.id)
        throw new Error("Document changed");
      const document = await api("/api/history/restore", {
        decode: decodedDocument,
        method: "POST",
        body: {
          document: view.id,
          revision: view.selected.revision.id,
          version: view.version,
        },
      });
      historyDialog.close();
      useDocument(document, appState.currentRoot, new URL(appState.committedUrl), "replace");
      void refreshFiles();
    } catch (errorCause) {
      const error = errorContext(errorCause);
      notice(element("history-message"), error.message, "error");
    } finally {
      historyBusy = false;
      element("history-restore").disabled = false;
    }
  });
  listen(element("trash-open"), "click", () => void openTrash());
  listen(element("trash-close"), "click", () => trashDialog.close());
  listen(element("document-trash"), "click", () => {
    closeMenus();
    if (documentSession.current) void recycleEntry(documentSession.current.path, "file");
  });
  listen(element("file-recycle"), "click", () => {
    const entry = appState.contextFile;
    closeFileContextMenu();
    if (entry) void recycleEntry(entry.path, entry.kind);
  });
}
async function recycleEntry(path: string, kind: "file" | "directory"): Promise<void> {
  if (!projectOwns() || appState.connectionState !== "ready") return;
  const project = projectModel.active?.id;
  const root = appState.currentRoot;
  const sameScope = () => root === appState.currentRoot && project === projectModel.active?.id && projectOwns();
  const affectsOpen = () =>
    documentSession.current?.path === path ||
    (kind === "directory" && documentSession.current?.path.startsWith(`${path}/`));
  const unsafe = () => affectsOpen() && (dirty() || documentSession.saving || collaboration?.pending.size);
  if (unsafe()) {
    documentNotice("Save the open note first", "warning");
    return;
  }
  try {
    const id = await entryResourceId(path, kind);
    const version = kind === "file" && affectsOpen() ? documentSession.current?.version : undefined;
    if (!(await confirmAction(`Recycle “${path}”? Public links are revoked`, { label: "Recycle" })) || !sameScope())
      return;
    if (unsafe()) {
      documentNotice("Save the open note first", "warning");
      return;
    }
    const panel = activePanelPath();
    if (
      panel &&
      (panel === path || (kind === "directory" && panel.startsWith(`${path}/`))) &&
      !(await leaveFilePanel())
    )
      return;
    if (!sameScope()) return;
    await api("/api/entry", { method: "DELETE", body: { id, version } });
    if (!sameScope()) return;
    if (unsafe()) {
      documentNotice("Moved to recycle bin. Copy your unsaved changes", "warning");
      await refreshFiles();
      return;
    }
    if (affectsOpen()) {
      const url = new URL(appState.committedUrl);
      url.searchParams.delete("document");
      url.hash = "";
      clearDocument(url, "replace");
    }
    documentNotice("");
    await refreshFiles();
  } catch (cause) {
    if (sameScope()) documentNotice(`Delete failed: ${errorContext(cause).message}`, "error");
  }
}
export async function openHistory(): Promise<void> {
  if (!documentSession.current || !projectModel.active?.owned) return;
  closeMenus();
  const generation = ++historyGeneration;
  historyView = {
    id: documentSession.current.id,
    path: documentSession.current.path,
    project: projectModel.active.id,
    document: documentSession.id,
    selected: null,
  };
  element("history-list").replaceChildren();
  element("history-diff").textContent = "";
  element("history-restore").disabled = true;
  element("history-copy").disabled = true;
  showDialog(historyDialog);
  notice(element("history-message"), "Loading history…");
  try {
    const result = await api(`/api/history?document=${encodeURIComponent(historyView.id)}`, {
      decode: decodedHistory,
    });
    if (generation !== historyGeneration || !historyDialog.open) return;
    historyView.version = result.currentVersion;
    historyView.current = documentSession.current.content;
    element("history-list").replaceChildren(
      ...result.revisions.map((revision: HistoryRevision) => {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.id = String(revision.id);
        const label = document.createElement("span");
        label.textContent = new Date(revision.created).toLocaleString();
        const details = document.createElement("small");
        details.textContent = `${revision.actor || "Editor"} · ${revision.kind} · ${formatByteCount(revision.size)}`;
        button.append(label, details);
        button.addEventListener("click", () => void selectHistoryVersion(revision.id));
        return button;
      }),
    );
    notice(element("history-message"), result.revisions.length ? "" : "No earlier versions");
    if (result.revisions.length) await selectHistoryVersion(result.revisions[0].id);
  } catch (errorCause) {
    const error = errorContext(errorCause);
    notice(element("history-message"), error.message, "error");
  }
}
async function selectHistoryVersion(id: number): Promise<void> {
  const view = historyView;
  const generation = ++historyGeneration;
  notice(element("history-message"), "Loading version…");
  try {
    const result = await api(
      `/api/history/content?document=${encodeURIComponent(requireValue(view).id)}&revision=${id}`,
      {
        decode: decodedRevisionContent,
      },
    );
    if (generation !== historyGeneration || historyView !== view || !historyDialog.open) return;
    requireValue(view).selected = result;
    for (const button of htmlChildren(element("history-list")))
      button.setAttribute("aria-pressed", String(Number(button.dataset.id) === id));
    element("history-detail").textContent = "Red removed, green current";
    const changes = diffLines(result.content, requireValue(requireValue(view).current), { timeout: 200 });
    const diff = element("history-diff");
    diff.replaceChildren();
    let remaining = 200000;
    for (const change of changes ?? [{ value: String(result.content), added: false, removed: false }]) {
      const line = document.createElement("span");
      line.className = change.added ? "is-added" : change.removed ? "is-removed" : "";
      line.textContent = change.value.slice(0, remaining);
      diff.append(line);
      remaining -= line.textContent.length;
      if (remaining <= 0) break;
    }
    notice(
      element("history-message"),
      !changes ? "Diff too large, showing version" : remaining <= 0 ? "Preview truncated" : "",
      "warning",
    );
    element("history-copy").disabled = false;
    element("history-restore").disabled =
      !requireValue(view).version || requireValue(view).version === result.revision.version;
  } catch (errorCause) {
    const error = errorContext(errorCause);
    notice(element("history-message"), error.message, "error");
  }
}
async function openTrash(): Promise<void> {
  closeMenus();
  showDialog(trashDialog);
  notice(element("trash-message"), "Loading recycle bin…");
  try {
    const entries = await api("/api/trash", {
      decode: decodedTrash,
    });
    element("trash-list").replaceChildren(
      ...entries.map((entry: TrashEntry) => {
        const row = createListRow(
          entry.path,
          `${new Date(entry.deleted).toLocaleString()} · ${formatByteCount(entry.size)}`,
        );
        const restore = createButton({ label: "Restore" });

        restore.setAttribute("aria-label", `Restore ${entry.path}`);
        restore.addEventListener("click", async () => {
          restore.disabled = true;
          const project = projectModel.active?.id;
          try {
            await api("/api/trash/restore", { method: "POST", body: { id: entry.id } });
            if (projectModel.active?.id === project) {
              if (trashDialog.open) await openTrash();
              void refreshFiles();
            }
          } catch (errorCause) {
            const error = errorContext(errorCause);
            notice(element("trash-message"), error.message, "error");
            restore.disabled = false;
          }
        });
        row.append(restore);
        return row;
      }),
    );
    notice(element("trash-message"), entries.length ? "" : "Recycle bin empty");
  } catch (errorCause) {
    const error = errorContext(errorCause);
    notice(element("trash-message"), error.message, "error");
  }
}
import { copyPlainText } from "../../../shared/clipboard";
