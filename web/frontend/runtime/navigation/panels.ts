import { createEffect, createRoot } from "solid-js";
import { mountCodeSource, createButton } from "@folio/editor-runtime";
import { decodedBoolean, decodedObject, decodedString, decodedResource } from "../../api/contracts";
import { authenticationSession } from "../../state/authentication";
import { activePanelPath, libraryCatalog, setActivePanelPath } from "../../state/library";
import { projectModel } from "../../state/projects";
import { errorContext } from "../../types/errors";
import { ApiError } from "../../api/error";
import { requiredQuery } from "../../types/elements";
import { api } from "../core/api";
import { confirmAction } from "../dialogs/dialogs";
import { applicationSignal } from "../lifecycle";
import { appState } from "../core/bootstrap";
import { setSidebar, closeMenus } from "../accounts/authentication";
import { cancelDocumentLoad } from "../documents/navigation";
import { updateFileSelection } from "./library";
import { openWorkbook } from "./workbook";
import { fileVisited } from "../workspace/workspace";
import { publicState } from "../sharing/public";

export function pdfFileUrl(path: string, download = false) {
  const params = new URLSearchParams({ path, ...(download ? { download: "true" } : {}) });
  if (publicState.publicView) {
    params.set("share", publicState.publicToken ?? "");
    params.set("view", "pdf");
    return `/api/public/panel-file?${params}`;
  }
  if (projectModel.active) params.set("project", projectModel.active.id);
  return `/assets/pdf?${params}`;
}

export async function openFilePanelResource(id: string, signal?: AbortSignal, preserveSidebar = false) {
  const selection = projectModel.selection;
  const resource = await api(`/api/resource?id=${encodeURIComponent(id)}`, { decode: decodedResource, signal });
  if (selection !== projectModel.selection || signal?.aborted) return;
  if (
    resource.kind !== "asset" ||
    (authenticationSession.mode === "users" && resource.project !== projectModel.active?.id)
  )
    throw new ApiError("File unavailable. Choose another file from the sidebar.", 404);
  await openFilePanel(resource.path, id, preserveSidebar);
}

const textButton = (label: string, action: () => void) => {
  const node = createButton({ label: label });

  node.addEventListener("click", action);
  return node;
};

let active: { leave: (signal?: AbortSignal) => Promise<boolean>; save: () => void } | null = null;
export const leaveFilePanel = (signal?: AbortSignal) => active?.leave(signal) ?? Promise.resolve(true);
export const saveFilePanel = () => active?.save();

export async function openFilePanel(path: string, resourceId?: string, preserveSidebar = false) {
  if (activePanelPath() === path) return;
  const selection = projectModel.selection;
  if (active && !(await leaveFilePanel())) return;
  if (active || projectModel.selection !== selection) return;
  cancelDocumentLoad();
  closeMenus();
  const dialog = requiredQuery(document, "#workspace-file-panel", HTMLElement);
  const body = requiredQuery(dialog, "#panel-body", HTMLDivElement);
  const sheets = requiredQuery(dialog, "#panel-sheets", HTMLDivElement);
  const tools = requiredQuery(dialog, "#panel-tools", HTMLDivElement);
  const status = requiredQuery(dialog, "#panel-status", HTMLParagraphElement);
  const kind = /\.pdf$/i.test(path) ? "PDF" : /\.xlsx$/i.test(path) ? "Workbook" : "Source";
  const title = path.slice(path.lastIndexOf("/") + 1);
  requiredQuery(dialog, "#panel-kind", HTMLElement).textContent = kind;
  requiredQuery(dialog, "#panel-title", HTMLElement).textContent = title;
  const owner = new AbortController();
  const signal = AbortSignal.any([owner.signal, authenticationSession.scope.signal, applicationSignal()]);
  const url = `/api/panel-file?${new URLSearchParams({ path })}`;
  let destroySource: (() => void) | undefined;
  let checkChanges = () => {};
  let changed = false,
    saving = false;
  const close = async (navigationSignal?: AbortSignal) => {
    if (saving || navigationSignal?.aborted) return false;
    checkChanges();
    if (
      changed &&
      !(await confirmAction("Discard unsaved code changes?", {
        label: "Discard",
        signal: navigationSignal ? AbortSignal.any([signal, navigationSignal]) : signal,
      }))
    )
      return false;
    if (!current() || navigationSignal?.aborted) return false;
    owner.abort();
    return true;
  };
  const session = { leave: close, save: () => {} };
  active = session;
  setActivePanelPath(path);
  void fileVisited(path, resourceId);
  updateFileSelection();
  if (appState.compactLayout.matches && !preserveSidebar) setSidebar(false, true);
  dialog.dataset.kind = kind.toLowerCase();
  body.focus({ preventScroll: true });
  status.textContent = "Loading…";
  body.replaceChildren();
  tools.replaceChildren();
  const current = () => !signal.aborted && active === session && projectModel.selection === selection;
  let catalogCheck = 0;
  let hadCatalog = libraryCatalog.loaded;
  const dispose = createRoot((dispose) => {
    createEffect(() => {
      const check = ++catalogCheck;
      if (projectModel.selection !== selection || (hadCatalog && !libraryCatalog.loaded)) {
        owner.abort();
      } else if (libraryCatalog.loaded && !libraryCatalog.panelFiles.some((f) => f.path === path)) {
        if (!changed) return owner.abort();
        // A missing entry may mean deletion or loss of access. Only keep a draft in the former case.
        void api(url, { signal }).catch((cause: unknown) => {
          if (!current() || check !== catalogCheck) return;
          if (errorContext(cause).status === 404)
            status.textContent = "File moved or deleted. Copy your changes before closing.";
          else owner.abort();
        });
      }
      hadCatalog ||= libraryCatalog.loaded;
    });
    return dispose;
  });
  const end = () => {
    dispose();
    destroySource?.();
    if (active !== session) return;
    active = null;
    setActivePanelPath(null);
    body.replaceChildren();
    tools.replaceChildren();
    sheets.replaceChildren();
    body.removeAttribute("role");
    body.removeAttribute("aria-labelledby");
    body.removeAttribute("aria-busy");
    updateFileSelection();
  };
  if (signal.aborted) return end();
  signal.addEventListener("abort", end, { once: true });
  requiredQuery(dialog, "#panel-close", HTMLButtonElement).addEventListener(
    "click",
    async () => {
      if (await close())
        document.querySelector<HTMLElement>('#file-list [tabindex="0"]')?.focus({ preventScroll: true });
    },
    { signal },
  );
  window.addEventListener(
    "beforeunload",
    (e) => {
      if (changed || saving) {
        e.preventDefault();
        e.returnValue = "";
      }
    },
    { signal },
  );
  const report = (cause: unknown) => {
    if (current()) status.textContent = errorContext(cause).message;
  };
  try {
    if (kind === "PDF") {
      const frame = document.createElement("iframe");
      frame.title = title;
      frame.src = pdfFileUrl(path);
      body.setAttribute("aria-busy", "true");
      frame.addEventListener(
        "load",
        () => {
          if (current() && frame.isConnected) {
            body.removeAttribute("aria-busy");
            status.textContent = "";
          }
        },
        { once: true, signal },
      );
      const download = document.createElement("a");
      download.href = pdfFileUrl(path, true);
      download.download = title;
      download.textContent = "Download PDF";
      tools.append(download);
      if (navigator.pdfViewerEnabled === false) {
        body.removeAttribute("aria-busy");
        status.textContent = "This browser cannot preview PDFs. Download the file to open it.";
      } else {
        body.append(frame);
      }
      void api(`${url}&view=pdf&meta=true`, { signal }).catch((cause) => {
        if (current()) {
          frame.remove();
          body.removeAttribute("aria-busy");
          report(cause);
        }
      });
    } else if (kind === "Source") {
      const file = decodedObject(await api(url, { signal }), "code file");
      if (!current()) return;
      const writable = decodedBoolean(file.writable, "write permission");
      let version = decodedString(file.version, "file version");
      let saved = decodedString(file.content, "code").replace(/\r\n?/g, "\n");
      const save = async () => {
        if (!current() || !writable || !changed || saving) return;
        const content = editor.getValue();
        saving = true;
        button.disabled = true;
        status.textContent = "Saving…";
        try {
          const result = decodedObject(
            await api("/api/panel-file", { method: "PUT", body: { path, version, content }, signal }),
            "save",
          );
          if (!current()) return;
          version = decodedString(result.version, "file version");
          saved = content;
          changed = editor.getValue() !== saved;
          status.textContent = changed ? "Unsaved changes" : "Saved";
        } catch (cause) {
          report(cause);
        } finally {
          saving = false;
          button.disabled = !changed;
        }
      };
      const button = textButton("Save", () => void save());
      button.disabled = true;
      session.save = () => void save();
      let idleCheck: number | undefined;
      const editor = mountCodeSource(body, {
        path,
        content: saved,
        readOnly: !writable,
        onSave: session.save,
        onChange() {
          changed = true;
          button.disabled = saving;
          status.textContent = "Unsaved changes";
          window.clearTimeout(idleCheck);
          idleCheck = window.setTimeout(checkChanges, 500);
        },
      });
      checkChanges = () => {
        if (!changed || editor.getValue() !== saved) return;
        changed = false;
        button.disabled = true;
        status.textContent = saving ? "Saving…" : "";
      };
      destroySource = () => {
        window.clearTimeout(idleCheck);
        editor.destroy();
      };
      if (writable) tools.append(button);
      status.textContent = writable ? "" : "Read-only";
      if (document.activeElement === body) editor.focus();
    } else {
      await openWorkbook(url, signal, body, sheets, tools, status);
    }
  } catch (cause) {
    report(cause);
  }
}
