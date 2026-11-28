import { buildFileTree, type FileTree } from "@folio/model";
import { orderedChildren, orderId, placeRelative, type Insertion } from "../../models/tree-order";
import { authenticationSession } from "../../state/authentication";
import { libraryCatalog, libraryModel, libraryView } from "../../state/library";
import { projectModel } from "../../state/projects";
import { appState } from "../core/bootstrap";
import { readLayoutPreference, storeLayoutPreference } from "../core/layout";
import { settingsState } from "../preferences/settings";

function preferenceKey() {
  const { mode, scope } = authenticationSession;
  if (scope.signal.aborted || !appState.currentRoot) return null;
  const project = mode === "users" ? projectModel.active?.id : appState.currentRoot;
  if (!project || !(mode === "launchToken" || (mode === "users" && scope.principal))) return null;
  return `folio.tree.order.${JSON.stringify([mode, scope.principal, project])}`;
}

export function restoreTreeOrder(): void {
  const key = preferenceKey();
  const order = new Map<string, string[]>();
  try {
    const saved: unknown = key && JSON.parse(readLayoutPreference(key) ?? "null");
    if (Array.isArray(saved))
      for (const pair of saved) {
        if (!Array.isArray(pair)) continue;
        const [parent, ids] = pair;
        if (typeof parent === "string" && Array.isArray(ids) && ids.every((id) => typeof id === "string"))
          order.set(parent, ids);
      }
  } catch {
    // Ignore malformed local preferences; the authorized server tree is the only source of rows.
  }
  libraryModel.setOrder(order);
}

export function rememberInsertion(parentPath: string, source: string, anchor: string, position: Insertion) {
  const key = preferenceKey();
  if (!key) return;
  // A reorder in a filtered view must not discard or shift the other siblings out of their saved order.
  let branch: FileTree | undefined =
    libraryView.query.trim() || settingsState.hiddenPatterns.length
      ? buildFileTree(libraryCatalog.files, libraryCatalog.directories)
      : libraryView.tree;
  for (const part of parentPath ? parentPath.split("/") : []) {
    branch = branch.directories.find((child) => child.name === part);
    if (!branch) return;
  }
  const order = new Map(libraryCatalog.order);
  const next = placeRelative(
    orderedChildren(branch, order.get(orderId(branch))).map(orderId),
    source,
    anchor,
    position,
  );
  if (!next) return;
  order.set(orderId(branch), next);
  libraryModel.setOrder(order);
  storeLayoutPreference(key, JSON.stringify([...order]));
}
