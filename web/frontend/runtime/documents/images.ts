import { projectModel } from "../../state/projects";
import { documentSession } from "../../state/document";
import { decodedImage } from "../../api/contracts";
import { imageHtml } from "@folio/editor-runtime";
import { shell } from "../../state/shell";
import type { ImageOperation } from "../../types/domain";
import { requireValue } from "../../types/elements";
import { errorContext } from "../../types/errors";
import { collaborationLocked, collaborationState } from "../collaboration/collaboration";
import { collaborativeSelection } from "../collaboration/presence";
import { api } from "../core/api";
import { appState } from "../core/bootstrap";
import { documentNotice } from "../core/dom";
import { listen } from "../lifecycle";

import { projectWritable } from "../projects/permissions";
class ImageState {
  imageUploading!: boolean;
}
export const imageState = new ImageState();
export function initializeDocumentsImages(): void {
  imageState.imageUploading = false;
  listen(
    document,
    "paste",
    (event) => {
      if (!(event.target instanceof Element)) return;
      if (
        !documentSession.current ||
        !collaborationState.collaborativeTarget(event.target) ||
        event.target.closest<HTMLElement>(".folio-metadata-source")
      )
        return;
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
    if (appState.element("rich-editor").dataset.imageDragging === "true") return;
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
      if (appState.element("rich-editor").dataset.imageDragging === "true") return;
      if (!event.dataTransfer?.files.length || !event.target.closest<HTMLElement>(".editor-pane, .rich-pane")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!documentSession.current || !projectWritable() || event.target.closest<HTMLElement>(".folio-metadata")) {
        documentNotice("Drop images into an editable document body.", "warning");
        return;
      }
      const images = [...event.dataTransfer.files];
      if (images.some((file) => !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.type))) {
        documentNotice("Drop PNG, JPEG, GIF, or WebP images.", "warning");
        return;
      }
      if (shell.view === "rich") {
        if (!appState.inlineEditor.selectAtPoint(event.clientX, event.clientY))
          appState.inlineEditor.select(appState.ui.editor.value.length);
      } else appState.ui.editor.selectAtPoint(event.clientX, event.clientY);
      void insertImages(images, { block: true });
    },
    true,
  );
}
export function imageMarkdownPath(path: string, documentPath: string) {
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
export async function uploadImageFile(image: File, operation: ImageOperation) {
  if (!image || image.size > 16 * 1024 * 1024) throw new Error("Images must not exceed 16 MiB.");
  if (operation.id !== documentSession.id || operation.project !== projectModel.active?.id || !projectWritable()) {
    throw new Error("The open page or its permissions changed before uploading.");
  }
  const result = await api(`/api/images?document=${encodeURIComponent(operation.resource)}`, {
    decode: decodedImage,
    method: "POST",
    body: image,
  });
  if (
    typeof result?.path !== "string" ||
    result.document !== operation.resource ||
    typeof result.documentPath !== "string"
  ) {
    throw new Error("The server returned an invalid image or document identity.");
  }
  const url = imageMarkdownPath(result.path, result.documentPath);
  if (result.documentPath !== operation.path) {
    throw new Error(`The document moved while uploading. The new image is kept at ${url}.`);
  }
  if (operation.id !== documentSession.id || operation.project !== projectModel.active?.id || !projectWritable()) {
    throw new Error(`The page or its permissions changed while uploading. The new image is kept at ${url}.`);
  }
  return { url, warning: result.warning };
}
export async function uploadReplacementImage(image: File) {
  if (!documentSession.current || !projectWritable() || collaborationLocked())
    throw new Error("This page is not editable.");
  if (imageState.imageUploading) throw new Error("Wait for the current image upload to finish.");
  imageState.imageUploading = true;
  try {
    const result = await uploadImageFile(image, {
      id: documentSession.id,
      resource: documentSession.current.id,
      project: projectModel.active?.id,
      path: documentSession.current.path,
    });
    if (result.warning) documentNotice(result.warning, "warning");
    return result.url;
  } finally {
    imageState.imageUploading = false;
  }
}
export async function insertImages(
  images: File[],
  {
    block = false,
  }: {
    block?: boolean;
  } = {},
): Promise<void> {
  if (!projectWritable() || collaborationLocked()) {
    documentNotice("This page is not editable.", "warning");
    return;
  }
  if (imageState.imageUploading) {
    documentNotice("Wait for the current image upload to finish.");
    return;
  }
  const operation = {
    id: documentSession.id,
    resource: requireValue(documentSession.current).id,
    revision: documentSession.revision,
    project: projectModel.active?.id,
    path: requireValue(documentSession.current).path,
  };
  const selection = collaborativeSelection();
  if (!selection) {
    documentNotice("Place the cursor in the document before pasting an image.", "warning");
    return;
  }
  const current = collaborationState.collaboration;
  const relative = current?.shared.relative(selection);
  const blockInsertion = block && shell.view === "rich";
  const insertImage_fn =
    shell.view === "rich" ? appState.inlineEditor.captureImageInsertion({ block: blockInsertion }) : null;
  imageState.imageUploading = true;
  documentNotice("Saving image…");
  const links = [];
  const warnings = new Set();
  try {
    for (const image of images) {
      const result = await uploadImageFile(image, operation);
      links.push(
        blockInsertion ? imageHtml({ src: result.url, alt: "Image", layout: "left" }) : `![Image](${result.url})`,
      );
      if (result.warning) warnings.add(result.warning);
    }
    if (operation.id !== documentSession.id || operation.project !== projectModel.active?.id || !projectWritable()) {
      throw new Error(
        `Images were saved, but the open page or its permissions changed. Insert them manually: ${links.join(" ")}`,
      );
    }
    if (!current && operation.revision !== documentSession.revision) {
      throw new Error(
        `Images were saved while you edited. Paste these references at the desired position: ${links.join(" ")}`,
      );
    }
    const range =
      relative && current === collaborationState.collaboration
        ? requireValue(current).shared.resolve(relative)
        : selection;
    if (!range) throw new Error(`The original insertion position is unavailable. Insert manually: ${links.join(" ")}`);
    const from = Math.min(range.from, range.to);
    const to = Math.max(range.from, range.to);
    const insertion = links.join(blockInsertion ? "\n\n" : "\n");
    if (!(shell.view === "rich" && insertImage_fn?.(insertion))) {
      const sourceInsertion = blockInsertion ? `\n\n${insertion}\n\n` : insertion;
      appState.ui.editor.value =
        appState.ui.editor.value.slice(0, from) + sourceInsertion + appState.ui.editor.value.slice(to);
      appState.ui.editor.dispatchEvent(new Event("input"));
      if (shell.view === "rich") {
        if (!(await appState.inlineEditor.replaceSource(appState.ui.editor.value)))
          await appState.inlineEditor.load(appState.ui.editor.value, operation.path);
        appState.inlineEditor.select(from + sourceInsertion.length);
      } else {
        appState.ui.editor.setSelectionRange(from + sourceInsertion.length, from + sourceInsertion.length);
        appState.ui.editor.focus();
      }
    }
    documentNotice([...warnings].join(" "), warnings.size ? "warning" : "");
  } catch (errorCause) {
    const error = errorContext(errorCause);
    documentNotice(
      `Could not insert image: ${error.message}${links.length ? ` Already saved; insert these references manually: ${links.join(" ")}` : ""}`,
      "error",
    );
  } finally {
    imageState.imageUploading = false;
  }
}
