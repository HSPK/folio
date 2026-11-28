import { createButton } from "@folio/editor-runtime";
import { projectModel } from "../../state/projects";
import { documentSession } from "../../state/document";
import { decodedAttachments, decodedBacklinks } from "../../api/contracts";
import { formatByteCount } from "@folio/model";
import type { Backlink } from "../../types/domain";
import { element, datasetValue } from "../../types/elements";
import { errorContext } from "../../types/errors";
import { closeMenus } from "../accounts/authentication";
import { api } from "../core/api";
import { createListRow, documentNotice, notice } from "../core/dom";
import { confirmAction, showDialog } from "../dialogs/dialogs";
import { listen } from "../lifecycle";

import { publicState } from "../sharing/public";
import { navigateTo } from "./navigation";
let attachmentEntries: {
  id: string;
  path: string;
  size: number;
  stamp: string;
  referenced: boolean;
}[];
let attachmentScanTruncated: boolean;

export function initializeDocumentsRelated(): void {
  attachmentEntries = [];
  attachmentScanTruncated = false;
  listen(element("attachments-open"), "click", () => {
    closeMenus();
    showDialog(element("attachments-dialog"));
    void loadAttachments();
  });
  listen(element("attachments-close"), "click", () => element("attachments-dialog").close());
  listen(element("attachments-unused"), "change", renderAttachments);
  listen(element("attachments-refresh"), "click", () => void loadAttachments());
  listen(element("attachments-recycle"), "click", async () => {
    const paths = new Set(
      [...element("attachments-list").querySelectorAll<HTMLInputElement>("input:checked")].map((input) =>
        datasetValue(input, "path"),
      ),
    );
    const files = attachmentEntries.filter((entry) => paths.has(entry.path)).map(({ id, stamp }) => ({ id, stamp }));
    if (!files.length) {
      notice(element("attachments-message"), "No attachments selected");
      return;
    }
    if (!(await confirmAction(`Recycle ${files.length} attachments?`, { label: "Recycle files" }))) return;
    element("attachments-recycle").disabled = true;
    try {
      await api("/api/attachments", { method: "POST", body: { files } });
      await loadAttachments();
      documentNotice("");
    } catch (errorCause) {
      const error = errorContext(errorCause);
      notice(element("attachments-message"), error.message, "error");
    } finally {
      element("attachments-recycle").disabled = attachmentScanTruncated;
    }
  });
  listen(element("backlinks-open"), "click", async () => {
    if (!documentSession.current || publicState.publicView) return;
    closeMenus();
    const id = documentSession.id;
    const project = projectModel.active?.id;
    element("backlinks-list").replaceChildren();
    showDialog(element("backlinks-dialog"));
    notice(element("backlinks-message"), "Finding links…");
    try {
      const references = await api(`/api/backlinks?document=${encodeURIComponent(documentSession.current.id)}`, {
        decode: decodedBacklinks,
      });
      if (id !== documentSession.id || project !== projectModel.active?.id) return;
      element("backlinks-list").replaceChildren(
        ...references.map((reference: Backlink) => {
          const button = createButton({ label: reference.title ?? reference.path });

          button.title = reference.path;
          button.addEventListener("click", () => {
            element("backlinks-dialog").close();
            void navigateTo(reference.id);
          });
          return button;
        }),
      );
      notice(element("backlinks-message"), references.length ? "" : "No backlinks");
    } catch (errorCause) {
      const error = errorContext(errorCause);
      notice(element("backlinks-message"), error.message, "error");
    }
  });
  listen(element("backlinks-close"), "click", () => element("backlinks-dialog").close());
}
async function loadAttachments(): Promise<void> {
  notice(element("attachments-message"), "Checking references…");
  try {
    const result = await api("/api/attachments", {
      decode: decodedAttachments,
    });
    attachmentEntries = result.files;
    attachmentScanTruncated = result.truncated;
    renderAttachments();
    notice(
      element("attachments-message"),
      result.truncated ? "Scan incomplete, recycling disabled" : "",
      result.truncated ? "warning" : "",
    );
  } catch (errorCause) {
    const error = errorContext(errorCause);
    notice(element("attachments-message"), error.message, "error");
  }
}
function renderAttachments(): void {
  const entries = attachmentEntries.filter((entry) => !element("attachments-unused").checked || !entry.referenced);
  element("attachments-list").replaceChildren(
    ...entries.map((entry) => {
      const row = createListRow(
        entry.path,
        `${formatByteCount(entry.size)} · ${entry.referenced ? "Referenced" : "Unreferenced"}`,
      );
      const select = document.createElement("input");
      select.type = "checkbox";
      select.dataset.path = entry.path;
      select.disabled = entry.referenced || entry.size > 16 * 1024 * 1024 || attachmentScanTruncated;
      select.setAttribute("aria-label", `Select ${entry.path}`);
      row.prepend(select);
      return row;
    }),
  );
  element("attachments-recycle").disabled = attachmentScanTruncated;
}
