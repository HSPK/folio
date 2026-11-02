import { documentSession } from "../../state/document";
import { shell } from "../../state/shell";

import { appState } from "../core/bootstrap";

export function loadInlineEditor(): void {
  if (!documentSession.current) {
    appState.inlineEditorPath = null;
    appState.inlineEditor.clear();
    return;
  }
  if (shell.view !== "rich") return;
  if (
    appState.inlineEditor.isReady() &&
    appState.inlineEditorPath === documentSession.current.path &&
    appState.inlineEditor.getSource() === appState.ui.editor.value
  )
    return;
  appState.inlineEditorPath = documentSession.current.path;
  void appState.inlineEditor.load(appState.ui.editor.value, documentSession.current.path);
}

export function loadInlineEditorAfterPaint(): void {
  if (
    !documentSession.current ||
    shell.view !== "rich" ||
    !appState.inlineEditor.shouldDeferLoad(appState.ui.editor.value)
  ) {
    loadInlineEditor();
    return;
  }
  appState.inlineEditorPath = null;
  appState.inlineEditor.clear({ keepParsedBodies: true });
  appState.element("rich-editor").setAttribute("aria-busy", "true");
  const id = documentSession.id;
  window.requestAnimationFrame(() =>
    window.setTimeout(() => {
      if (id === documentSession.id) loadInlineEditor();
    }, 0),
  );
}
