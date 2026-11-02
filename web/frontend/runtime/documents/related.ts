import { projectModel } from "../../state/projects";
import { documentSession } from "../../state/document";
import { decodedAttachments, decodedBacklinks } from "../../api/contracts";
import { formatByteCount } from "@folio/model";
import type { Backlink } from "../../types/domain";
import { datasetValue } from "../../types/elements";
import { errorContext } from "../../types/errors";
import { closeMenus } from "../accounts/authentication";
import { api } from "../core/api";
import { appState } from "../core/bootstrap";
import { documentNotice, notice } from "../core/dom";
import { confirmAction, showDialog } from "../dialogs/dialogs";
import { listen } from "../lifecycle";

import { publicState } from "../sharing/public";
import { navigateTo } from "./navigation";
class RelatedState {
  attachmentEntries!: {
    id: string;
    path: string;
    size: number;
    stamp: string;
    referenced: boolean;
  }[];
  attachmentScanTruncated!: boolean;
}
export const relatedState = new RelatedState();
export function initializeDocumentsRelated(): void {
  relatedState.attachmentEntries = [];
  relatedState.attachmentScanTruncated = false;
  listen(appState.element("attachments-open"), "click", () => {
    closeMenus();
    showDialog(appState.element("attachments-dialog"));
    void loadAttachments();
  });
  listen(appState.element("attachments-close"), "click", () => appState.element("attachments-dialog").close());
  listen(appState.element("attachments-unused"), "change", renderAttachments);
  listen(appState.element("attachments-refresh"), "click", () => void loadAttachments());
  listen(appState.element("attachments-recycle"), "click", async () => {
    const paths = new Set(
      [...appState.element("attachments-list").querySelectorAll<HTMLInputElement>("input:checked")].map((input) =>
        datasetValue(input, "path"),
      ),
    );
    const files = relatedState.attachmentEntries
      .filter((entry) => paths.has(entry.path))
      .map(({ id, stamp }) => ({ id, stamp }));
    if (!files.length) {
      notice(appState.element("attachments-message"), "Select attachments to recycle.");
      return;
    }
    if (
      !(await confirmAction(
        `Recycle ${files.length} selected attachments? Other programs or offline drafts may still reference them. They remain recoverable for 30 days.`,
        { label: "Recycle files" },
      ))
    )
      return;
    appState.element("attachments-recycle").disabled = true;
    try {
      await api("/api/attachments", { method: "POST", body: { files } });
      await loadAttachments();
      documentNotice("");
    } catch (errorCause) {
      const error = errorContext(errorCause);
      notice(appState.element("attachments-message"), error.message, "error");
    } finally {
      appState.element("attachments-recycle").disabled = relatedState.attachmentScanTruncated;
    }
  });
  listen(appState.element("backlinks-open"), "click", async () => {
    if (!documentSession.current || publicState.publicView) return;
    closeMenus();
    const id = documentSession.id;
    const project = projectModel.active?.id;
    appState.element("backlinks-list").replaceChildren();
    showDialog(appState.element("backlinks-dialog"));
    notice(appState.element("backlinks-message"), "Finding references…");
    try {
      const references = await api(`/api/backlinks?document=${encodeURIComponent(documentSession.current.id)}`, {
        decode: decodedBacklinks,
      });
      if (id !== documentSession.id || project !== projectModel.active?.id) return;
      appState.element("backlinks-list").replaceChildren(
        ...references.map((reference: Backlink) => {
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = reference.title ?? reference.path;
          button.title = reference.path;
          button.addEventListener("click", () => {
            appState.element("backlinks-dialog").close();
            void navigateTo(reference.id);
          });
          return button;
        }),
      );
      notice(
        appState.element("backlinks-message"),
        references.length ? "" : "No accessible notes link to this document.",
      );
    } catch (errorCause) {
      const error = errorContext(errorCause);
      notice(appState.element("backlinks-message"), error.message, "error");
    }
  });
  listen(appState.element("backlinks-close"), "click", () => appState.element("backlinks-dialog").close());
}
export async function loadAttachments(): Promise<void> {
  notice(appState.element("attachments-message"), "Checking Markdown references…");
  try {
    const result = await api("/api/attachments", {
      decode: decodedAttachments,
    });
    relatedState.attachmentEntries = result.files;
    relatedState.attachmentScanTruncated = result.truncated;
    renderAttachments();
    notice(
      appState.element("attachments-message"),
      result.truncated ? "The scan was limited. Recycling is disabled until the complete project can be checked." : "",
      result.truncated ? "warning" : "",
    );
  } catch (errorCause) {
    const error = errorContext(errorCause);
    notice(appState.element("attachments-message"), error.message, "error");
  }
}
export function renderAttachments(): void {
  const entries = relatedState.attachmentEntries.filter(
    (entry) => !appState.element("attachments-unused").checked || !entry.referenced,
  );
  appState.element("attachments-list").replaceChildren(
    ...entries.map((entry) => {
      const row = document.createElement("div");
      const select = document.createElement("input");
      select.type = "checkbox";
      select.dataset.path = entry.path;
      select.disabled = entry.referenced || entry.size > 16 * 1024 * 1024 || relatedState.attachmentScanTruncated;
      select.setAttribute("aria-label", `Select ${entry.path}`);
      const name = document.createElement("span");
      name.className = "workspace-item-name";
      name.textContent = entry.path;
      const details = document.createElement("small");
      details.textContent = `${formatByteCount(entry.size)} · ${entry.referenced ? "Referenced by Markdown" : "No saved Markdown reference"}`;
      name.append(details);
      row.append(select, name);
      return row;
    }),
  );
  appState.element("attachments-recycle").disabled = relatedState.attachmentScanTruncated;
}
