import { projectModel } from "../../state/projects";
import { authenticationSession } from "../../state/authentication";
import { documentSession } from "../../state/document";
import { decodedImage } from "../../api/contracts";
import { shell } from "../../state/shell";
import type { ImageOperation } from "../../types/domain";
import { element, requireValue } from "../../types/elements";
import { errorContext } from "../../types/errors";
import { collaborationLocked, collaborativeTarget, collaboration } from "../collaboration/collaboration";
import { api } from "../core/api";
import { appState } from "../core/bootstrap";
import { documentNotice } from "../core/dom";
import { applicationSignal, listen, onApplicationDispose } from "../lifecycle";
import { awaitCreatedResource, waitForConnection } from "../navigation/creation";

import { projectWritable } from "../projects/permissions";
export let imageUploading: boolean;

type Pending = {
  controller: AbortController;
  canCancel: (undo: boolean) => boolean;
  rich: boolean;
};
const pending = new Set<Pending>();
export const hasPendingImages = () => pending.size > 0 || imageUploading;
export const editorComposing = () => composition !== null;
const imageTypes = ["image/png", "image/jpeg", "image/gif", "image/webp"];
let composition: { target: Element; done: Promise<void>; end: () => void } | null = null;
export function initializeDocumentsImages(): void {
  imageUploading = false;
  const endComposition = () => {
    composition?.end();
    composition = null;
  };
  listen(
    window,
    "compositionstart",
    (event) => {
      if (!(event.target instanceof Element) || !collaborativeTarget(event.target)) return;
      endComposition();
      let end = () => {};
      const done = new Promise<void>((resolve) => {
        end = resolve;
      });
      composition = { target: event.target, done, end };
    },
    true,
  );
  const finishComposition = (event: Event) => {
    const owner = composition;
    if (owner && owner.target === event.target)
      setTimeout(() => {
        if (composition === owner) endComposition();
      }, 0);
  };
  listen(window, "compositionend", finishComposition, true);
  listen(window, "blur", finishComposition, true);
  const cancelPending = (event: Event, undo: boolean) => {
    if (!pending.size || composition || !collaborativeTarget(event.target)) return;
    for (const job of [...pending].reverse()) {
      if (job.rich !== (shell.view === "rich") || !job.canCancel(undo)) continue;
      event.preventDefault();
      event.stopImmediatePropagation();
      job.controller.abort();
      documentNotice("Image insertion canceled");
      return;
    }
  };
  // Before the editor's own history (including the collaboration key handler).
  listen(
    window,
    "keydown",
    (event) => {
      if (event.isComposing || event.shiftKey || event.altKey) return;
      const primary = event.ctrlKey || event.metaKey;
      if (primary && event.key.toLowerCase() === "z") cancelPending(event, true);
      if (!primary && ["Backspace", "Delete"].includes(event.key)) cancelPending(event, false);
    },
    true,
  );
  listen(
    window,
    "beforeinput",
    (event) => {
      if (!(event instanceof InputEvent) || !event.cancelable || event.isComposing) return;
      if (event.inputType === "historyUndo") cancelPending(event, true);
      else if (["deleteContentBackward", "deleteContentForward"].includes(event.inputType)) cancelPending(event, false);
    },
    true,
  );
  onApplicationDispose(endComposition);
  listen(
    document,
    "paste",
    (event) => {
      if (!(event.target instanceof Element)) return;
      if (!documentSession.current || !collaborativeTarget(event.target)) return;
      const images = [...(event.clipboardData?.items ?? [])].filter(
        (item) => item.kind === "file" && item.type.startsWith("image/"),
      );
      if (!images.length) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void insertImages(images.map((item) => item.getAsFile()).filter((file): file is File => file !== null));
    },
    true,
  );
  listen(document, "dragover", (event) => {
    if (!(event.target instanceof Element)) return;
    if (element("rich-editor").dataset.imageDragging === "true") return;
    if (!event.dataTransfer?.types.includes("Files") || !event.target.closest<HTMLElement>(".editor-pane, .rich-pane"))
      return;
    event.preventDefault();
    event.dataTransfer.dropEffect = documentSession.current && projectWritable() ? "copy" : "none";
  });
  listen(
    document,
    "drop",
    (event) => {
      if (!(event.target instanceof Element)) return;
      if (element("rich-editor").dataset.imageDragging === "true") return;
      if (!event.dataTransfer?.files.length || !event.target.closest<HTMLElement>(".editor-pane, .rich-pane")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!documentSession.current || !projectWritable() || event.target.closest<HTMLElement>(".folio-metadata")) {
        documentNotice("Document not editable", "warning");
        return;
      }
      const images = [...event.dataTransfer.files];
      if (images.some((file) => !imageTypes.includes(file.type))) {
        documentNotice("PNG, JPEG, GIF, or WebP only", "warning");
        return;
      }
      if (shell.view === "rich") {
        if (!appState.inlineEditor.selectAtPoint(event.clientX, event.clientY))
          appState.inlineEditor.select(appState.editor.value.length);
      } else appState.editor.selectAtPoint(event.clientX, event.clientY);
      void insertImages(images, { block: true });
    },
    true,
  );
}
function imageMarkdownPath(path: string, documentPath: string) {
  const parent = documentPath.split("/").slice(0, -1);
  const target = path.split("/");
  while (parent.length && target.length && parent[0] === target[0]) {
    parent.shift();
    target.shift();
  }
  return [...parent.map(() => ".."), ...target]
    .map((part) => encodeURIComponent(part).replace(/[()]/g, (character) => `%${character.charCodeAt(0).toString(16)}`))
    .join("/");
}
function ownsPage(operation: ImageOperation) {
  return operation.id === documentSession.id && operation.project === projectModel.active?.id;
}
async function uploadImageFile(image: File, operation: ImageOperation, signal?: AbortSignal) {
  if (!image || image.size > 16 * 1024 * 1024) throw new Error("Image over 16 MiB");
  if (!ownsPage(operation) || !projectWritable()) {
    throw new Error("Page changed before upload");
  }
  // The same multi-file paste can straddle the provisional ID's acknowledgement.
  const resource = await awaitCreatedResource(requireValue(documentSession.current).id);
  await waitForConnection(signal ?? authenticationSession.scope.signal);
  signal?.throwIfAborted();
  if (!ownsPage(operation) || resource !== documentSession.current?.id || !projectWritable())
    throw new Error("Page changed before upload");
  const result = await api(`/api/images?document=${encodeURIComponent(resource)}`, {
    decode: decodedImage,
    method: "POST",
    body: image,
    signal,
  });
  if (typeof result?.path !== "string" || result.document !== resource || typeof result.documentPath !== "string") {
    throw new Error("Invalid upload response");
  }
  const url = imageMarkdownPath(result.path, result.documentPath);
  if (!ownsPage(operation) || resource !== documentSession.current?.id || !projectWritable())
    throw new Error("Page changed during upload");
  if (
    result.documentPath !==
    (operation.resource.startsWith("local-new:") ? documentSession.current.path : operation.path)
  ) {
    throw new Error(`Document moved; image at ${url}`);
  }
  return { url, warning: result.warning };
}
export async function uploadReplacementImage(image: File) {
  if (!documentSession.current || !projectWritable() || collaborationLocked()) throw new Error("Read-only");
  if (imageUploading) throw new Error("Upload in progress");
  imageUploading = true;
  try {
    const result = await uploadImageFile(
      image,
      {
        id: documentSession.id,
        resource: documentSession.current.id,
        project: projectModel.active?.id,
        path: documentSession.current.path,
      },
      authenticationSession.scope.signal,
    );
    if (result.warning) documentNotice(result.warning, "warning");
    return result.url;
  } finally {
    imageUploading = false;
  }
}
async function insertImages(
  images: File[],
  {
    block = false,
  }: {
    block?: boolean;
  } = {},
): Promise<void> {
  if (!documentSession.current || !images.length) return;
  if (!projectWritable() || collaborationLocked() || collaboration?.writable === false) {
    documentNotice("Read-only", "warning");
    return;
  }
  if (images.some((file) => !imageTypes.includes(file.type) || file.size > 16 * 1024 * 1024)) {
    documentNotice("PNG, JPEG, GIF, or WebP up to 16 MiB only", "warning");
    return;
  }
  const operation = {
    id: documentSession.id,
    resource: requireValue(documentSession.current).id,
    project: projectModel.active?.id,
    path: requireValue(documentSession.current).path,
  };
  const rich = shell.view === "rich";
  const scope = authenticationSession.scope;
  const controller = new AbortController();
  const signal = AbortSignal.any([scope.signal, applicationSignal(), controller.signal]);
  if (signal.aborted) return;
  const bookmark = rich
    ? appState.inlineEditor.captureImageInsertion(images, block)
    : appState.editor.captureImageInsertion();
  if (!bookmark) return documentNotice("No cursor in document", "warning");
  const job = { controller, canCancel: bookmark.canCancel, rich };
  pending.add(job);
  const unwatch = collaboration?.shared.watchRemoteImageEdits(bookmark.beforeRemote);
  let releaseWait = () => {};
  const canceled = new Promise<void>((resolve) => {
    releaseWait = resolve;
  });
  const cleanup = () => {
    if (!pending.delete(job)) return;
    releaseWait();
    unwatch?.();
    bookmark.cancel();
  };
  signal.addEventListener("abort", cleanup, { once: true });
  const unsubscribe = documentSession.subscribe(() => {
    if (!ownsPage(operation)) controller.abort();
  });
  if (!rich) documentNotice("Saving image…");
  try {
    const results = [];
    for (const image of images) results.push(await uploadImageFile(image, operation, signal));
    while (composition && !signal.aborted) await Promise.race([composition.done, canceled]);
    if (signal.aborted || !ownsPage(operation)) return;
    const shared = collaboration;
    if (!projectWritable() || collaborationLocked() || shared?.writable === false || shared?.closed)
      throw new Error("Read-only");
    if (documentSession.loading || rich !== (shell.view === "rich") || shell.view === "preview")
      throw new Error("Editor changed");
    shared?.shared.isolateHistory();
    try {
      if (!bookmark.insert(results.map((result) => result.url))) throw new Error("Insert position lost");
    } finally {
      shared?.shared.isolateHistory();
    }
    const warning = [...new Set(results.map((result) => result.warning).filter(Boolean))].join(" ");
    if (warning || !rich) documentNotice(warning, warning ? "warning" : "");
  } catch (errorCause) {
    const error = errorContext(errorCause);
    if (!signal.aborted && ownsPage(operation)) documentNotice(`Image insert failed: ${error.message}`, "error");
  } finally {
    unsubscribe();
    signal.removeEventListener("abort", cleanup);
    controller.abort();
    cleanup();
  }
}
