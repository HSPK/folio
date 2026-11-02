import { Editor, rootCtx, defaultValueCtx, editorViewCtx, serializerCtx, parserCtx } from "@milkdown/core";
import { commonmark, syncHeadingIdPlugin, remarkPreserveEmptyLinePlugin } from "@milkdown/preset-commonmark";
import { gfm } from "@milkdown/preset-gfm";
import { history } from "@milkdown/plugin-history";
import { $prose, $remark } from "@milkdown/utils";
import { Plugin, NodeSelection, TextSelection } from "@milkdown/prose/state";
import { splitFrontMatter } from "./editor-helpers.ts";
import type { Node as ProseNode } from "@milkdown/prose/model";
import type { EditorSession, InlineEditorOptions, MarkdownUrl, ProseNodeJSON } from "./types/editor.ts";
import {
  hasMetadata,
  isReadySession,
  sessionPositionMap as positionMap,
  sessionSource as fullSource,
} from "./editor-session.ts";
import { createEditorAnalysis } from "./editor-analysis.ts";
import { closestElement } from "./dom.ts";
import { errorMessage } from "./errors.ts";
import { Lifetime } from "../../shared/lifetime.ts";
import { createOutlineExtractor, parseBody, unsupportedBody, bodyFingerprint, documentOffset } from "./markdown.ts";
import { normalizeSerializedBody } from "./roundtrip.ts";
import { createBodyCache, createBodySerializer, reuseParsedBody, serializedBodyTree } from "./body-serialization.ts";
import "./editor.css";
import { deferScrollbars } from "./scrollbars.ts";
import { createSlashMenu } from "./slash-menu.ts";
import { math } from "./math.ts";
import { replaceRemoteSource } from "./remote-source.ts";
import { currentViewSelection, jumpToHeading, rawOffset, textareaCursorRect } from "./cursor-coordinates.ts";
import { createLiveCaret } from "./live-caret.ts";
import { mountMetadata } from "./metadata.ts";
import { wiki } from "./wiki.ts";
import { createWikiMenu } from "./wiki-menu.ts";
import { createImageTools, imagePlugins } from "./images.ts";
import { createTableTools } from "./tables.ts";
import { createBlockTools } from "./block-tools.ts";
import { nodeMarkdown } from "./node-toolbar.ts";
import { handleListKeyDown } from "./list-commands.ts";
import { lineKeymap } from "./line-keymap.ts";
import { createImageFlowPlugins, imageSelectionAtPoint } from "./image-flow.ts";
import { createImageInsertion, imageBoundarySelection, isImageNode } from "./image-model.ts";
import { autoLinks } from "./auto-links.ts";
import { createLinkTools } from "./links.ts";
import { createEditorViews } from "./editor-views.ts";
import "./node-tools.css";
import "./collaboration.css";

// Our decorations supply Rust-compatible IDs without rewriting the document's heading nodes.
// Empty paragraphs stay Markdown spacing instead of becoming HTML placeholders.
const notesCommonmark = commonmark.filter(
  (plugin) => plugin !== syncHeadingIdPlugin && !remarkPreserveEmptyLinePlugin.includes(plugin),
);

export function createInlineEditor(options: InlineEditorOptions) {
  const lifetime = new Lifetime();
  try {
    return createOwnedEditor(options, lifetime);
  } catch (error) {
    try {
      lifetime.dispose();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "The editor could not initialize or release its resources.");
    }
    throw error;
  }
}

function createOwnedEditor(
  {
    root,
    onChange,
    onFallback,
    onLink,
    onReady,
    onOutline,
    onSelection,
    onHeadingSelection,
    onTitle,
    onTag,
    onNotice: notify,
    onImageUpload,
    canCreateLink,
    onCreateLink,
    styleNonce,
    trackSelection = () => true,
    trackOutline = () => true,
    wikiDocuments = () => [],
    transformUrl: resolveUrl = (url) => url,
    outlineExtractor = createOutlineExtractor(),
  }: InlineEditorOptions,
  lifetime: Lifetime,
) {
  let generation = 0;
  let spellcheck = true;
  let readOnly = false;
  let session: EditorSession | null = null;
  const active = (state: EditorSession) => !lifetime.signal.aborted && session === state && state.ticket === generation;
  const transformUrl: MarkdownUrl = (url, path) => (lifetime.signal.aborted ? null : resolveUrl(url, path));
  const onNotice: InlineEditorOptions["onNotice"] = (message, kind, source) => {
    if (!lifetime.signal.aborted) notify?.(message, kind, source);
  };
  const slashMenu = createSlashMenu(active, {
    lifetime,
    upload_fn: onImageUpload,
    onNotice: (message, kind) => onNotice?.(message, kind, "image"),
  });
  const wikiMenu = createWikiMenu(active, wikiDocuments, lifetime);
  const imageTools = createImageTools({
    lifetime,
    root,
    onNotice: (message, kind) => onNotice?.(message, kind, "image"),
    upload_fn: onImageUpload,
  });
  const tableTools = createTableTools({
    lifetime,
    root,
    onNotice: (message, kind) => onNotice?.(message, kind, "table"),
  });
  const blockTools = createBlockTools({ lifetime, root, tableTools, onNotice });
  const linkTools = createLinkTools({
    lifetime,
    root,
    state_fn: () => session,
    editable_fn: () => !readOnly,
    onBeforeEdit_fn: closeNodeTools,
    transformUrl,
    onOpen_fn: onLink,
    canCreate_fn: canCreateLink,
    onCreate_fn: onCreateLink,
  });
  const parsedBodies = createBodyCache();
  const { headingsFor, sourcePosition, publishOutline, publishSelection } = createEditorAnalysis({
    active,
    trackOutline,
    trackSelection,
    outlineExtractor,
    onOutline,
    onSelection,
    onHeadingSelection,
  });

  function closeNodeTools() {
    imageTools.close();
    tableTools.close();
    blockTools.close();
  }

  function dismissMenus() {
    slashMenu.close();
    wikiMenu.close();
    closeNodeTools();
    linkTools.close();
  }

  function clearSession({ keepParsedBodies = false } = {}) {
    generation++;
    if (!keepParsedBodies) parsedBodies.clear();
    outlineExtractor.clear();
    dismissMenus();
    const old = session;
    session = null;
    if (old) {
      old.ready = false;
      old.view?.destroy();
      for (const scrollbar of old.scrollbars) scrollbar.destroy();
      if (old.editor) void old.editor.destroy().catch(console.error);
    }
    root.replaceChildren();
    root.setAttribute("aria-busy", "false");
    if (!lifetime.signal.aborted) onOutline?.([]);
    onNotice?.("");
  }

  async function load(source: string, path: string) {
    lifetime.signal.throwIfAborted();
    clearSession({ keepParsedBodies: true });
    const parts = splitFrontMatter(source);
    const cachedBody = parsedBodies.get(parts.body);
    const state: EditorSession = {
      ticket: generation,
      path,
      parts,
      originalBody: parts.body,
      bodySource: parts.body,
      bodyAst: cachedBody?.tree ?? parseBody(parts.body),
      bodyAstSource: parts.body,
      ready: false,
      editor: null,
      view: null,
      outlineSignature: "",
      scrollbars: [],
    };
    session = state;
    root.dataset.editorMode = "formatted";
    const scroll = document.createElement("div");
    scroll.className = "folio-live-scroll";
    scroll.setAttribute("data-editor-scroller", "");
    const surface = document.createElement("div");
    surface.className = "folio-editor-surface";
    const page = document.createElement("div");
    page.className = "folio-live-page";
    scroll.append(page);
    surface.append(scroll);
    root.append(surface);
    const scrollbars = deferScrollbars(root, { nonce: styleNonce });
    state.scrollbars.push(scrollbars);
    scrollbars.attach({ host: surface, viewport: scroll });
    mountMetadata(state, page, {
      readOnly,
      styleNonce,
      active,
      fullSource,
      onTitle,
      onChange,
      publishOutline,
      onSelection,
      onHeadingSelection,
      onTag,
      onNotice,
    });
    publishOutline(state);
    const unsupported = unsupportedBody(state.bodyAst, state.bodySource);
    if (unsupported) {
      queueMicrotask(() => {
        if (active(state)) onFallback(unsupported);
      });
      return;
    }
    const mount = document.createElement("div");
    mount.className = "folio-prose";
    page.append(mount);
    root.setAttribute("aria-busy", "true");
    let instance: Editor | undefined;
    const slash = slashMenu.props(state);
    const nodeActive_fn = () => active(state) && state.ready;
    const editable_fn = () => nodeActive_fn() && !readOnly;
    const imageFlow = createImageFlowPlugins({ active_fn: nodeActive_fn, editable_fn }).map((plugin) =>
      $prose(() => plugin),
    );
    const serializeNode_fn = (node: ProseNode) => {
      if (!isReadySession(state)) throw new Error("The formatted editor is not ready to serialize this node.");
      return state.editor.action((ctx) =>
        nodeMarkdown({
          node,
          document: state.view.state.doc,
          serialize_fn: ctx.get(serializerCtx),
        }),
      );
    };
    const cachedBodyParser = $remark("folioParsedBody", () =>
      reuseParsedBody({
        source: state.originalBody,
        tree: state.bodyAst,
      }),
    );
    const behavior = $prose(
      (ctx) =>
        new Plugin({
          props: {
            editable: editable_fn,
            attributes: {
              role: "textbox",
              "aria-label": "Formatted Markdown editor",
              "aria-multiline": "true",
              spellcheck: String(spellcheck),
            },
            ...slash,
            handleKeyDown: (view, event) =>
              handleListKeyDown(view, event) || wikiMenu.key(state, event) || slash.handleKeyDown(view, event),
            ...createEditorViews({
              ctx,
              path,
              transformUrl,
              active_fn: nodeActive_fn,
              editable_fn,
              readOnly_fn: () => readOnly,
              onNotice,
              scrollbars,
              imageTools,
              tableTools,
              serialize_fn: serializeNode_fn,
              headingsFor_fn: headingsFor,
            }),
            handleDOMEvents: {
              click(_view, event) {
                const link = closestElement(event.target, "a");
                if (!link) return false;
                event.preventDefault();
                const href = link.getAttribute("href");
                if ((event.ctrlKey || event.metaKey) && href !== null && active(state)) onLink(href);
                else if (!event.ctrlKey && !event.metaKey) linkTools.showActions(link);
                return false;
              },
              auxclick(_view, event) {
                if (!closestElement(event.target, "a")) return false;
                event.preventDefault();
                return true;
              },
              focus(view) {
                if (state.metadata) state.metadata.navigation = null;
                publishSelection(state, view);
                return false;
              },
            },
          },
          view(view) {
            const caret = createLiveCaret({ view, root: surface, active_fn: nodeActive_fn, editable_fn });
            return {
              destroy: () => caret.destroy(),
              update(view, previous) {
                caret.update(previous);
                if (!isReadySession(state) || !active(state)) return;
                if (!view.state.doc.eq(previous.doc)) {
                  // History restores only the body baseline. Metadata is independent
                  // and must survive a body undo, a save, or subsequent typing.
                  state.bodySource = view.state.doc.eq(state.initialDoc)
                    ? state.originalBody
                    : state.bodySerializer.serialize(view.state.doc);
                  onChange(fullSource(state));
                  publishOutline(state);
                }
                if (!view.state.doc.eq(previous.doc) || !view.state.selection.eq(previous.selection))
                  publishSelection(state, view);
                imageTools.updateSelection(view, previous);
                tableTools.updateSelection(view);
                slashMenu.update(state, view);
                wikiMenu.update(state, view);
              },
            };
          },
        }),
    );
    try {
      instance = Editor.make()
        .config((ctx) => {
          ctx.set(rootCtx, mount);
          // JSON recreates nodes in this schema, not another file's view/history.
          ctx.set(defaultValueCtx, cachedBody ? { type: "json", value: cachedBody.documentJSON } : state.originalBody);
        })
        .use(tableTools.plugin())
        .use(blockTools.plugin({ active_fn: nodeActive_fn, editable_fn }))
        .use(lineKeymap({ active_fn: nodeActive_fn, editable_fn, onNotice }))
        .use(notesCommonmark)
        .use(gfm)
        .use(math)
        .use(wiki)
        .use(imagePlugins)
        .use(autoLinks)
        .use(history)
        .use(cachedBodyParser)
        .use(imageFlow)
        .use(slashMenu.plugin(state))
        .use(behavior);
      await instance.create();
      if (!active(state)) {
        await instance.destroy();
        return;
      }
      state.editor = instance;
      const view = instance.action((ctx) => ctx.get(editorViewCtx));
      state.view = view;
      const initialDoc = view.state.doc;
      state.initialDoc = initialDoc;
      const openingSelection = view.state.selection;
      if (openingSelection instanceof NodeSelection && isImageNode(openingSelection.node)) {
        view.dispatch(
          view.state.tr
            .setSelection(imageBoundarySelection(initialDoc, openingSelection.from, -1))
            .setMeta("addToHistory", false),
        );
      }
      const serialize_fn = instance.action((ctx) => ctx.get(serializerCtx));
      const documentJSON: ProseNodeJSON | null = parsedBodies.accepts(state.originalBody) ? initialDoc.toJSON() : null;
      const model = documentJSON ? JSON.stringify(documentJSON) : null;
      const verified = cachedBody && cachedBody.model === model;
      const serialized = verified ? cachedBody.serialized : normalizeSerializedBody(serialize_fn(initialDoc));
      const serializedTree = verified
        ? cachedBody.serializedTree
        : serializedBodyTree({ source: state.originalBody, tree: state.bodyAst, serialized });
      if (
        !verified &&
        serializedTree !== state.bodyAst &&
        bodyFingerprint(state.bodyAst) !== bodyFingerprint(serializedTree)
      ) {
        await instance.destroy();
        state.editor = null;
        onFallback(
          "This body contains Markdown that formatted editing cannot safely round-trip. Use Source mode; the original text is kept.",
        );
        root.setAttribute("aria-busy", "false");
        return;
      }
      if (!verified && model !== null && documentJSON !== null)
        parsedBodies.set(state.originalBody, {
          tree: state.bodyAst,
          model,
          documentJSON,
          serialized,
          serializedTree,
        });
      state.bodySerializer = createBodySerializer({
        document: initialDoc,
        source: serialized,
        tree: serializedTree,
        serialize_fn,
      });
      state.ready = true;
      view.setProps({ editable: () => state.ready && active(state) && !readOnly });
      root.setAttribute("aria-busy", "false");
      publishSelection(state);
      onReady?.();
    } catch (error) {
      if (instance) await instance.destroy().catch(console.error);
      if (!active(state)) return;
      root.setAttribute("aria-busy", "false");
      onFallback(
        `The formatted editor could not open this body. Its original source is preserved. ${errorMessage(error)}`,
      );
    }
  }

  function select(from: number, to = from, scroll = false, focus = true) {
    const state = session;
    if (!state) return false;
    const source = fullSource(state);
    from = Math.max(0, Math.min(source.length, from));
    to = Math.max(0, Math.min(source.length, to));
    if (state.metadata && hasMetadata(state) && from < state.parts.bodyStart) {
      state.metadata.details.open = true;
      state.metadata.advanced.open = true;
      const normalized = (offset: number) =>
        state.parts.raw.slice(0, Math.max(0, offset - state.parts.metadataStart)).replace(/\r\n?/g, "\n").length;
      if (focus) state.metadata.textarea.focus();
      state.metadata.textarea.setSelectionRange(normalized(from), normalized(to));
      if (scroll) state.metadata.textarea.scrollIntoView({ block: "nearest" });
      return true;
    }
    if (!isReadySession(state)) return false;
    const map = positionMap(state, state.view);
    const position = (offset: number) => documentOffset(map, offset - state.parts.bodyStart);
    const document = state.view.state.doc;
    const start = Math.max(0, Math.min(document.content.size, position(from)));
    const end = Math.max(0, Math.min(document.content.size, position(to)));
    let transaction = state.view.state.tr.setSelection(
      TextSelection.between(document.resolve(start), document.resolve(end)),
    );
    if (scroll) transaction = transaction.scrollIntoView();
    if (focus) state.view.focus();
    state.view.dispatch(transaction);
    return true;
  }

  lifetime.defer(() => clearSession());
  return {
    load,
    clear(options?: { keepParsedBodies?: boolean }) {
      if (!lifetime.signal.aborted) clearSession(options);
    },
    destroy: () => lifetime.dispose(),
    editLink() {
      return linkTools.editSelection();
    },
    insertBlock(name: string) {
      return slashMenu.insert(name, session);
    },
    isReady() {
      return Boolean(session?.ready);
    },
    shouldDeferLoad(source: string) {
      const threshold = 48 * 1024;
      if (source.length < threshold) return false;
      const parts = splitFrontMatter(source);
      return parts.prefix.length >= threshold || !parsedBodies.get(parts.body);
    },
    captureImageInsertion({ block = false } = {}) {
      const state = session;
      if (!isReadySession(state) || readOnly) return null;
      return createImageInsertion({
        view: state.view,
        block,
        parse_fn: (markdown) => state.editor.action((ctx) => ctx.get(parserCtx)(markdown)),
        active_fn: () => active(state) && state.ready && !readOnly,
      });
    },
    refreshSelection() {
      if (session?.ready) publishSelection(session);
    },
    dismissMenus() {
      if (!lifetime.signal.aborted) dismissMenus();
    },
    refreshLinks() {
      if (!session || !active(session)) return;
      for (const node of root.querySelectorAll<HTMLElement>("[data-note-url]")) {
        const attribute = node.tagName === "IMG" ? "src" : "href";
        const noteUrl = node.dataset.noteUrl;
        if (noteUrl === undefined) continue;
        const url = transformUrl(noteUrl, session.path);
        if (url) node.setAttribute(attribute, url);
        else node.removeAttribute(attribute);
        if (node.tagName === "A")
          node.title = url
            ? "Ctrl/Cmd+click to open; use Link actions to edit"
            : "Link unavailable. Use Link actions to inspect its target.";
      }
      linkTools.refresh();
    },
    setReadOnly(value: boolean) {
      if (lifetime.signal.aborted) return;
      const changed = readOnly !== value;
      readOnly = value;
      imageTools.refresh();
      tableTools.refresh();
      blockTools.refresh();
      linkTools.refresh();
      for (const checkbox of root.querySelectorAll<HTMLInputElement>(".folio-task-checkbox")) checkbox.disabled = value;
      if (session?.metadata) session.metadata.textarea.disabled = value;
      session?.metadata?.tags.setReadOnly(value);
      if (changed) session?.refreshMetadata?.();
      if (session?.view) session.view.setProps({ editable: () => Boolean(session?.ready && !readOnly) });
    },
    getSelection({ navigation = false } = {}) {
      if (!isReadySession(session)) return null;
      if (navigation && session.metadata?.navigation) return session.metadata.navigation;
      if (document.activeElement?.closest(".folio-property, .folio-tags")) return null;
      const meta = session.metadata?.textarea;
      if (meta && meta === document.activeElement && hasMetadata(session))
        return {
          from: session.parts.metadataStart + rawOffset(session.parts.raw, meta.selectionStart),
          to: session.parts.metadataStart + rawOffset(session.parts.raw, meta.selectionEnd),
        };
      const selection = currentViewSelection(session.view);
      return {
        from: sourcePosition(session, session.view, selection.anchor),
        to: sourcePosition(session, session.view, selection.head),
      };
    },
    cursorRect(offset: number) {
      if (!isReadySession(session)) return null;
      if (offset < session.parts.bodyStart && session.metadata && hasMetadata(session)) {
        return session.metadata.details.open && session.metadata.advanced.open
          ? textareaCursorRect(session.metadata.textarea, offset - session.parts.metadataStart)
          : null;
      }
      const position = documentOffset(positionMap(session, session.view), offset - session.parts.bodyStart);
      return session.view.coordsAtPos(Math.min(session.view.state.doc.content.size, position));
    },
    viewportRect() {
      return (root.querySelector("[data-editor-scroller]") ?? root).getBoundingClientRect();
    },
    async replaceSource(source: string) {
      if (!isReadySession(session)) return false;
      const scroll = root.querySelector<HTMLElement>("[data-editor-scroller]");
      if (!scroll) throw new Error("The formatted editor has no scroll container.");
      const top = scroll.scrollTop;
      if (!replaceRemoteSource(session, source)) return false;
      publishOutline(session);
      scroll.scrollTop = top;
      return true;
    },
    focus() {
      if (isReadySession(session)) session.view.dom.focus({ preventScroll: true });
    },
    selectAtPoint(x: number, y: number) {
      if (!isReadySession(session)) return false;
      const selection = imageSelectionAtPoint(session.view, { x, y });
      if (!selection) return false;
      session.view.dispatch(session.view.state.tr.setSelection(selection));
      session.view.focus();
      return true;
    },
    getSource() {
      return session ? fullSource(session) : "";
    },
    setSpellcheck(value: boolean) {
      spellcheck = Boolean(value);
      session?.view?.dom.setAttribute("spellcheck", String(spellcheck));
    },
    select,
    jumpTo(positionOrHeadingId: unknown, { block = "nearest" }: { block?: ScrollLogicalPosition } = {}) {
      const state = session;
      if (!state) return false;
      if (typeof positionOrHeadingId === "number" && Number.isFinite(positionOrHeadingId))
        return select(Math.trunc(positionOrHeadingId), Math.trunc(positionOrHeadingId), true);
      if (typeof positionOrHeadingId !== "string" || !isReadySession(state)) return false;
      return jumpToHeading(state.view, positionOrHeadingId, block);
    },
  };
}
