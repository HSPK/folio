import { documentSession } from "../../state/document";
import type { DocumentSessionId } from "@folio/model";
import { shell } from "../../state/shell";
import type { SourceChanges } from "@folio/editor-runtime";
import type { Heading } from "../../types/domain";
import { element, clearTimer, htmlChildren } from "../../types/elements";
import { isRecord } from "../../types/guards";
import { setSidebar } from "../accounts/authentication";
import { appState } from "../core/bootstrap";
import { listen, onApplicationDispose } from "../lifecycle";
import { settingsState } from "../preferences/settings";

let outlineDocument: DocumentSessionId | null;
let outlinePinned: boolean;
let outlineDismissed: boolean;
let outlineCloseTimer: number | null;
let outlineScrollFrame: number | null;
let outlineHeadingCache: { root: HTMLElement; revision: number; headings: HTMLElement[]; index: number } | null;
let outlineOpenOnLoad: boolean;

function isSourceChanges(value: unknown): value is SourceChanges {
  return (
    isRecord(value) &&
    typeof value.beforeLength === "number" &&
    typeof value.afterLength === "number" &&
    Array.isArray(value.ranges) &&
    value.ranges.every(
      (range: unknown) =>
        isRecord(range) &&
        ["fromA", "toA", "fromB", "toB"].every((key) => typeof range[key] === "number" && Number.isFinite(range[key])),
    )
  );
}

export function initializeNavigationOutline(): void {
  outlineDocument = null;
  outlinePinned = false;
  outlineDismissed = false;
  outlineCloseTimer = null;
  outlineScrollFrame = null;
  onApplicationDispose(() => {
    clearTimer(outlineCloseTimer);
    if (outlineScrollFrame !== null) cancelAnimationFrame(outlineScrollFrame);
    outlineHeadingCache = null;
  });
  outlineHeadingCache = null;
  outlineOpenOnLoad = false;
  element("outline-panel").hidden = false;
  listen(element("outline-tab"), "click", () => {
    if (outlinePinned) closeDocumentOutline({ dismiss: true });
    else openDocumentOutline({ pin: true });
  });
  listen(element("document-outline"), "pointerenter", () => openDocumentOutline());
  listen(element("document-outline"), "pointerleave", () => {
    outlineDismissed = false;
    deferOutlineClose();
  });
  listen(element("document-outline"), "focusin", () => openDocumentOutline());
  listen(element("document-outline"), "focusout", deferOutlineClose);
  listen(element("document-outline"), "keydown", navigateOutlineKeys);
  listen(document, "pointerdown", (event) => {
    if (!(event.target instanceof Element)) return;

    if (
      (outlineOpenOnLoad || outlineDismissed || element("document-outline").hasAttribute("data-open")) &&
      !element("document-outline").contains(event.target)
    )
      closeDocumentOutline();
  });
  listen(
    element("document-panes"),
    "scroll",
    (event) => {
      const target = event.target;
      if (
        target === element("preview") ||
        (target instanceof HTMLElement && target.hasAttribute("data-editor-scroller"))
      )
        scheduleOutlineLocation();
    },
    true,
  );
  listen(element("document-panes"), "keyup", () => {
    if (shell.view !== "rich") scheduleOutlineLocation();
  });
  listen(window, "resize", scheduleOutlineLocation);
}
export function scheduleOutlineRefresh(
  changes: unknown = null,
  delay = settingsState.webPreferences.outlineDelayMs,
): void {
  const pending = appState.outlineTimer !== null;
  if (changes !== null && changes !== undefined && !isSourceChanges(changes)) {
    throw new Error("The Source editor emitted an invalid outline change range.");
  }
  clearTimer(appState.outlineTimer);
  appState.outlineChanges = pending ? null : (changes ?? null);
  appState.outlineTimer = window.setTimeout(refreshOutline, delay);
}

export function refreshOutline(): void {
  clearTimer(appState.outlineTimer);
  appState.outlineTimer = null;
  const changes = appState.outlineChanges;
  appState.outlineChanges = null;
  if (appState.outlineSource === appState.editor.value && outlineDocument === documentSession.id) return;
  appState.outlineSource = appState.editor.value;
  renderOutline(documentSession.current ? appState.outlineExtractor.extract(appState.outlineSource, changes) : []);
}

export function renderOutline(items: Heading[]): void {
  const changedDocument = outlineDocument !== documentSession.id;
  const openOnLoad = outlineOpenOnLoad;
  outlineDocument = documentSession.id;
  outlineHeadingCache = null;
  if (changedDocument) {
    closeDocumentOutline();
    appState.currentOutlineButton = null;
  }
  const reusable =
    items.length === appState.outlineButtons.length && (!items.length || appState.outlineButtons[0].isConnected);
  if (!reusable) {
    appState.currentOutlineButton = null;
    const fragment = document.createDocumentFragment();
    appState.outlineButtons = items.map((_, index) => {
      const row = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.heading = String(index);
      row.append(button);
      fragment.append(row);
      return button;
    });
    element("outline-list").replaceChildren(fragment);
  }
  const minimumLevel = items.reduce((minimum, item) => Math.min(minimum, item.level), 6);
  items.forEach((item, index) => {
    const button = appState.outlineButtons[index];
    const text = item.text || "Untitled heading";
    if (button.textContent !== text) button.textContent = text;
    button.dataset.level = String(item.level);
    button.style.setProperty("--outline-indent", `${(item.level - minimumLevel) * 12}px`);
    button.tabIndex = button === appState.currentOutlineButton ? 0 : -1;
    if (changedDocument) button.removeAttribute("aria-current");
  });
  appState.outlineItems = items;
  appState.outlineById = new Map(items.map((item, index) => [item.id, appState.outlineButtons[index]]));
  element("outline-empty").hidden = items.length > 0;
  element("document-outline").hidden = !documentSession.current || !items.length;
  if (element("document-outline").hidden) closeDocumentOutline();
  const count = Math.min(items.length, 24);
  if (element("outline-rail").childElementCount !== count) {
    element("outline-rail").replaceChildren(...Array.from({ length: count }, () => document.createElement("span")));
  }
  for (let index = 0; index < count; index++) {
    const heading = Math.floor((index * items.length) / count);
    const mark = htmlChildren(element("outline-rail"))[index];
    mark.dataset.heading = String(heading);
    mark.dataset.level = String(items[heading].level);
  }
  highlightOutline(
    appState.currentOutlineButton ? items[Number(appState.currentOutlineButton.dataset.heading)]?.id : items[0]?.id,
    true,
  );
  if (changedDocument && openOnLoad && items.length) openDocumentOutline({ pin: true });
}

export function setCurrentOutline(id: string | null | undefined): void {
  highlightOutline(id, false);
}

function highlightOutline(id: string | null | undefined, rebuilt: boolean): void {
  const next = id ? (appState.outlineById.get(id) ?? null) : null;
  if (!rebuilt && appState.currentOutlineButton === next) return;
  if (appState.currentOutlineButton !== next) {
    appState.currentOutlineButton?.removeAttribute("aria-current");
    if (appState.currentOutlineButton) appState.currentOutlineButton.tabIndex = -1;
    appState.currentOutlineButton = next;
  }
  appState.currentOutlineButton?.setAttribute("aria-current", "location");
  if (appState.currentOutlineButton) appState.currentOutlineButton.tabIndex = 0;
  const index = Number(appState.currentOutlineButton?.dataset.heading ?? 0);
  const marks = htmlChildren(element("outline-rail"));
  marks.forEach((mark, at) =>
    mark.classList.toggle(
      "is-current",
      index >= Number(mark.dataset.heading) &&
        index < Number(marks[at + 1]?.dataset.heading ?? appState.outlineItems.length),
    ),
  );
}

export function openDocumentOutline({ pin = false, focus = false }: { pin?: boolean; focus?: boolean } = {}): void {
  refreshOutline();
  if (element("document-outline").hidden) {
    outlineOpenOnLoad ||= pin && !documentSession.current;
    return;
  }
  if (outlineDismissed && !pin) return;
  if (appState.compactLayout.matches && (pin || focus)) setSidebar(false);
  clearTimer(outlineCloseTimer);
  outlineDismissed = false;
  outlinePinned ||= pin;
  element("document-outline").setAttribute("data-open", "");
  element("outline-tab").setAttribute("aria-expanded", "true");
  element("outline-panel").inert = false;
  element("outline-panel").setAttribute("aria-hidden", "false");
  if (focus) element("outline-tab").focus({ preventScroll: true });
}

export function closeDocumentOutline({
  focus = false,
  dismiss = false,
}: { focus?: boolean; dismiss?: boolean } = {}): void {
  clearTimer(outlineCloseTimer);
  outlinePinned = false;
  outlineOpenOnLoad = false;
  outlineDismissed = dismiss;
  element("document-outline").removeAttribute("data-open");
  element("outline-tab").setAttribute("aria-expanded", "false");
  element("outline-panel").inert = true;
  element("outline-panel").setAttribute("aria-hidden", "true");
  if (focus) element("outline-tab").focus({ preventScroll: true });
}

function deferOutlineClose(): void {
  clearTimer(outlineCloseTimer);
  outlineCloseTimer = window.setTimeout(() => {
    if (!outlinePinned && !element("document-outline").matches(":hover, :focus-within")) closeDocumentOutline();
  }, 160);
}

function updateOutlineLocation(): void {
  outlineScrollFrame = null;
  if (!appState.outlineItems.length || !documentSession.current) return;
  const mode = shell.view;
  if (mode !== "rich" && mode !== "preview") {
    const position = appState.editor.selectionStart;
    const heading = appState.outlineItems.findLast((item) => item.from <= position) ?? appState.outlineItems[0];
    setCurrentOutline(heading.id);
    return;
  }
  const root = mode === "rich" ? element("rich-editor") : element("preview");
  const viewport = mode === "rich" ? root.querySelector<HTMLElement>("[data-editor-scroller]") : element("preview");
  if (!viewport) return;
  if (
    outlineHeadingCache?.root !== root ||
    outlineHeadingCache.revision !== documentSession.revision ||
    !outlineHeadingCache.headings[0]?.isConnected
  ) {
    outlineHeadingCache = {
      root,
      revision: documentSession.revision,
      index: 0,
      headings: [...root.querySelectorAll<HTMLElement>("h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]")].filter(
        (node) => appState.outlineById.has(node.id),
      ),
    };
  }
  const cache = outlineHeadingCache;
  const { headings, index } = cache;
  if (!headings.length) return;
  const bounds = viewport.getBoundingClientRect();
  const top = bounds.top + Math.min(100, bounds.height / 3);
  // Most scroll frames stay in one section. Read live bounds so images, wrapping and zoom need no offset cache.
  let low: number, high: number;
  if (index > 0 && headings[index].getBoundingClientRect().top > top) {
    low = 0;
    high = index;
  } else if (index + 1 < headings.length && headings[index + 1].getBoundingClientRect().top <= top) {
    low = index + 2;
    high = headings.length;
  } else {
    setCurrentOutline(headings[index].id);
    return;
  }
  while (low < high) {
    const middle = (low + high) >> 1;
    if (headings[middle].getBoundingClientRect().top <= top) low = middle + 1;
    else high = middle;
  }
  cache.index = Math.max(0, low - 1);
  setCurrentOutline(headings[cache.index].id);
}

function scheduleOutlineLocation(): void {
  if (outlineScrollFrame === null) outlineScrollFrame = window.requestAnimationFrame(updateOutlineLocation);
}

function navigateOutlineKeys(event: KeyboardEvent): void {
  if (!(event.target instanceof Element)) return;

  if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeDocumentOutline({ focus: true, dismiss: true });
    return;
  }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || !appState.outlineButtons.length) return;
  event.preventDefault();
  openDocumentOutline({ pin: true });
  const index = event.target instanceof HTMLButtonElement ? appState.outlineButtons.indexOf(event.target) : -1;
  const target =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? appState.outlineButtons.length - 1
        : index < 0
          ? Number(appState.currentOutlineButton?.dataset.heading ?? 0)
          : Math.max(0, Math.min(appState.outlineButtons.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
  appState.outlineButtons[target].focus();
}
