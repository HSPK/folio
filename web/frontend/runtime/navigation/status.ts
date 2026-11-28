import { element, requiredQuery } from "../../types/elements";

import { createButton, createIcon } from "@folio/editor-runtime";
import { notice } from "../core/dom";
import { listen, onApplicationDispose } from "../lifecycle";

let statusNotices: HTMLDivElement;
let statusToggle: HTMLButtonElement;
let statusCount: HTMLSpanElement;
let statusMessageList: HTMLDivElement;
let statusOrigins: Map<HTMLElement, (HTMLElement & { open?: boolean }) | null>;
let statusCards: Map<HTMLElement, { card: HTMLDivElement; dismiss: HTMLButtonElement }>;
let statusDismissed: WeakMap<HTMLElement, string>;
let statusSuspensions: WeakMap<HTMLElement, { token: string; text: string | null; className: string }>;
let statusExpanded: boolean | null;
let statusModal: HTMLDialogElement | null;
let statusOverlayContext: HTMLElement | null;
let statusPositionFrame: number | null;
let statusReturnFocus: HTMLElement | null;
let statusResize: ResizeObserver;

export function initializeNavigationStatus(): void {
  statusNotices = document.createElement("div");
  statusNotices.className = "status-notices";
  statusNotices.id = "status-notices";
  statusNotices.setAttribute("popover", "manual");
  statusNotices.setAttribute("aria-label", "Status messages");
  statusNotices.setAttribute("role", "status");
  statusNotices.dataset.preserveNodeTools = "";
  statusToggle = createButton({ label: "Toggle status messages", text: "" });
  statusToggle.className = "status-toggle";
  statusToggle.setAttribute("aria-controls", "status-message-list");
  statusCount = document.createElement("span");
  statusToggle.append(statusCount, createIcon("chevron-down"));
  statusMessageList = document.createElement("div");
  statusMessageList.id = "status-message-list";
  statusMessageList.className = "status-message-list";
  statusNotices.append(statusToggle, statusMessageList);
  document.body.append(statusNotices);
  const notices = statusNotices;
  onApplicationDispose(() => {
    if (statusPositionFrame) cancelAnimationFrame(statusPositionFrame);
    notices.remove();
  });
  const alerts = requiredQuery(document, ".document-alerts", HTMLElement);
  const alertsHome = document.createComment("folio-alerts");
  alerts.before(alertsHome);
  onApplicationDispose(() => alertsHome.replaceWith(alerts));
  statusOrigins = new Map();
  statusCards = new Map();
  statusDismissed = new WeakMap();
  statusSuspensions = new WeakMap();
  statusExpanded = null;
  statusModal = null;
  statusOverlayContext = null;
  statusPositionFrame = 0;
  statusReturnFocus = null;
  for (const node of new Set(
    [
      ...document.querySelectorAll<HTMLElement>(".document-alerts > *"),
      ...document.querySelectorAll<HTMLDialogElement>("dialog .notice"),
      element("auth-error"),
      ...document.querySelectorAll<HTMLElement>("[data-status-source]"),
      element("dirty-indicator"),
      element("connection-label"),
      element("document-message"),
      element("tree-message"),
      element("tree-limit"),
      element("preview-status"),
    ].filter((node) => !node.hasAttribute("data-inline-status")),
  )) {
    const home = document.createComment("folio-status");
    node.before(home);
    onApplicationDispose(() => home.replaceWith(node));
    node.classList.remove("visually-hidden");
    statusOrigins.set(node, node.closest<HTMLElement>("dialog, #auth-screen"));
    const card = document.createElement("div");
    card.className = "status-card";
    card.hidden = true;
    const dismiss = createButton({ label: "Dismiss message", icon: "x" });
    dismiss.className = "status-dismiss";
    listen(dismiss, "click", () => {
      if (node.classList.contains("is-error")) return;
      const restore = statusReturnFocus;
      statusDismissed.set(node, `${node.className}|${node.textContent}`);
      updateStatusMessages();
      if (
        restore?.isConnected &&
        restore.getClientRects().length &&
        !restore.closest<HTMLElement>("[hidden], [inert]")
      ) {
        restore.focus({ preventScroll: true });
      }
    });
    card.append(node, dismiss);
    statusMessageList.append(card);
    statusCards.set(node, { card, dismiss });
  }
  alerts.remove();
  statusResize = new ResizeObserver(scheduleStatusPosition);
  const resize = statusResize;
  onApplicationDispose(() => resize.disconnect());
  statusResize.observe(statusNotices);
  listen(statusToggle, "click", () => {
    statusExpanded = !(statusExpanded ?? !statusOverlayContext);
    updateStatusMessages();
  });
  listen(statusNotices, "keydown", (event) => {
    if (event.key !== "Escape" || !(statusExpanded ?? !statusOverlayContext)) return;
    event.preventDefault();
    event.stopPropagation();
    statusExpanded = false;
    updateStatusMessages();
  });
  listen(document, "focusin", (event) => {
    if (!(event.target instanceof Element)) return;

    if (
      event.target instanceof HTMLElement &&
      !event.target.matches("body, html, dialog") &&
      !statusNotices.contains(event.target)
    )
      statusReturnFocus = event.target;
  });
  listen(document, "click", scheduleStatusPosition);
  listen(
    document,
    "toggle",
    (event) => {
      if (!(event.target instanceof Element)) return;

      if (event.target.matches?.(".popup-panel") && statusNotices.matches(":popover-open")) updateStatusMessages();
    },
    true,
  );
  listen(document, "folio-node-panel-layout", () => {
    if (statusNotices.matches(":popover-open")) updateStatusMessages();
  });
  listen(window, "resize", scheduleStatusPosition);
  if (window.visualViewport) listen(window.visualViewport, "resize", scheduleStatusPosition);
  const statusObserver = new MutationObserver(updateStatusMessages);
  onApplicationDispose(() => statusObserver.disconnect());
  statusObserver.observe(statusMessageList, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["hidden", "class", "data-status-suspended"],
  });
  for (const dialog of document.querySelectorAll<HTMLDialogElement>("dialog")) {
    statusObserver.observe(dialog, { attributes: true, attributeFilter: ["open"] });
    listen(dialog, "close", () => {
      for (const [node, origin] of statusOrigins) if (origin === dialog) notice(node, "");
    });
  }
}
export function suspendStatusNotice(node: HTMLElement, token: string): void {
  statusSuspensions.set(node, { token, text: node.textContent, className: node.className });
  node.setAttribute("data-status-suspended", token);
}

export function resumeStatusNotice(node: HTMLElement, token: string): void {
  if (statusSuspensions.get(node)?.token !== token) return;
  statusSuspensions.delete(node);
  node.removeAttribute("data-status-suspended");
}

function setStatusHidden(node: HTMLElement, hidden: boolean): void {
  if (node.hidden !== hidden) node.hidden = hidden;
}

function statusAvoidTarget() {
  return (
    [...document.querySelectorAll<HTMLElement>("[data-notice-avoid]:not([hidden]), .popup-panel:popover-open")].find(
      (node) => node.getClientRects().length,
    ) ?? null
  );
}

function positionStatusMessages(): void {
  statusPositionFrame = 0;
  if (!statusNotices.matches(":popover-open")) return;
  const viewportTop = window.visualViewport?.offsetTop ?? 0;
  const viewportBottom = Math.min(innerHeight, viewportTop + (window.visualViewport?.height ?? innerHeight));
  let right = innerWidth > 650 ? 22 : 14;
  let width = Math.min(360, innerWidth - 28);
  let bottom = innerHeight - viewportBottom + 18;
  let maxHeight = Math.min((viewportBottom - viewportTop) * 0.5, viewportBottom - viewportTop - 28);
  const modal = document.querySelector<HTMLDialogElement>("dialog:modal");
  if (modal) {
    const bounds = modal.getBoundingClientRect();
    const sideSpace = innerWidth - bounds.right - 28;
    if (sideSpace >= 280) width = Math.min(width, sideSpace);
    else {
      width = Math.min(width, bounds.width - 24);
      right = Math.max(14, innerWidth - bounds.right + 12);
      const actions = [...modal.querySelectorAll<HTMLElement>(".settings-actions, .dialog-actions")]
        .filter((node) => node.getClientRects().length && !node.closest<HTMLElement>("[hidden], [inert]"))
        .at(-1);
      const actionTop = actions?.getBoundingClientRect().top ?? bounds.bottom - 12;
      bottom = Math.max(bottom, innerHeight - actionTop + 8);
      maxHeight = Math.min(maxHeight, actionTop - Math.max(viewportTop + 12, bounds.top + 68) - 16);
    }
  } else {
    const avoid = statusAvoidTarget() ?? (!element("auth-screen").hidden ? element("auth-submit") : null);
    if (avoid?.getClientRects().length) {
      const bounds = avoid.getBoundingClientRect();
      const noticeBottom = innerHeight - bottom;
      const noticeTop = noticeBottom - Math.min(maxHeight, statusNotices.offsetHeight);
      if (bounds.right > innerWidth - right - width && bounds.top < noticeBottom && bounds.bottom > noticeTop) {
        if (avoid.classList.contains("popup-panel")) {
          width = Math.min(width, Math.max(100, bounds.left - 28));
          right = Math.min(innerWidth - width - 14, innerWidth - bounds.left + 14);
        } else {
          bottom = Math.max(bottom, innerHeight - bounds.top + 8);
          maxHeight = Math.min(maxHeight, bounds.top - viewportTop - 24);
        }
      }
    }
  }
  if (modal && statusNotices.dataset.summaryOnly === "true") {
    const bounds = modal.getBoundingClientRect();
    if (viewportBottom - bounds.bottom >= 40) {
      right = Math.max(14, innerWidth - bounds.right + 12);
      width = Math.min(240, bounds.width - 24);
      bottom = innerHeight - bounds.bottom - 36;
      maxHeight = 28;
    }
  }
  const positions: ["right" | "width" | "bottom" | "maxHeight", string][] = [
    ["right", `${right}px`],
    ["width", `${Math.max(100, width)}px`],
    ["bottom", `${bottom}px`],
    ["maxHeight", `${Math.max(48, maxHeight)}px`],
  ];
  for (const [name, value] of positions) if (statusNotices.style[name] !== value) statusNotices.style[name] = value;
}

function scheduleStatusPosition(): void {
  if (!statusPositionFrame && statusNotices.matches(":popover-open")) {
    statusPositionFrame = requestAnimationFrame(positionStatusMessages);
  }
}

const slowSaveMs = 2500;
let savingSince = 0;
let savingTimer: number | null = null;

/** Routine saves finish quietly; the save status only surfaces when a save is taking unusually long. */
function quietSave(node: HTMLElement) {
  if (node !== element("dirty-indicator") || node.dataset.state !== "saving") return false;
  savingSince ||= performance.now();
  if (performance.now() - savingSince >= slowSaveMs) return false;
  savingTimer ??= window.setTimeout(() => {
    savingTimer = null;
    updateStatusMessages();
  }, slowSaveMs);
  return true;
}

function updateStatusMessages(): void {
  if (element("dirty-indicator").dataset.state !== "saving") savingSince = 0;
  // With nothing to show and nothing showing, skip the document-wide lookups below: this runs on
  // every keystroke, and they walk the whole page, including a long note.
  if (!statusNotices.matches(":popover-open")) {
    let pending = false;
    for (const [node, { card }] of statusCards) {
      if (node.hidden || !node.textContent) {
        statusDismissed.delete(node);
        setStatusHidden(card, true);
      } else if (!quietSave(node)) pending = true;
    }
    if (!pending) return;
  }
  const modal = document.querySelector<HTMLDialogElement>("dialog:modal");
  const context = modal ?? statusAvoidTarget() ?? (!element("auth-screen").hidden ? element("auth-screen") : null);
  if (statusOverlayContext !== context || statusModal !== modal) {
    statusOverlayContext = context;
    statusModal = modal;
    statusExpanded = null;
    statusResize.disconnect();
    statusResize.observe(statusNotices);
    if (context) statusResize.observe(context);
    // A dialog may still be settling into place; place the messages again once it has.
    window.setTimeout(scheduleStatusPosition, 250);
  }
  const messages = [];
  for (const [node, { card, dismiss }] of statusCards) {
    if (node.hidden || !node.textContent) {
      statusDismissed.delete(node);
      setStatusHidden(card, true);
      continue;
    }
    if (quietSave(node)) {
      setStatusHidden(card, true);
      continue;
    }
    if (node.hasAttribute("data-status-suspended")) {
      const suspended = statusSuspensions.get(node);
      if (suspended?.text === node.textContent && suspended.className === node.className) {
        setStatusHidden(card, true);
        continue;
      }
      statusSuspensions.delete(node);
      node.removeAttribute("data-status-suspended");
    }
    const error = node.classList.contains("is-error");
    const origin = statusOrigins.get(node);
    if (modal && !error && !node.classList.contains("is-warning") && origin !== modal) {
      setStatusHidden(card, true);
      continue;
    }
    const dismissed = !error && statusDismissed.get(node) === `${node.className}|${node.textContent}`;
    if (dismissed) {
      setStatusHidden(card, true);
      continue;
    }
    messages.push({ node, card, error });
    card.dataset.tone = error ? "error" : node.classList.contains("is-warning") ? "warning" : "info";
    setStatusHidden(dismiss, error);
  }
  const others = messages.filter((message) => !message.error).length;
  // Messages are always shown in full; there is no collapsed summary to expand.
  const expanded = true;
  const summaryOnly = messages.length > 0 && others === messages.length && !expanded;
  if (statusNotices.dataset.summaryOnly !== String(summaryOnly)) {
    statusNotices.dataset.summaryOnly = String(summaryOnly);
  }
  const label = `${others} ${messages.length > others ? "other " : ""}message${others === 1 ? "" : "s"}`;
  if (statusCount.textContent !== label) statusCount.textContent = label;
  statusToggle.setAttribute("aria-expanded", String(expanded));
  setStatusHidden(statusToggle, true);
  for (const { card, error } of messages) setStatusHidden(card, !error && !expanded);
  setStatusHidden(statusMessageList, !messages.some((message) => message.error || expanded));
  const parent = modal ?? document.body;
  if (statusNotices.parentElement !== parent) {
    if (statusNotices.matches(":popover-open")) statusNotices.hidePopover();
    parent.append(statusNotices);
  }
  const urgent = messages.some(({ node, error }) => {
    const origin = statusOrigins.get(node);
    return error && (origin?.open || (origin === element("auth-screen") && !origin.hidden));
  });
  const role = urgent ? "alert" : "status";
  if (statusNotices.getAttribute("role") !== role) statusNotices.setAttribute("role", role);
  const open = statusNotices.matches(":popover-open");
  if (messages.length && !open) statusNotices.showPopover();
  else if (!messages.length && open) statusNotices.hidePopover();
  scheduleStatusPosition();
}
