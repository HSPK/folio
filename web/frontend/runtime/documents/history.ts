import { projectModel } from "../../state/projects";
import { documentSession } from "../../state/document";
import { decodedDocument, decodedHistory, decodedRevisionContent, decodedTrash } from "../../api/contracts";
import { diffLines } from "@folio/editor-runtime";
import { formatByteCount } from "@folio/model";
import type { HistoryRevision, HistoryView, TrashEntry } from "../../types/domain";
import { htmlChildren, requireValue } from "../../types/elements";
import { errorContext } from "../../types/errors";
import { closeMenus } from "../accounts/authentication";
import { api } from "../core/api";
import { appState } from "../core/bootstrap";
import { documentNotice, notice } from "../core/dom";
import { confirmAction, showDialog } from "../dialogs/dialogs";
import { listen } from "../lifecycle";
import { refreshFiles } from "../navigation/library";

import { clearDocument, useDocument } from "./navigation";
class HistoryState {
  historyView!: HistoryView | null;
  historyGeneration!: number;
  historyBusy!: boolean;
  historyDialog!: HTMLDialogElement;
  trashDialog!: HTMLDialogElement;
}
export const historyState = new HistoryState();
export function initializeDocumentsHistory(): void {
  historyState.historyView = null;
  historyState.historyGeneration = 0;
  historyState.historyBusy = false;
  historyState.historyDialog = appState.element("history-dialog");
  historyState.trashDialog = appState.element("trash-dialog");
  listen(appState.element("history-open"), "click", () => void openHistory());
  listen(appState.element("history-close"), "click", () => {
    if (!historyState.historyBusy) historyState.historyDialog.close();
  });
  listen(historyState.historyDialog, "cancel", (event) => {
    if (historyState.historyBusy) event.preventDefault();
  });
  listen(historyState.historyDialog, "close", () => {
    historyState.historyGeneration += 1;
    historyState.historyView = null;
  });
  listen(appState.element("history-copy"), "click", async () => {
    try {
      await navigator.clipboard.writeText(requireValue(requireValue(historyState.historyView).selected).content);
      documentNotice("");
    } catch (errorCause) {
      const error = errorContext(errorCause);
      notice(appState.element("history-message"), `Could not copy this version: ${error.message}`, "error");
    }
  });
  listen(appState.element("history-restore"), "click", async () => {
    const view = historyState.historyView;
    if (!view?.selected || historyState.historyBusy) return;
    if (
      !(await confirmAction(
        "Restore this version? Connected editors must reopen the document. Existing sharing permissions stay in effect.",
        { label: "Restore version" },
      ))
    )
      return;
    historyState.historyBusy = true;
    appState.element("history-restore").disabled = true;
    notice(appState.element("history-message"), "Restoring version…");
    try {
      if (view.project !== projectModel.active?.id || view.document !== documentSession.id)
        throw new Error("The open document changed.");
      const document = await api("/api/history/restore", {
        decode: decodedDocument,
        method: "POST",
        body: {
          document: view.id,
          revision: view.selected.revision.id,
          version: view.version,
        },
      });
      historyState.historyDialog.close();
      useDocument(document, appState.currentRoot, new URL(appState.committedUrl), "replace");
      void refreshFiles();
    } catch (errorCause) {
      const error = errorContext(errorCause);
      notice(appState.element("history-message"), error.message, "error");
    } finally {
      historyState.historyBusy = false;
      appState.element("history-restore").disabled = false;
    }
  });
  listen(appState.element("trash-open"), "click", () => void openTrash());
  listen(appState.element("trash-close"), "click", () => historyState.trashDialog.close());
  listen(appState.element("document-trash"), "click", async () => {
    closeMenus();
    if (!documentSession.current || !projectModel.active?.owned) return;
    if (
      !(await confirmAction(
        `Move “${documentSession.current.path}” to the recycle bin for 30 days? Its public links will be revoked.`,
        { label: "Recycle note" },
      ))
    )
      return;
    const id = documentSession.id;
    try {
      await api("/api/document", {
        method: "DELETE",
        body: { id: documentSession.current.id, version: documentSession.current.version },
      });
      if (id === documentSession.id) {
        const url = new URL(appState.committedUrl);
        url.searchParams.delete("document");
        url.hash = "";
        clearDocument(url, "replace");
      }
      documentNotice("");
      await refreshFiles();
    } catch (errorCause) {
      const error = errorContext(errorCause);
      documentNotice(`Could not delete the note: ${error.message}`, "error");
    }
  });
}
export async function openHistory(): Promise<void> {
  if (!documentSession.current || !projectModel.active?.owned) return;
  closeMenus();
  const generation = ++historyState.historyGeneration;
  historyState.historyView = {
    id: documentSession.current.id,
    path: documentSession.current.path,
    project: projectModel.active.id,
    document: documentSession.id,
    selected: null,
  };
  appState.element("history-list").replaceChildren();
  appState.element("history-diff").textContent = "";
  appState.element("history-restore").disabled = true;
  appState.element("history-copy").disabled = true;
  showDialog(historyState.historyDialog);
  notice(appState.element("history-message"), "Loading history…");
  try {
    const result = await api(`/api/history?document=${encodeURIComponent(historyState.historyView.id)}`, {
      decode: decodedHistory,
    });
    if (generation !== historyState.historyGeneration || !historyState.historyDialog.open) return;
    historyState.historyView.version = result.currentVersion;
    historyState.historyView.current = documentSession.current.content;
    appState.element("history-list").replaceChildren(
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
    notice(
      appState.element("history-message"),
      result.revisions.length ? "" : "No earlier versions have been recorded.",
    );
    if (result.revisions.length) await selectHistoryVersion(result.revisions[0].id);
  } catch (errorCause) {
    const error = errorContext(errorCause);
    notice(appState.element("history-message"), error.message, "error");
  }
}
export async function selectHistoryVersion(id: number): Promise<void> {
  const view = historyState.historyView;
  const generation = ++historyState.historyGeneration;
  notice(appState.element("history-message"), "Loading version…");
  try {
    const result = await api(
      `/api/history/content?document=${encodeURIComponent(requireValue(view).id)}&revision=${id}`,
      {
        decode: decodedRevisionContent,
      },
    );
    if (
      generation !== historyState.historyGeneration ||
      historyState.historyView !== view ||
      !historyState.historyDialog.open
    )
      return;
    requireValue(view).selected = result;
    for (const button of htmlChildren(appState.element("history-list")))
      button.setAttribute("aria-pressed", String(Number(button.dataset.id) === id));
    appState.element("history-detail").textContent =
      "Selected version compared with the open document. Red is removed; green is current.";
    const changes = diffLines(result.content, requireValue(requireValue(view).current), { timeout: 200 });
    const diff = appState.element("history-diff");
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
      appState.element("history-message"),
      !changes
        ? "The diff is too large. Showing the selected version; Copy version retains all text."
        : remaining <= 0
          ? "The preview is truncated. Copy version retains all text."
          : "",
      "warning",
    );
    appState.element("history-copy").disabled = false;
    appState.element("history-restore").disabled =
      !requireValue(view).version || requireValue(view).version === result.revision.version;
  } catch (errorCause) {
    const error = errorContext(errorCause);
    notice(appState.element("history-message"), error.message, "error");
  }
}
export async function openTrash(): Promise<void> {
  closeMenus();
  showDialog(historyState.trashDialog);
  notice(appState.element("trash-message"), "Loading recycle bin…");
  try {
    const entries = await api("/api/trash", {
      decode: decodedTrash,
    });
    appState.element("trash-list").replaceChildren(
      ...entries.map((entry: TrashEntry) => {
        const row = document.createElement("div");
        const name = document.createElement("span");
        name.className = "workspace-item-name";
        name.textContent = entry.path;
        const details = document.createElement("small");
        details.textContent = `${new Date(entry.deleted).toLocaleString()} · ${formatByteCount(entry.size)}`;
        name.append(details);
        const restore = document.createElement("button");
        restore.type = "button";
        restore.textContent = "Restore";
        restore.setAttribute("aria-label", `Restore ${entry.path}`);
        restore.addEventListener("click", async () => {
          restore.disabled = true;
          const project = projectModel.active?.id;
          try {
            await api("/api/trash/restore", { method: "POST", body: { id: entry.id } });
            if (projectModel.active?.id === project) {
              if (historyState.trashDialog.open) await openTrash();
              void refreshFiles();
            }
          } catch (errorCause) {
            const error = errorContext(errorCause);
            notice(appState.element("trash-message"), error.message, "error");
            restore.disabled = false;
          }
        });
        row.append(name, restore);
        return row;
      }),
    );
    notice(appState.element("trash-message"), entries.length ? "" : "The recycle bin is empty.");
  } catch (errorCause) {
    const error = errorContext(errorCause);
    notice(appState.element("trash-message"), error.message, "error");
  }
}
