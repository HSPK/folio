import { documentSession } from "../../state/document";
import type { DocumentSessionId } from "@folio/model";
import { shell } from "../../state/shell";
import type { SourceChanges } from "@folio/editor-runtime";
import type { Heading } from "../../types/domain";
import { clearTimer, htmlChildren } from "../../types/elements";
import { isRecord } from "../../types/guards";
import { setSidebar } from "../accounts/authentication";
import { appState } from "../core/bootstrap";
import { listen, onApplicationDispose } from "../lifecycle";
import { settingsState } from "../preferences/settings";

class OutlineState {
  outlineDocument!: DocumentSessionId | null;
  outlinePinned!: boolean;
  outlineDismissed!: boolean;
  outlineCloseTimer!: number | null;
  outlineScrollFrame!: number | null;
  outlineHeadingCache!: { root: HTMLElement; revision: number; headings: HTMLElement[] } | null;
  outlineOpenOnLoad!: boolean;
}
export const outlineState = new OutlineState();

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
  outlineState.outlineDocument = null;
  outlineState.outlinePinned = false;
  outlineState.outlineDismissed = false;
  outlineState.outlineCloseTimer = null;
  outlineState.outlineScrollFrame = null;
  onApplicationDispose(() => {
    clearTimer(outlineState.outlineCloseTimer);
    if (outlineState.outlineScrollFrame !== null) cancelAnimationFrame(outlineState.outlineScrollFrame);
    outlineState.outlineHeadingCache = null;
  });
  outlineState.outlineHeadingCache = null;
  outlineState.outlineOpenOnLoad = false;
  appState.ui.outlinePanel.hidden = false;
  listen(appState.ui.outlineTab, "click", () => {
    if (outlineState.outlinePinned) closeDocumentOutline({ dismiss: true });
    else openDocumentOutline({ pin: true });
  });
  listen(appState.ui.outlineNavigation, "pointerenter", () => openDocumentOutline());
  listen(appState.ui.outlineNavigation, "pointerleave", () => {
    outlineState.outlineDismissed = false;
    deferOutlineClose();
  });
  listen(appState.ui.outlineNavigation, "focusin", () => openDocumentOutline());
  listen(appState.ui.outlineNavigation, "focusout", deferOutlineClose);
  listen(appState.ui.outlineNavigation, "keydown", navigateOutlineKeys);
  listen(document, "pointerdown", (event) => {
    if (!(event.target instanceof Element)) return;

    if (!appState.ui.outlineNavigation.contains(event.target)) closeDocumentOutline();
  });
  listen(appState.ui.panes, "scroll", scheduleOutlineLocation, true);
  listen(appState.ui.panes, "keyup", () => {
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
  if (appState.outlineSource === appState.ui.editor.value && outlineState.outlineDocument === documentSession.id)
    return;
  appState.outlineSource = appState.ui.editor.value;
  renderOutline(documentSession.current ? appState.outlineExtractor.extract(appState.outlineSource, changes) : []);
}

export function renderOutline(items: Heading[]): void {
  const changedDocument = outlineState.outlineDocument !== documentSession.id;
  const openOnLoad = outlineState.outlineOpenOnLoad;
  outlineState.outlineDocument = documentSession.id;
  outlineState.outlineHeadingCache = null;
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
    appState.ui.outlineList.replaceChildren(fragment);
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
  appState.ui.outlineEmpty.hidden = items.length > 0;
  appState.ui.outlineNavigation.hidden = !documentSession.current || !items.length;
  if (appState.ui.outlineNavigation.hidden) closeDocumentOutline();
  const count = Math.min(items.length, 24);
  if (appState.ui.outlineRail.childElementCount !== count) {
    appState.ui.outlineRail.replaceChildren(...Array.from({ length: count }, () => document.createElement("span")));
  }
  for (let index = 0; index < count; index++) {
    const heading = Math.floor((index * items.length) / count);
    const mark = htmlChildren(appState.ui.outlineRail)[index];
    mark.dataset.heading = String(heading);
    mark.dataset.level = String(items[heading].level);
  }
  setCurrentOutline(
    appState.currentOutlineButton ? items[Number(appState.currentOutlineButton.dataset.heading)]?.id : items[0]?.id,
  );
  if (changedDocument && openOnLoad && items.length) openDocumentOutline({ pin: true });
}

export function setCurrentOutline(id: string | null | undefined): void {
  const next = id ? (appState.outlineById.get(id) ?? null) : null;
  if (appState.currentOutlineButton !== next) {
    appState.currentOutlineButton?.removeAttribute("aria-current");
    if (appState.currentOutlineButton) appState.currentOutlineButton.tabIndex = -1;
    appState.currentOutlineButton = next;
  }
  appState.currentOutlineButton?.setAttribute("aria-current", "location");
  if (appState.currentOutlineButton) appState.currentOutlineButton.tabIndex = 0;
  const index = Number(appState.currentOutlineButton?.dataset.heading ?? 0);
  const marks = htmlChildren(appState.ui.outlineRail);
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
  if (appState.ui.outlineNavigation.hidden) {
    outlineState.outlineOpenOnLoad ||= pin && !documentSession.current;
    return;
  }
  if (outlineState.outlineDismissed && !pin) return;
  if (appState.compactLayout.matches && (pin || focus)) setSidebar(false);
  clearTimer(outlineState.outlineCloseTimer);
  outlineState.outlineDismissed = false;
  outlineState.outlinePinned ||= pin;
  appState.ui.outlineNavigation.setAttribute("data-open", "");
  appState.ui.outlineTab.setAttribute("aria-expanded", "true");
  appState.ui.outlinePanel.inert = false;
  appState.ui.outlinePanel.setAttribute("aria-hidden", "false");
  if (focus) appState.ui.outlineTab.focus({ preventScroll: true });
}

export function closeDocumentOutline({
  focus = false,
  dismiss = false,
}: { focus?: boolean; dismiss?: boolean } = {}): void {
  clearTimer(outlineState.outlineCloseTimer);
  outlineState.outlinePinned = false;
  outlineState.outlineOpenOnLoad = false;
  outlineState.outlineDismissed = dismiss;
  appState.ui.outlineNavigation.removeAttribute("data-open");
  appState.ui.outlineTab.setAttribute("aria-expanded", "false");
  appState.ui.outlinePanel.inert = true;
  appState.ui.outlinePanel.setAttribute("aria-hidden", "true");
  if (focus) appState.ui.outlineTab.focus({ preventScroll: true });
}

export function deferOutlineClose(): void {
  clearTimer(outlineState.outlineCloseTimer);
  outlineState.outlineCloseTimer = window.setTimeout(() => {
    if (!outlineState.outlinePinned && !appState.ui.outlineNavigation.matches(":hover, :focus-within"))
      closeDocumentOutline();
  }, 160);
}

export function updateOutlineLocation(): void {
  outlineState.outlineScrollFrame = null;
  if (!appState.outlineItems.length || !documentSession.current) return;
  const mode = shell.view;
  if (mode !== "rich" && mode !== "preview") {
    const heading =
      appState.outlineItems.findLast((item) => item.from <= appState.ui.editor.selectionStart) ??
      appState.outlineItems[0];
    setCurrentOutline(heading.id);
    return;
  }
  const root = mode === "rich" ? appState.element("rich-editor") : appState.ui.preview;
  const viewport = mode === "rich" ? root.querySelector<HTMLElement>("[data-editor-scroller]") : appState.ui.preview;
  if (!viewport) return;
  if (
    outlineState.outlineHeadingCache?.root !== root ||
    outlineState.outlineHeadingCache.revision !== documentSession.revision
  ) {
    outlineState.outlineHeadingCache = {
      root,
      revision: documentSession.revision,
      headings: [...root.querySelectorAll<HTMLElement>("h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]")].filter(
        (node) => appState.outlineById.has(node.id),
      ),
    };
  }
  const { headings } = outlineState.outlineHeadingCache;
  if (!headings.length) return;
  const bounds = viewport.getBoundingClientRect();
  const top = bounds.top + Math.min(100, bounds.height / 3);
  let low = 0;
  let high = headings.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (headings[middle].getBoundingClientRect().top <= top) low = middle + 1;
    else high = middle;
  }
  setCurrentOutline(headings[Math.max(0, low - 1)].id);
}

export function scheduleOutlineLocation(): void {
  if (outlineState.outlineScrollFrame === null)
    outlineState.outlineScrollFrame = window.requestAnimationFrame(updateOutlineLocation);
}

export function navigateOutlineKeys(event: KeyboardEvent): void {
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
