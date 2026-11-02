import { createInlineEditor, createOutlineExtractor } from "@folio/editor-runtime";
import { makeNoteUrl, readNoteRoute } from "@folio/model";
import { documentSession } from "../state/document";
import { shell } from "../state/shell";
import type { Heading } from "../types/domain";
import { requiredQuery } from "../types/elements";
import { refreshDocumentTitle } from "./accounts/authentication";
import { appState } from "./core/bootstrap";
import { notice } from "./core/notice";
import { uploadReplacementImage } from "./documents/images";
import { commitUrl, internalNoteUrl, navigateTo, restoreViewPosition } from "./documents/navigation";
import { scrollToHeading } from "./documents/preview";
import { canCreateLinkedNote, openLinkedNote } from "./documents/resources";
import { onApplicationDispose, ownApplicationResource } from "./lifecycle";
import { setView } from "./navigation/files";
import { renderOutline, setCurrentOutline } from "./navigation/outline";
import { visibleLibraryFiles } from "./preferences/settings";
import { projectUrl } from "./projects/projects";
import { openWorkspaceSearch } from "./search/search";
import { publicState } from "./sharing/public";

/** Wire engine host capabilities at the composition boundary, not in shared application state. */
export function initializeEditorHost(): void {
  const extractor = createOutlineExtractor();
  appState.outlineExtractor = extractor;
  onApplicationDispose(() => extractor.clear());
  appState.inlineEditor = ownApplicationResource(
    createInlineEditor({
      root: appState.element("rich-editor"),
      outlineExtractor: extractor,
      styleNonce: requiredQuery(document, 'meta[name="folio-style-nonce"]', HTMLMetaElement).content,
      transformUrl: (url, path) => projectUrl(url, path),
      onTag: (tag) => openWorkspaceSearch({ tags: [tag] }),
      onImageUpload: (image) => uploadReplacementImage(image),
      canCreateLink: (path) => canCreateLinkedNote(path),
      onCreateLink: (path) => openLinkedNote(path),
      onNotice: (message, kind = "warning", source) =>
        notice(
          appState.element(
            source === "image" ? "image-message" : source === "table" ? "table-message" : "metadata-message",
          ),
          message,
          kind,
        ),
      trackSelection: () => Boolean(documentSession.current),
      trackOutline: () => shell.view === "rich" && Boolean(documentSession.current),
      wikiDocuments: () => (publicState.publicView ? [] : visibleLibraryFiles()),
      onOutline(items: Heading[]): void {
        if (!documentSession.current || shell.view !== "rich") return;
        appState.outlineSource = appState.ui.editor.value;
        renderOutline(items);
      },
      onHeadingSelection: setCurrentOutline,
      onTitle(title: string | null): void {
        if (!documentSession.current || shell.view !== "rich") return;
        documentSession.setTitle(title);
        refreshDocumentTitle();
      },
      onChange(text: string): void {
        if (!documentSession.current || shell.view !== "rich") return;
        appState.ui.editor.value = text;
        appState.ui.editor.dispatchEvent(new Event("input"));
      },
      onFallback(message: string): void {
        notice(appState.element("rich-warning"), message, "warning");
        setView("editor");
      },
      onReady(): void {
        if (shell.view !== "rich") return;
        if (restoreViewPosition()) {
          appState.focusAfterLoad = false;
          return;
        }
        if (appState.pendingHeading !== null) {
          appState.inlineEditor.jumpTo(appState.pendingHeading);
          appState.pendingHeading = null;
        } else if (appState.focusAfterLoad) {
          appState.inlineEditor.focus();
        } else {
          scrollToHeading(readNoteRoute(appState.committedUrl).hash);
        }
        appState.focusAfterLoad = false;
      },
      onLink(href: string): void {
        if (!documentSession.current) return;
        if (href.startsWith("#")) {
          commitUrl(makeNoteUrl(appState.committedUrl, documentSession.current.id, href));
          scrollToHeading(href);
          return;
        }
        const url = new URL(href, window.location.href);
        if (internalNoteUrl(url)) {
          const route = readNoteRoute(url);
          void navigateTo(route.id ?? (publicState.publicView ? documentSession.current.id : null), route.hash, {
            url,
          });
        } else {
          window.open(url.href, "_blank", "noopener,noreferrer");
        }
      },
    }),
  );
}
