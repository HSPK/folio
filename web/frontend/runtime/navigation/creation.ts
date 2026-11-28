import { element } from "../../types/elements";
import { decodedDirectory, decodedDocument } from "../../api/contracts";
import { authenticationSession } from "../../state/authentication";
import { documentSession } from "../../state/document";
import { libraryCatalog, libraryModel, libraryView, type PendingEntry } from "../../state/library";
import { projectModel } from "../../state/projects";
import {
  makeNoteUrl,
  noteName,
  validateNewDirectoryPath,
  validateNewNotePath,
  type DocumentPayload,
} from "@folio/model";
import { errorContext } from "../../types/errors";
import { closeMenus, connectionFailure, refreshControls, setSidebar } from "../accounts/authentication";
import { api } from "../core/api";
import { appState, dirty } from "../core/bootstrap";
import { cancelDocumentLoad, commitUrl, useDocument } from "../documents/navigation";
import { queueDraftPersistence } from "../documents/drafts";
import { scheduleAutoSave, saveBeforeLeaving } from "../documents/saving";
import { startDocumentParticipation } from "../collaboration/participation";
import { collaboration } from "../collaboration/collaboration";
import { noteVisited } from "../workspace/workspace";
import { currentResourceId } from "../documents/resources";
import { duplicatePanelFile } from "./file-actions";
import { projectCanCreate } from "../projects/permissions";
import { refreshFiles, renderFiles, updateFileSelection } from "./library";
import { closeFileContextMenu } from "./files";

const creates = new Map<string, Promise<DocumentPayload | null>>();
const waiting = new Set<() => void>();
export function resumeLibraryWrites() {
  for (const run of [...waiting]) run();
}
export function waitForConnection(signal: AbortSignal) {
  if (appState.connectionState === "ready" || signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const resume = () => {
      waiting.delete(resume);
      signal.removeEventListener("abort", resume);
      resolve();
    };
    waiting.add(resume);
    signal.addEventListener("abort", resume, { once: true });
  });
}
const entryFor = (key: string) => libraryView.pending.find((entry) => entry.key === key);
const joined = (parent: string, name: string) => (parent ? `${parent}/${name}` : name);
let sequence = 0;
const newKey = () => `local-new:${++sequence}`;
export const nameTaken = (path: string, key?: string) =>
  [...libraryCatalog.files, ...libraryCatalog.panelFiles, ...libraryCatalog.directories].some((e) => e.path === path) ||
  libraryView.pending.some((e) => e.key !== key && joined(e.parent, e.name) === path);

export function createTreeEntry(kind: PendingEntry["kind"], parent = "") {
  if (!projectCanCreate() || !appState.currentRoot || !libraryCatalog.loaded) return;
  closeFileContextMenu(false);
  closeMenus();
  if (document.body.dataset.sidebar === "closed") setSidebar(true);
  const known = new Set([...libraryCatalog.files, ...libraryCatalog.directories].map(({ path }) => path));
  for (const entry of libraryView.pending) known.add(joined(entry.parent, entry.name));
  let name: string;
  for (let n = 1; ; n++) {
    name = `${kind === "file" ? "Untitled" : "New folder"}${n === 1 ? "" : ` ${n}`}${kind === "file" ? ".md" : ""}`;
    if (!known.has(joined(parent, name))) break;
  }
  stageTreeName({ key: newKey(), parent, kind, name, phase: "naming" });
}

export function duplicateTreeFile(path: string) {
  if (!projectCanCreate() || !libraryCatalog.loaded) return;
  closeFileContextMenu(false);
  if (!/\.(md|markdown)$/i.test(path)) {
    void duplicatePanelFile(path);
    return;
  }
  const id = currentResourceId(path);
  const parent = path.slice(0, Math.max(0, path.lastIndexOf("/")));
  const stem = noteName(path),
    ext = path.slice(path.lastIndexOf("."));
  let name = `${stem} copy${ext}`;
  for (let n = 2; nameTaken(joined(parent, name)); n++) name = `${stem} copy ${n}${ext}`;
  stageTreeName({
    key: newKey(),
    parent,
    kind: "file",
    name,
    phase: "naming",
    duplicateOf: id,
    content: documentSession.current?.id === id && !collaboration && dirty() ? appState.editor.value : undefined,
  });
}

function stageTreeName(entry: PendingEntry) {
  element("file-filter").value = "";
  const parent = entry.parent;
  for (let p = parent; p; p = p.slice(0, Math.max(0, p.lastIndexOf("/")))) libraryModel.setCollapsed(p, false);
  renderFiles();
  libraryModel.stage(entry);
}

export async function awaitCreatedResource(id: string) {
  if (!id.startsWith("local-new:")) return id;
  const document = await creates.get(id);
  if (!document) throw new Error("Name the new note and retry");
  return document.id;
}

export async function openPendingFile(key: string) {
  const entry = entryFor(key);
  if (!entry || entry.kind !== "file" || documentSession.current?.id === key) return;
  const creating = creates.get(key);
  if (!creating) return;
  const scope = projectModel.selection;
  const original = documentSession.id;
  const owner = authenticationSession.scope;
  cancelDocumentLoad();
  const current = () =>
    scope === projectModel.selection &&
    !owner.signal.aborted &&
    original === documentSession.id &&
    !documentSession.loading;
  if (!(await saveBeforeLeaving("open the new note")) || !current()) return;
  if (!entryFor(key) || (entry.duplicateOf && entry.content === undefined)) {
    const doc = await creating;
    if (doc && current()) useDocument(doc, appState.currentRoot, new URL(appState.committedUrl), "push");
    return;
  }
  if (entry.phase !== "syncing") return;
  openLocal(entry);
}

function openLocal(entry: PendingEntry) {
  useDocument(
    {
      id: entry.key,
      path: joined(entry.parent, entry.name),
      project: projectModel.active?.id,
      version: "",
      content: entry.content ?? "",
      title: entry.title,
      html: "",
    },
    appState.currentRoot,
    new URL(appState.committedUrl),
    "push",
    true,
  );
}

export function createTemplateFile(path: string, content: string, title: string) {
  const index = path.lastIndexOf("/");
  const entry: PendingEntry = {
    key: newKey(),
    parent: path.slice(0, Math.max(0, index)),
    name: path.slice(index + 1),
    phase: "syncing",
    kind: "file",
    content,
    title,
  };
  libraryModel.stage(entry);
  syncEntry(entry, false);
  openLocal(entry);
}

export function finishTreeName(input: HTMLInputElement, restoreFocus: boolean, cancel = false) {
  const key = input.dataset.namingKey;
  const entry = key && entryFor(key);
  if (
    !key ||
    !entry ||
    entry.phase === "syncing" ||
    (!restoreFocus &&
      entry.phase === "failed" &&
      input.value === (entry.kind === "file" ? noteName(entry.name) : entry.name))
  )
    return;
  if (cancel && (entry.phase === "failed" || entry.duplicateOf)) {
    if (documentSession.current?.id !== key) libraryModel.unstage(key);
    if (entry.duplicateOf && restoreFocus)
      element("file-list")
        .querySelector<HTMLElement>(`[data-resource-id="${CSS.escape(entry.duplicateOf)}"]`)
        ?.focus();
    return;
  }
  let name = (cancel ? entry.name : input.value).trim();
  const { parent, kind } = entry;
  try {
    if (!name || /[\\/]/.test(name)) throw new Error("Enter a name without slashes");
    if (kind === "file" && !/\.(md|markdown)$/i.test(name)) name += entry.name.slice(entry.name.lastIndexOf("."));
    const path = joined(parent, name);
    (kind === "file" ? validateNewNotePath : validateNewDirectoryPath)(path);
    if (nameTaken(path, key)) throw new Error("Name already exists");
  } catch (cause) {
    libraryModel.updatePending(key, { phase: "failed", error: errorContext(cause).message });
    return;
  }
  libraryModel.updatePending(key, { name, phase: "syncing", error: undefined });
  if (documentSession.current?.id === key) documentSession.relocate(joined(parent, name));
  syncEntry(entry, restoreFocus);
}

function syncEntry(entry: PendingEntry, restoreFocus: boolean) {
  const { key, parent, kind, name } = entry;
  const path = joined(parent, name);
  const scope = projectModel.selection;
  const owner = authenticationSession.scope;
  const root = appState.currentRoot;
  const current = () =>
    !owner.signal.aborted && scope === projectModel.selection && root === appState.currentRoot && !!entryFor(key);
  const send = async (): Promise<{ path: string; doc: DocumentPayload | null }> => {
    if (kind === "file") {
      return api("/api/document", {
        decode: decodedDocument,
        method: "POST",
        body:
          entry.duplicateOf && entry.content === undefined
            ? { path, duplicateOf: entry.duplicateOf }
            : { path, content: entry.content ?? "" },
        signal: owner.signal,
      }).then((doc) => ({ path: doc.path, doc }));
    }
    return api("/api/directory", {
      decode: decodedDirectory,
      method: "POST",
      body: { path },
      signal: owner.signal,
    }).then((directory) => ({ path: directory.path, doc: null }));
  };
  const row = element("file-list").querySelector<HTMLButtonElement>(`[data-local-open="${CSS.escape(key)}"]`);
  if (restoreFocus) row?.focus({ preventScroll: true });
  const completion = waitForConnection(owner.signal)
    .then(() => {
      if (!current() || !projectCanCreate()) throw new Error("Project changed");
      return send();
    })
    .then(({ path: createdPath, doc }) => {
      if (!current()) return null;
      if (createdPath !== path) throw new Error("Unexpected creation result");
      const focused = !!row && document.activeElement === row;
      libraryModel.publishCreated(path, doc?.id, kind);
      libraryModel.unstage(key);
      renderFiles();
      if (doc && documentSession.adoptCreated(key, doc)) {
        commitUrl(makeNoteUrl(appState.committedUrl, doc.id), "replace");
        updateFileSelection();
        refreshControls();
        noteVisited();
        // Do not reload the editor on acknowledgement: its local draft and selection are authoritative.
        scheduleAutoSave();
        queueDraftPersistence();
        void startDocumentParticipation();
      }
      if (focused)
        element("file-list")
          .querySelector<HTMLElement>(`[data-entry-path="${CSS.escape(path)}"]`)
          ?.focus({ preventScroll: true });
      void refreshFiles();
      return doc;
    })
    .catch((cause) => {
      if (current()) {
        const error = errorContext(cause);
        libraryModel.updatePending(key, {
          phase: "failed",
          error: error.status === 409 ? "Name already exists" : "Not synced. Press Enter to retry",
        });
        connectionFailure(error);
      }
      return null;
    })
    .finally(() => creates.delete(key));
  creates.set(key, completion);
}
