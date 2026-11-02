import { EditorState, NodeSelection } from "@milkdown/prose/state";
import { imageAttributes } from "./image-syntax.ts";
import { createNodeToolbar, toolButton } from "./node-toolbar.ts";
import { createNodeInspector } from "./node-inspector.ts";
import { isImageNode, type ImageNodeAttrs } from "./image-model.ts";
import { EditorView } from "@milkdown/prose/view";
import { createImageNodeView, type ImageToolHandle, type ImageViewOptions } from "./image-node-view.ts";
import type { ImageLayout } from "./types/markdown.ts";
import type { InlineEditorOptions } from "./types/editor.ts";
import { closestElement } from "./dom.ts";
import { errorMessage } from "./errors.ts";
import type { Lifetime } from "../../shared/lifetime.ts";
export { imagePlugins } from "./image-model.ts";
function createImagePreview(lifetime: Lifetime) {
  const dialog = document.createElement("dialog");
  dialog.className = "folio-image-preview";
  dialog.setAttribute("aria-label", "Image preview");
  const image = document.createElement("img");
  const close = toolButton({ label: "Close image preview", icon: "x", onClick: () => dialog.close() });
  let target: ImageToolHandle | null = null;
  dialog.append(close, image);
  lifetime.listen(dialog, "click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  lifetime.listen(dialog, "close", () => {
    if (target?.active_fn()) target.focus_fn();
    target = null;
    image.removeAttribute("src");
  });
  document.body.append(dialog);
  lifetime.defer(() => {
    target = null;
    if (dialog.open) dialog.close();
    image.removeAttribute("src");
    dialog.remove();
  });
  return {
    open(next: ImageToolHandle) {
      const source = next.image_fn();
      if (!source?.getAttribute("src")) throw new Error("This image is not available for preview.");
      target = next;
      image.src = source.src;
      image.alt = source.alt;
      if (!dialog.open) dialog.showModal();
      close.focus({ preventScroll: true });
    },
    close() {
      if (dialog.open) dialog.close();
    },
  };
}
export function createImageTools({
  lifetime,
  root,
  onNotice,
  upload_fn,
}: {
  lifetime: Lifetime;
  root: HTMLElement;
  onNotice?: InlineEditorOptions["onNotice"];
  upload_fn?: InlineEditorOptions["onImageUpload"];
}) {
  const preview = createImagePreview(lifetime);
  const toolbar = document.createElement("div");
  toolbar.className = "folio-image-tools";
  toolbar.setAttribute("aria-label", "Image tools");
  const actions = document.createElement("div");
  actions.className = "folio-image-menu";
  actions.hidden = true;
  actions.id = "folio-image-menu";
  actions.dataset.nodePanel = "";
  actions.setAttribute("role", "menu");
  actions.setAttribute("aria-label", "Image actions");
  const form = document.createElement("form");
  form.className = "folio-image-options";
  form.hidden = true;
  form.id = "folio-image-options";
  form.dataset.noticeAvoid = "";
  const heading = document.createElement("div");
  heading.className = "folio-image-panel-header";
  const title = document.createElement("strong");
  title.textContent = "Image";
  heading.append(
    title,
    toolButton({
      label: "Close image options",
      icon: "x",
      onClick: () => {
        setPanelOpen(false);
        hover.target()?.focus_fn();
      },
    }),
  );
  const layouts = document.createElement("div");
  layouts.className = "folio-image-layouts";
  layouts.setAttribute("role", "group");
  layouts.setAttribute("aria-label", "Image layout shortcuts");
  const layoutButtons = new Map<ImageLayout, HTMLButtonElement>();
  for (const value of ["inline", "left", "center", "right"] as const) {
    const button = toolButton({
      label: `Image layout ${value}`,
      text: value[0].toUpperCase() + value.slice(1),
      onClick: () => void run(() => requireTarget().update_fn({ layout: value })),
    });
    layoutButtons.set(value, button);
    layouts.append(button);
  }
  const precision = document.createElement("details");
  precision.className = "folio-image-precision";
  const precisionToggle = document.createElement("summary");
  precisionToggle.textContent = "Custom size";
  const custom = document.createElement("div");
  custom.className = "folio-image-custom";
  precision.append(precisionToggle, custom);
  const fields = { width: document.createElement("input"), height: document.createElement("input") };
  for (const name of ["width", "height"] as const) {
    const label = document.createElement("label");
    label.textContent = name === "width" ? "Width" : "Height";
    const input = fields[name];
    input.type = "text";
    input.placeholder = "Auto";
    input.setAttribute("aria-label", `Image ${name}`);
    label.append(input);
    custom.append(label);
  }
  const layoutLabel = document.createElement("label");
  layoutLabel.textContent = "Layout";
  const layout = document.createElement("select");
  layout.setAttribute("aria-label", "Image layout");
  for (const name of ["inline", "left", "center", "right"]) {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name[0].toUpperCase() + name.slice(1);
    layout.append(option);
  }
  layoutLabel.append(layout);
  custom.append(layoutLabel);
  const presets = document.createElement("div");
  presets.className = "folio-image-presets";
  for (const value of ["25%", "50%", "75%", "100%"]) {
    presets.append(
      toolButton({
        label: `Image width ${value}`,
        text: value,
        onClick: () =>
          void run(() => {
            fields.width.value = value;
            fields.height.value = "";
            requireTarget().update_fn({ width: value, height: null });
          }),
      }),
    );
  }
  const sideBySide = toolButton({
    label: "Arrange images side by side",
    text: "Side by side",
    onClick: () => void run(() => requireTarget().row_fn()),
  });
  sideBySide.className = "folio-image-side-by-side";
  form.append(heading, layouts, sideBySide, presets, precision);
  const apply = document.createElement("button");
  apply.type = "submit";
  apply.textContent = "Apply";
  const reset = toolButton({
    label: "Reset image size and layout",
    text: "Reset",
    onClick: () => {
      run(() => {
        requireTarget().reset_fn();
        hover.refresh();
      });
    },
  });
  const customActions = document.createElement("div");
  customActions.className = "folio-image-custom-actions";
  customActions.append(reset, apply);
  custom.append(customActions);
  let shown: ImageToolHandle | null = null;
  let shownAttributes: ImageNodeAttrs | null = null;
  let replacement: ReturnType<ImageToolHandle["captureReplacement_fn"]> | null = null;
  let replacing = false;
  let context = 0;
  let dragTimer: number | undefined;
  const endDrag = () => {
    delete root.dataset.imageDragging;
    for (const image of root.querySelectorAll(".folio-inline-image.is-dragging")) image.classList.remove("is-dragging");
  };
  lifetime.listen(
    root,
    "drop",
    () => {
      window.clearTimeout(dragTimer);
      dragTimer = window.setTimeout(endDrag, 0);
    },
    true,
  );
  lifetime.defer(() => {
    window.clearTimeout(dragTimer);
    endDrag();
  });
  lifetime.listen(root, "focusin", (event) => {
    if (closestElement(event.target, ".folio-metadata")) hover.close();
  });
  lifetime.listen(window, "dragend", endDrag);
  const inspector = createNodeInspector({
    lifetime,
    root,
    panel: form,
    onResize_fn: () => hover.position(),
    onOpen_fn: () => hover.target()?.anchor_fn().scrollIntoView({ block: "nearest", inline: "nearest" }),
  });
  lifetime.listen(precision, "toggle", () => inspector.refresh());
  const mutating: (HTMLInputElement | HTMLSelectElement | HTMLButtonElement)[] = [
    layout,
    fields.width,
    fields.height,
    reset,
    apply,
    sideBySide,
    ...presets.querySelectorAll("button"),
    ...layouts.querySelectorAll("button"),
  ];
  const hover = createNodeToolbar<ImageToolHandle>({
    lifetime,
    root,
    toolbar,
    onHide() {
      shown = null;
      shownAttributes = null;
      setPanelOpen(false);
      menuButton.setAttribute("aria-expanded", "false");
      layoutButton.setAttribute("aria-expanded", "false");
    },
    onShow(target) {
      const changed = shown !== target;
      shown = target;
      if (changed) {
        setPanelOpen(false);
        precision.open = false;
        actions.hidden = true;
      }
      const attrs = target.attributes_fn();
      const resetFields = changed || form.hidden || !precision.open;
      for (const name of ["width", "height"] as const) {
        if (resetFields || attrs[name] !== shownAttributes?.[name]) fields[name].value = attrs[name] ?? "";
      }
      if (resetFields || attrs.layout !== shownAttributes?.layout) layout.value = attrs.layout;
      shownAttributes = { ...attrs };
      for (const [value, button] of layoutButtons) button.setAttribute("aria-pressed", String(value === attrs.layout));
      for (const button of presets.children)
        button.setAttribute("aria-pressed", String(button.textContent === attrs.width));
      for (const control of mutating) control.disabled = replacing || !target.editable_fn();
      sideBySide.disabled ||= !target.rowAvailable_fn();
      layoutButton.setAttribute("aria-expanded", String(!form.hidden));
      menuButton.setAttribute("aria-expanded", String(!actions.hidden));
    },
    placement: "inside-top-end",
  });
  function setPanelOpen(value: boolean) {
    inspector.setOpen(value);
    layoutButton.setAttribute("aria-expanded", String(!form.hidden));
  }
  function requireTarget() {
    const target = hover.target();
    if (!target) throw new Error("This image is no longer open.");
    return target;
  }
  async function run(action_fn: () => unknown | Promise<unknown>) {
    try {
      await action_fn();
      onNotice?.("");
    } catch (error) {
      onNotice?.(`Could not update image: ${errorMessage(error)}`, "error");
    }
  }
  const save = toolButton({
    label: "Save image as",
    icon: "download",
    onClick: () =>
      run(() => {
        const target = requireTarget();
        const image = target.image_fn();
        if (!image?.getAttribute("src")) throw new Error("Only available local images can be downloaded.");
        const link = document.createElement("a");
        link.href = image.src;
        link.download = target.attributes_fn().src.split(/[/?#]/).filter(Boolean).at(-1) || "image";
        document.body.append(link);
        link.click();
        link.remove();
      }),
  });
  const file = document.createElement("input");
  file.type = "file";
  file.accept = "image/png,image/jpeg,image/gif,image/webp";
  file.hidden = true;
  const replace = toolButton({
    label: "Replace image",
    icon: "refresh",
    text: "Replace image",
    onClick: () => {
      void run(() => {
        const target = requireTarget();
        replacement = target.captureReplacement_fn();
        file.value = "";
        file.click();
      });
    },
  });
  replace.hidden = typeof upload_fn !== "function";
  mutating.push(replace);
  lifetime.listen(
    file,
    "change",
    () =>
      void run(async () => {
        if (!file.files?.length) return;
        const image = file.files[0];
        const captured = replacement;
        replacement = null;
        try {
          if (!captured?.valid_fn()) throw new Error("The image changed before the replacement was selected.");
          if (!upload_fn) throw new Error("Image uploads are unavailable.");
          replacing = true;
          toolbar.setAttribute("aria-busy", "true");
          hover.refresh();
          const url = await upload_fn(image);
          if (!captured.replace_fn(url))
            throw new Error(`The image changed while uploading. The new file is kept at ${url}.`);
        } finally {
          replacing = false;
          file.value = "";
          toolbar.removeAttribute("aria-busy");
          hover.refresh();
        }
      }),
  );
  lifetime.listen(file, "cancel", () => {
    replacement = null;
  });
  const layoutButton = toolButton({
    label: "Image size and layout",
    icon: "expand-width",
    onClick: () => {
      requireTarget().select_fn();
      actions.hidden = true;
      setPanelOpen(Boolean(form.hidden));
      hover.position();
      if (!form.hidden)
        layouts.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus({ preventScroll: true });
    },
  });
  layoutButton.setAttribute("aria-controls", form.id);
  layoutButton.setAttribute("aria-expanded", "false");
  mutating.push(layoutButton);
  const copy = toolButton({
    label: "Copy image Markdown",
    icon: "copy",
    text: "Copy reference",
    onClick: () => run(() => navigator.clipboard.writeText(requireTarget().markdown_fn())),
  });
  const remove = toolButton({
    label: "Remove image",
    icon: "x",
    text: "Remove image",
    onClick: () =>
      run(() => {
        requireTarget().remove_fn();
        hover.close();
      }),
  });
  remove.dataset.imageDestructive = "";
  mutating.push(remove);
  const menuButton = toolButton({
    label: "Image actions",
    icon: "more-horizontal",
    onClick: () =>
      run(() => {
        const target = requireTarget();
        target.select_fn();
        const open = actions.hidden;
        setPanelOpen(false);
        actions.hidden = !open;
        layoutButton.setAttribute("aria-expanded", "false");
        menuButton.setAttribute("aria-expanded", String(open));
        hover.position();
      }),
  });
  menuButton.setAttribute("aria-haspopup", "menu");
  menuButton.setAttribute("aria-controls", actions.id);
  menuButton.setAttribute("aria-expanded", "false");
  for (const button of [replace, copy, remove]) button.setAttribute("role", "menuitem");
  actions.append(replace, copy, remove, file);
  const zoom = toolButton({
    label: "Preview image",
    icon: "zoom-in",
    onClick: () => run(() => preview.open(requireTarget())),
  });
  const quick = document.createElement("div");
  quick.className = "folio-image-quick";
  quick.append(layoutButton, zoom, save, menuButton);
  toolbar.append(quick, actions, form);
  lifetime.listen(toolbar, "keydown", (event) => {
    if (actions.hidden) return;
    const options = [...actions.querySelectorAll<HTMLButtonElement>("button:not([hidden]):not(:disabled)")];
    if (["ArrowDown", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      const index = options.findIndex((button) => button === document.activeElement);
      const next =
        index < 0
          ? event.key === "ArrowDown"
            ? 0
            : options.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
      options[next]?.focus();
    }
  });
  lifetime.listen(form, "submit", (event) => {
    event.preventDefault();
    void run(() => {
      requireTarget().update_fn(
        imageAttributes({
          width: fields.width.value,
          height: fields.height.value,
          layout: layout.value,
        }),
      );
      precision.open = false;
      hover.refresh();
      inspector.refresh();
    });
  });
  return {
    close() {
      context++;
      endDrag();
      replacement = null;
      if (!replacing) file.value = "";
      preview.close();
      hover.close();
      onNotice?.("");
    },
    refresh: hover.refresh,
    updateSelection(view: EditorView, previous: EditorState) {
      if (toolbar.contains(document.activeElement)) return;
      const selection = view.state.selection;
      const changed = !selection.eq(previous.selection);
      if (selection instanceof NodeSelection && isImageNode(selection.node)) {
        if (changed) {
          const anchor = view.nodeDOM(selection.from);
          if (anchor instanceof HTMLElement) hover.open(anchor);
        } else if (!view.state.doc.eq(previous.doc)) hover.refresh();
      } else if (changed || !view.state.doc.eq(previous.doc)) hover.close();
    },
    nodeView(options: ImageViewOptions) {
      return createImageNodeView(options, {
        root,
        hover,
        context_fn: () => context,
        run_fn: run,
        panel_fn: () => ({ open: !form.hidden, custom: precision.open }),
        restorePanel_fn(panel) {
          precision.open = panel.custom;
          setPanelOpen(panel.open);
          hover.refresh();
        },
      });
    },
  };
}
