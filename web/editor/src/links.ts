import { closeHistory } from "@milkdown/prose/history";
import { resolveMarkdownUrl } from "./editor-helpers.ts";
import { wikiDestination } from "./wiki-syntax.ts";
import { autoLinkDestination } from "./auto-links.ts";
import { NodeSelection, type EditorState } from "@milkdown/prose/state";
import type { Attrs, Mark, Node as ProseNode } from "@milkdown/prose/model";
import type { MarkView } from "@milkdown/prose/view";
import type { InlineEditorOptions, MarkdownUrl, ReadyEditorSession } from "./types/editor.ts";
import { isReadySession } from "./editor-session.ts";
import { closestElement, nodeElement } from "./dom.ts";
import { errorMessage } from "./errors.ts";
import type { Lifetime } from "../../shared/lifetime.ts";
interface LinkRange {
  from: number;
  to: number;
  href: string;
  label: string;
  wiki: boolean;
  attrs: Attrs;
}
interface LinkTarget {
  owner: ReadyEditorSession;
  link: LinkRange;
  path: string | null;
  url: string | null;
}
interface LinkToolsOptions {
  lifetime: Lifetime;
  root: HTMLElement;
  state_fn: () => import("./types/editor.ts").EditorSession | null;
  editable_fn: () => boolean;
  transformUrl: MarkdownUrl;
  onOpen_fn: InlineEditorOptions["onLink"];
  canCreate_fn?: InlineEditorOptions["canCreateLink"];
  onCreate_fn?: InlineEditorOptions["onCreateLink"];
  onBeforeEdit_fn?: () => void;
}
export function linkRangeAt(state: EditorState, position: number): LinkRange | null {
  const atom = state.doc.nodeAt(position);
  if (atom?.type.name === "wiki_link")
    return {
      from: position,
      to: position + atom.nodeSize,
      href: atom.attrs.target,
      label: atom.attrs.label || atom.attrs.target,
      wiki: true,
      attrs: atom.attrs,
    };
  const point = state.doc.resolve(position);
  if (!point.parent.isTextblock) return null;
  const parts: {
    node: ProseNode;
    from: number;
    to: number;
  }[] = [];
  point.parent.forEach((node, offset) =>
    parts.push({ node, from: point.start() + offset, to: point.start() + offset + node.nodeSize }),
  );
  const index = parts.findIndex(
    (part) => part.from <= position && part.to > position && part.node.marks.some((mark) => mark.type.name === "link"),
  );
  if (index < 0) return null;
  const mark = parts[index].node.marks.find((mark) => mark.type.name === "link");
  if (!mark) return null;
  let first = index;
  let last = index;
  while (first > 0 && mark.isInSet(parts[first - 1].node.marks)) first--;
  while (last + 1 < parts.length && mark.isInSet(parts[last + 1].node.marks)) last++;
  const from = parts[first].from;
  const to = parts[last].to;
  return { from, to, href: mark.attrs.href, label: state.doc.textBetween(from, to), wiki: false, attrs: mark.attrs };
}
export function linkMarkView(mark: Mark, path: string, transformUrl: MarkdownUrl): MarkView {
  const dom = document.createElement("a");
  const target = resolveMarkdownUrl(mark.attrs.href, path);
  if (target) dom.dataset.noteUrl = target;
  const href = target ? transformUrl(target, path) : null;
  if (href) dom.setAttribute("href", href);
  dom.rel = "noopener noreferrer";
  dom.title = href
    ? "Ctrl/Cmd+click to open; use Link actions to edit"
    : "Link unavailable. Use Link actions to inspect its target.";
  return {
    dom,
    contentDOM: dom,
    ignoreMutation: (mutation) =>
      mutation.type === "attributes" &&
      mutation.target === dom &&
      mutation.attributeName !== null &&
      ["href", "title", "data-note-url"].includes(mutation.attributeName),
  };
}
export function createLinkTools({
  lifetime,
  root,
  state_fn,
  editable_fn,
  transformUrl,
  onOpen_fn,
  canCreate_fn,
  onCreate_fn,
  onBeforeEdit_fn,
}: LinkToolsOptions) {
  const preview = document.createElement("div");
  preview.className = "folio-link-actions";
  preview.hidden = true;
  preview.setAttribute("role", "toolbar");
  preview.setAttribute("aria-label", "Link actions");
  const previewMessage = document.createElement("p");
  previewMessage.setAttribute("role", "alert");
  previewMessage.hidden = true;
  let previewAnchor: HTMLElement | null = null;
  let previewTimer: number | undefined;
  let dragging = false;
  let pinnedError = false;
  function hideActions() {
    window.clearTimeout(previewTimer);
    preview.hidden = true;
    previewAnchor = null;
    pinnedError = false;
  }
  function describe(anchor: HTMLElement | null): LinkTarget | null {
    const owner = state_fn();
    if (!isReadySession(owner) || !anchor?.isConnected || !root.contains(anchor)) return null;
    const link = linkRangeAt(owner.view.state, owner.view.posAtDOM(anchor, 0));
    if (!link) return null;
    const destination = link.wiki ? wikiDestination(link.href) : link.href;
    const path = destination ? resolveMarkdownUrl(destination, owner.path) : null;
    return { owner, link, path, url: path ? transformUrl(path, owner.path) : null };
  }
  const action = (
    label: string,
    text: string,
    fn: (info: LinkTarget, anchor: HTMLElement | null) => unknown | Promise<unknown>,
  ) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = text;
    button.setAttribute("aria-label", label);
    lifetime.listen(button, "pointerdown", (event) => event.preventDefault());
    lifetime.listen(button, "click", async () => {
      const current = previewAnchor;
      try {
        const info = describe(current);
        if (!info) {
          hideActions();
          return;
        }
        await fn(info, current);
      } catch (failure) {
        if (previewAnchor !== current) {
          console.warn("A previous link action failed.", failure);
          return;
        }
        previewMessage.textContent = errorMessage(failure);
        previewMessage.hidden = false;
        pinnedError = true;
        positionActions();
      }
    });
    preview.append(button);
    return button;
  };
  const previewOpen = action("Open link", "Open", (info) => {
    if (!info.url) throw new Error("This link is unavailable. Inspect its target before opening it.");
    hideActions();
    onOpen_fn(info.url);
  });
  const previewEdit = action("Edit link", "Edit", (_info, anchor) => edit(anchor));
  const previewCopy = action("Copy link", "Copy", async (info, anchor) => {
    await navigator.clipboard.writeText(info.url || info.link.href);
    if (previewAnchor === anchor && !preview.hidden) previewCopy.textContent = "Copied";
  });
  preview.append(previewMessage);
  document.body.append(preview);
  lifetime.defer(() => preview.remove());
  lifetime.defer(hideActions);
  function positionActions() {
    if (preview.hidden) return;
    if (!previewAnchor?.isConnected) {
      hideActions();
      return;
    }
    const bounds = previewAnchor.getBoundingClientRect();
    const viewport = (root.querySelector("[data-editor-scroller]") ?? root).getBoundingClientRect();
    if (bounds.bottom <= viewport.top || bounds.top >= viewport.bottom) {
      hideActions();
      return;
    }
    const width = preview.offsetWidth;
    const height = preview.offsetHeight;
    preview.style.left = `${Math.max(8, Math.min(bounds.left, innerWidth - width - 8))}px`;
    const above = bounds.top - height - 6;
    preview.style.top = `${above >= viewport.top ? above : Math.min(bounds.bottom + 6, innerHeight - height - 8)}px`;
  }
  function showActions(anchor: HTMLElement | null) {
    window.clearTimeout(previewTimer);
    const info = describe(anchor);
    if (dragging || dialog.open || !info) {
      hideActions();
      return false;
    }
    const selection = document.getSelection();
    const selectedWiki =
      info.link.wiki &&
      info.owner.view.state.selection.from === info.link.from &&
      info.owner.view.state.selection instanceof NodeSelection &&
      info.owner.view.state.selection.node.type.name === "wiki_link";
    if (selection && !selection.isCollapsed && root.contains(selection.anchorNode) && !selectedWiki) {
      hideActions();
      return false;
    }
    if (previewAnchor !== anchor) {
      pinnedError = false;
      previewMessage.hidden = true;
      previewCopy.textContent = "Copy";
    }
    previewAnchor = anchor;
    previewOpen.disabled = !info.url;
    previewEdit.textContent = editable_fn() ? "Edit" : "Details";
    previewEdit.setAttribute("aria-label", editable_fn() ? "Edit link" : "Link details");
    preview.hidden = false;
    positionActions();
    return true;
  }
  function leaveActions() {
    window.clearTimeout(previewTimer);
    previewTimer = window.setTimeout(() => {
      if (
        !pinnedError &&
        !preview.matches(":hover") &&
        !previewAnchor?.matches(":hover") &&
        !preview.contains(document.activeElement)
      )
        hideActions();
    }, 140);
  }
  lifetime.listen(root, "pointerover", (event) => {
    const anchor = closestElement(event.target, ".ProseMirror a");
    if (!anchor || dragging) return;
    window.clearTimeout(previewTimer);
    previewTimer = window.setTimeout(() => showActions(anchor), 220);
  });
  lifetime.listen(root, "pointerout", leaveActions);
  lifetime.listen(root, "pointerdown", () => {
    dragging = true;
    hideActions();
  });
  lifetime.listen(document, "pointerup", () => {
    dragging = false;
  });
  lifetime.listen(document, "pointercancel", () => {
    dragging = false;
  });
  lifetime.listen(document, "pointerdown", (event) => {
    if (event.target instanceof Node && !root.contains(event.target) && !preview.contains(event.target)) hideActions();
  });
  lifetime.listen(document, "selectionchange", () => {
    const selection = document.getSelection();
    const editorSelection = state_fn()?.view?.state.selection;
    if (
      selection &&
      !selection.isCollapsed &&
      root.contains(selection.anchorNode) &&
      !(editorSelection instanceof NodeSelection && editorSelection.node.type.name === "wiki_link")
    )
      hideActions();
  });
  lifetime.listen(document, "focusin", (event) => {
    if (
      event.target instanceof Node &&
      !state_fn()?.view?.dom.contains(event.target) &&
      !preview.contains(event.target)
    )
      hideActions();
  });
  lifetime.listen(root, "keydown", hideActions);
  lifetime.listen(root, "scroll", positionActions, true);
  lifetime.listen(window, "resize", hideActions);
  lifetime.listen(preview, "pointerenter", () => window.clearTimeout(previewTimer));
  lifetime.listen(preview, "pointerleave", leaveActions);
  lifetime.listen(preview, "keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      hideActions();
      state_fn()?.view?.focus();
    }
  });
  const dialog = document.createElement("dialog");
  dialog.className = "folio-link-dialog";
  dialog.setAttribute("aria-label", "Link options");
  const form = document.createElement("form");
  const heading = document.createElement("h2");
  heading.textContent = "Link";
  form.append(heading);
  const fields = { label: document.createElement("input"), href: document.createElement("input") };
  for (const [key, name] of [
    ["label", "Display text"],
    ["href", "Link target"],
  ] as const) {
    const label = document.createElement("label");
    label.textContent = name;
    const input = fields[key];
    input.type = "text";
    input.setAttribute("aria-label", name);
    input.required = true;
    label.append(input);
    form.append(label);
  }
  const status = document.createElement("p");
  status.className = "form-hint";
  const error = document.createElement("p");
  error.className = "notice is-error";
  error.dataset.inlineStatus = "";
  error.setAttribute("role", "alert");
  error.hidden = true;
  const actions = document.createElement("div");
  actions.className = "dialog-actions";
  let target: LinkTarget | null = null;
  const button = (text: string, handler: () => unknown | Promise<unknown>) => {
    const control = document.createElement("button");
    control.type = "button";
    control.textContent = text;
    lifetime.listen(control, "click", () => void run(handler));
    actions.append(control);
    return control;
  };
  const run = async (action: () => unknown | Promise<unknown>) => {
    error.hidden = true;
    try {
      await action();
    } catch (failure) {
      error.textContent = errorMessage(failure);
      error.hidden = false;
    }
  };
  function requireTarget() {
    if (!target) throw new Error("This link is no longer open.");
    return target;
  }
  const open = button("Open", () => {
    const { url } = requireTarget();
    if (!url) throw new Error("This link is unavailable.");
    dialog.close();
    onOpen_fn(url);
  });
  const copy = button("Copy link", async () => {
    const current = requireTarget();
    await navigator.clipboard.writeText(current.url || current.link.href);
    if (target === current && dialog.open) copy.textContent = "Copied";
  });
  const create = button("Create note", async () => {
    const { path } = requireTarget();
    if (!path || !onCreate_fn) throw new Error("This link cannot be created.");
    dialog.close();
    await onCreate_fn(path);
  });
  button("Cancel", () => dialog.close());
  const apply = document.createElement("button");
  apply.type = "submit";
  apply.className = "button-primary";
  apply.textContent = "Apply";
  actions.append(apply);
  form.append(status, error, actions);
  dialog.append(form);
  document.body.append(dialog);
  lifetime.defer(() => {
    target = null;
    if (dialog.open) dialog.close();
    dialog.remove();
  });
  const refresh = () => {
    if (!target) return;
    for (const field of Object.values(fields)) field.readOnly = !editable_fn();
    apply.hidden = !editable_fn();
    target.url = target.path ? transformUrl(target.path, target.owner.path) : null;
    const changed = fields.href.value !== target.link.href || fields.label.value !== target.link.label;
    apply.disabled = !changed;
    open.disabled = !target.url || changed;
    copy.disabled = changed;
    create.hidden = changed || Boolean(target.url) || !target.path || !canCreate_fn?.(target.path);
    status.textContent = changed
      ? "Apply your changes before opening or copying this link."
      : target.url
        ? "Click Open to follow this link."
        : "This note is unavailable. Check its path or your access permissions.";
  };
  lifetime.listen(form, "input", () => {
    error.hidden = true;
    copy.textContent = "Copy link";
    refresh();
  });
  lifetime.listen(form, "submit", (event) => {
    event.preventDefault();
    void run(() => {
      if (!target || target.owner !== state_fn() || !editable_fn()) throw new Error("This note is no longer editable.");
      const { view } = target.owner;
      const current = linkRangeAt(view.state, target.link.from);
      if (!current || current.href !== target.link.href || current.label !== target.link.label)
        throw new Error("This link changed. Close these options and select it again.");
      const raw = fields.href.value.trim();
      const label = fields.label.value.trim();
      const href = current.wiki ? raw : autoLinkDestination(raw) || raw;
      const destination = current.wiki ? wikiDestination(href) : href;
      if (!label || !destination || !resolveMarkdownUrl(destination, target.owner.path))
        throw new Error("Enter a valid link target and display text.");
      const tr = closeHistory(view.state.tr).setMeta("folio-link-edit", true);
      if (current.wiki) tr.setNodeMarkup(current.from, undefined, { ...current.attrs, target: href, label });
      else {
        if (label !== current.label) tr.insertText(label, current.from, current.to);
        const to = current.from + label.length;
        tr.removeMark(current.from, to, view.state.schema.marks.link).addMark(
          current.from,
          to,
          view.state.schema.marks.link.create({ ...current.attrs, href, auto: false }),
        );
      }
      view.dispatch(tr);
      dialog.close();
    });
  });
  lifetime.listen(dialog, "close", () => {
    if (dialog.open) return;
    if (target && target.owner === state_fn()) target.owner.view.focus();
    target = null;
  });
  function edit(anchor: HTMLElement | null) {
    const info = describe(anchor);
    if (!info) return false;
    hideActions();
    onBeforeEdit_fn?.();
    target = info;
    const { link } = info;
    fields.label.value = link.label;
    fields.href.value = link.href;
    copy.textContent = "Copy link";
    refresh();
    error.hidden = true;
    dialog.showModal();
    fields.href.focus();
    return true;
  }
  return {
    refresh() {
      refresh();
      if (previewAnchor && !preview.hidden) showActions(previewAnchor);
    },
    close() {
      hideActions();
      if (dialog.open) dialog.close();
    },
    showActions,
    editSelection() {
      const view = state_fn()?.view;
      if (!view) return false;
      const direct = view.nodeDOM(view.state.selection.from);
      const point = view.domAtPos(view.state.selection.from, -1).node;
      return edit(nodeElement(direct)?.closest("a") ?? nodeElement(point)?.closest("a") ?? null);
    },
    open: edit,
  };
}
