import { documentSession } from "../../state/document";
import { decodedPreview } from "../../api/contracts";
import { decorateCodeBlocks } from "@folio/editor-runtime";
import { MAX_MARKDOWN_BYTES, serializeEditorText } from "@folio/model";
import type { DocumentSessionId } from "@folio/model";
import { shell } from "../../state/shell";
import { clearTimer, requireValue } from "../../types/elements";
import { errorContext } from "../../types/errors";
import { connectionFailure } from "../accounts/authentication";
import { api } from "../core/api";
import { appState, currentEditorAnalysis, rootChanged } from "../core/bootstrap";
import { ApiError, aborted, previewStatus } from "../core/dom";
import { settingsState } from "../preferences/settings";
import { projectUrl } from "../projects/projects";
import { restoreViewPosition } from "./navigation";
import { onApplicationDispose } from "../lifecycle";
class PreviewState {
  deferredPreview!: {
    html: string;
    resetScroll: boolean;
    document: DocumentSessionId;
    revision: number;
  } | null;
}
export const previewState = new PreviewState();
export function initializeDocumentsPreview(): void {
  previewState.deferredPreview = null;
  onApplicationDispose(invalidatePreview);
}
export function invalidatePreview(): void {
  clearTimer(appState.previewTimer);
  appState.previewTimer = null;
  appState.previewGate.invalidate();
  appState.previewController?.abort();
  appState.previewController = null;
}
export function emptyPreview(title: string | null, message: string): void {
  const container = document.createElement("div");
  container.className = "empty-state";
  const heading = document.createElement("h2");
  heading.textContent = title;
  const paragraph = document.createElement("p");
  paragraph.textContent = message;
  container.append(heading, paragraph);
  appState.ui.preview.replaceChildren(container);
}
export function renderPreview(html: string | null, resetScroll = false): void {
  if (html === null) {
    previewState.deferredPreview = null;
    appState.renderedPreviewDocument = null;
    appState.renderedPreviewRevision = -1;
    appState.ui.preview.replaceChildren();
    if (["split", "preview"].includes(shell.view)) schedulePreview(0);
    return;
  }
  resetScroll ||=
    appState.renderedPreviewDocument !== documentSession.id ||
    (previewState.deferredPreview?.document === documentSession.id && previewState.deferredPreview.resetScroll);
  if (!["split", "preview"].includes(shell.view)) {
    previewState.deferredPreview = {
      html,
      resetScroll,
      document: documentSession.id,
      revision: documentSession.revision,
    };
    return;
  }
  previewState.deferredPreview = null;
  const scrollTop = resetScroll ? 0 : appState.ui.preview.scrollTop;
  // This is the only HTML sink: the authenticated Rust renderer escapes and sanitizes Markdown.
  appState.ui.preview.innerHTML = html;
  decorateCodeBlocks(appState.ui.preview);
  for (const node of appState.ui.preview.querySelectorAll<HTMLAnchorElement>("a[href], img[src]")) {
    const attribute = node.tagName === "IMG" ? "src" : "href";
    node.dataset.noteUrl = requireValue(node.getAttribute(attribute), "Resource URL");
    node.dataset.noteTitle = node.getAttribute("title") ?? "";
  }
  for (const paragraph of appState.ui.preview.querySelectorAll<HTMLElement>("p:has(> img)")) {
    const nodes = [...paragraph.childNodes];
    const content = nodes.filter((node) => node.nodeType !== Node.TEXT_NODE || requireValue(node.textContent).trim());
    const images: HTMLImageElement[] = [];
    for (const node of content) {
      if (!(node instanceof HTMLImageElement)) break;
      images.push(node);
    }
    if (
      images.length < 2 ||
      images.some((node) => node.style.display === "block") ||
      content
        .slice(images.length)
        .some((node) => node instanceof HTMLImageElement || (node instanceof Element && node.querySelector("img")))
    )
      continue;
    const between = nodes.slice(0, nodes.indexOf(images[images.length - 1]));
    if (
      between.some((node) => requireValue(node.textContent).includes("\n")) &&
      images.some((node) => node.style.display !== "inline")
    )
      continue;
    for (const node of between) if (node.nodeType === Node.TEXT_NODE) node.remove();
    paragraph.classList.add("folio-image-row");
    paragraph.style.setProperty("--folio-image-row-count", String(images.length));
  }
  refreshPreviewLinks();
  if (!html.trim()) emptyPreview("A fresh page", "Start typing Markdown in the editor. Your preview will appear here.");
  for (const link of appState.ui.preview.querySelectorAll<HTMLAnchorElement>(
    'a[href]:not([href^="/"]):not([href^="#"])',
  )) {
    if (link.origin !== window.location.origin) {
      link.target = "_blank";
      link.rel = "noopener noreferrer";
    }
  }
  appState.ui.preview.scrollTop = scrollTop;
  appState.renderedPreviewDocument = documentSession.id;
  appState.renderedPreviewRevision = documentSession.revision;
  restoreViewPosition();
}
export function refreshPreviewLinks(): void {
  for (const node of appState.ui.preview.querySelectorAll<HTMLElement>("[data-note-url]")) {
    const attribute = node.tagName === "IMG" ? "src" : "href";
    const url = projectUrl(node.dataset.noteUrl);
    if (url) {
      node.setAttribute(attribute, url);
      if (node.dataset.noteTitle) node.title = node.dataset.noteTitle;
      else node.removeAttribute("title");
    } else {
      node.removeAttribute(attribute);
      node.title = "This resource is unavailable in the current document.";
    }
  }
}
export function scrollToHeading(hash: string): void {
  if (!hash || hash === "#") {
    const scroller =
      shell.view === "rich"
        ? appState.element("rich-editor").querySelector<HTMLElement>("[data-editor-scroller]")
        : appState.ui.preview;
    scroller?.scrollTo({ top: 0, behavior: "auto" });
    return;
  }
  let id = hash.slice(1);
  try {
    id = decodeURIComponent(id);
  } catch {
    // A literal percent sign is also a valid heading identifier.
  }
  if (shell.view === "rich") {
    appState.inlineEditor.jumpTo(id);
    return;
  }
  const target = appState.ui.preview.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
  if (!target) return;
  const top =
    target.getBoundingClientRect().top -
    appState.ui.preview.getBoundingClientRect().top +
    appState.ui.preview.scrollTop -
    14;
  appState.ui.preview.scrollTo({
    top: Math.max(0, top),
    behavior: "instant",
  });
}
export function schedulePreview(delay = settingsState.webPreferences.previewDelayMs): void {
  invalidatePreview();
  if (!documentSession.current) return;
  if (!["split", "preview"].includes(shell.view)) return;
  if (currentEditorAnalysis().bytes > MAX_MARKDOWN_BYTES) {
    previewStatus("Preview paused: the note exceeds 4 MiB.", true);
    return;
  }
  if (rootChanged()) {
    previewStatus("Preview paused: the notes folder changed.", true);
    return;
  }
  if (
    previewState.deferredPreview?.document === documentSession.id &&
    previewState.deferredPreview.revision === documentSession.revision
  ) {
    renderPreview(previewState.deferredPreview.html, previewState.deferredPreview.resetScroll);
  } else {
    previewState.deferredPreview = null;
  }
  if (
    appState.renderedPreviewDocument === documentSession.id &&
    appState.renderedPreviewRevision === documentSession.revision
  ) {
    previewStatus("Up to date");
    return;
  }
  if (appState.connectionState !== "ready") {
    previewStatus("Disconnected. The last successful preview is still shown.", true);
    return;
  }
  const ticket = appState.previewGate.next();
  const revision = documentSession.revision;
  const id = documentSession.id;
  previewStatus(delay ? "Waiting for typing…" : "Updating…");
  appState.previewTimer = window.setTimeout(async () => {
    if (!appState.previewGate.isCurrent(ticket) || id !== documentSession.id || revision !== documentSession.revision)
      return;
    const controller = new AbortController();
    appState.previewController = controller;
    const body = {
      id: requireValue(documentSession.current).id,
      content: serializeEditorText(requireValue(documentSession.current), appState.ui.editor.value),
    };
    previewStatus("Updating…");
    try {
      const payload = await api("/api/preview", {
        decode: decodedPreview,
        method: "POST",
        body,
        signal: controller.signal,
      });
      if (!appState.previewGate.isCurrent(ticket) || id !== documentSession.id || revision !== documentSession.revision)
        return;
      if (typeof payload?.html !== "string") throw new ApiError("The service returned an incomplete preview.");
      renderPreview(payload.html);
      previewStatus("Up to date");
    } catch (errorCause) {
      const error = errorContext(errorCause);
      if (!appState.previewGate.isCurrent(ticket) || aborted(error)) return;
      const kept =
        appState.renderedPreviewDocument === documentSession.id ? " The last successful preview is still shown." : "";
      previewStatus(`Preview failed: ${error.message}${kept}`, true);
      connectionFailure(error);
    } finally {
      if (appState.previewGate.isCurrent(ticket)) appState.previewController = null;
    }
  }, delay);
}
