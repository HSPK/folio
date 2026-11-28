import { entryDestination } from "@folio/model";
import { orderId, type Insertion } from "../../models/tree-order";
import { authenticationSession } from "../../state/authentication";
import { libraryCatalog, libraryModel, libraryView } from "../../state/library";
import { projectModel } from "../../state/projects";
import { element, entryKind } from "../../types/elements";
import { appState, rootChanged } from "../core/bootstrap";
import { listen } from "../lifecycle";
import { projectCanMove } from "../projects/permissions";
import { moveLibraryEntry } from "./files";
import { rememberInsertion } from "./order";

const parentOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf("/")));

interface Source {
  row: HTMLElement;
  path: string;
  kind: "file" | "directory";
  id?: string;
  current: () => boolean;
}
interface Target {
  marker: HTMLElement;
  position: Insertion | "inside";
  parent: string;
  anchor: string;
  destination: string;
}

export function initializeTreeDrag(): void {
  let source: Source | null = null;
  let marker: HTMLElement | null = null;
  let paths = new Set<string>();
  let version = -1;

  const occupied = (path: string) => {
    if (version !== libraryModel.version) {
      paths = new Set([...libraryCatalog.files, ...libraryCatalog.directories].map((entry) => entry.path));
      version = libraryModel.version;
    }
    return paths.has(path) || libraryView.pending.some((entry) => entryDestination(entry.name, entry.parent) === path);
  };
  function hit(event: DragEvent, from: Source): Target | null {
    if (
      !from.current() ||
      !from.row.isConnected ||
      from.row.dataset.resourceId !== from.id ||
      from.row.dataset.entryPath !== from.path ||
      appState.movingEntry ||
      !(event.target instanceof Element)
    )
      return null;
    const row = event.target.closest<HTMLElement>("[data-entry-path], .library-heading[data-directory-path]");
    if (!row || row === from.row) return null;
    const path = row.dataset.entryPath ?? "";
    let position: Target["position"] = "inside";
    if (path) {
      const bounds = row.getBoundingClientRect();
      const fraction = (event.clientY - bounds.top) / bounds.height;
      if (row.dataset.entryKind === "file") position = fraction < 0.5 ? "before" : "after";
      else if (fraction < 0.25) position = "before";
      else if (fraction > 0.75) position = "after";
    }
    const parent = position === "inside" ? path : parentOf(path);
    const destination = entryDestination(from.path, parent);
    if (from.kind === "directory" && (parent === from.path || parent.startsWith(`${from.path}/`))) return null;
    if (destination === from.path) {
      if (position === "inside") return null;
    } else if (
      !from.id ||
      appState.connectionState !== "ready" ||
      !projectCanMove(from.path, from.kind, destination) ||
      occupied(destination)
    )
      return null;
    return {
      marker: position === "inside" ? (row.closest("details") ?? row) : (row.closest("li") ?? row),
      position,
      parent,
      anchor: orderId({ id: row.dataset.resourceId, path }),
      destination,
    };
  }
  function mark(target: Target | null) {
    const value = target?.position === "inside" ? "true" : target?.position;
    if (marker === target?.marker && marker.dataset.dropTarget === value) return;
    marker?.removeAttribute("data-drop-target");
    marker = target?.marker ?? null;
    if (marker && value) marker.dataset.dropTarget = value;
  }
  function clear() {
    source?.row.removeAttribute("data-dragging");
    source = null;
    paths.clear();
    version = -1;
    mark(null);
  }
  listen(element("file-list"), "dragstart", (event) => {
    const element = event.target;
    const row = element instanceof Element ? element.closest<HTMLElement>("[data-entry-path]") : null;
    if (!row) return;
    const { scope, mode } = authenticationSession;
    const project = projectModel.selection;
    const root = appState.currentRoot;
    const current = () =>
      Boolean(root && root === appState.currentRoot && !rootChanged() && libraryCatalog.loaded) &&
      authenticationSession.isCurrent(scope) &&
      project === projectModel.selection;
    if (
      !current() ||
      !(mode === "launchToken" || (mode === "users" && scope.principal && projectModel.active)) ||
      appState.movingEntry ||
      (element instanceof Element && element.closest(".directory-actions")) ||
      !event.dataTransfer
    ) {
      event.preventDefault();
      return;
    }
    clear();
    source = { row, id: row.dataset.resourceId, path: row.dataset.entryPath!, kind: entryKind(row), current };
    row.dataset.dragging = "true";
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-folio-tree-entry", "move");
  });
  listen(element("file-list"), "dragend", () => {
    if (source) clear();
  });
  listen(element("app-shell"), "dragover", (event) => {
    if (!source || !event.dataTransfer) return;
    const target = hit(event, source);
    mark(target);
    event.dataTransfer.dropEffect = target ? "move" : "none";
    if (target) event.preventDefault();
  });
  listen(element("app-shell"), "dragleave", (event) => {
    if (source && (!(event.relatedTarget instanceof Node) || !element("app-shell").contains(event.relatedTarget)))
      mark(null);
  });
  listen(element("app-shell"), "drop", async (event) => {
    if (!source) return;
    event.preventDefault();
    const from = source;
    const target = hit(event, from);
    clear();
    if (!target) return;
    const { destination, parent, anchor, position } = target;
    if (destination !== from.path) {
      // Keep the accepted destination visible while a real (server-authorized) move is in flight.
      mark(target);
      from.row.setAttribute("aria-busy", "true");
      try {
        if (!(await moveLibraryEntry(from, destination)) || !from.current()) return;
        if (position === "inside" && parent) libraryModel.setCollapsed(parent, false);
      } finally {
        from.row.removeAttribute("aria-busy");
        mark(null);
      }
    }
    if (position !== "inside") rememberInsertion(parent, orderId(from), anchor, position);
  });
}
