import { requiredQuery } from "../../types/elements";

import { createIcon } from "@folio/editor-runtime";
import { appState } from "../core/bootstrap";
import { notice } from "../core/dom";
import { listen, onApplicationDispose } from "../lifecycle";

class StatusState {
  statusNotices!: HTMLDivElement;
  statusToggle!: HTMLButtonElement;
  statusCount!: HTMLSpanElement;
  statusMessageList!: HTMLDivElement;
  statusOrigins!: Map<HTMLElement, (HTMLElement & { open?: boolean }) | null>;
  statusCards!: Map<HTMLElement, { card: HTMLDivElement; dismiss: HTMLButtonElement }>;
  statusDismissed!: WeakMap<HTMLElement, string>;
  statusSuspensions!: WeakMap<HTMLElement, { token: string; text: string | null; className: string }>;
  statusExpanded!: boolean | null;
  statusModal!: HTMLDialogElement | null;
  statusOverlayContext!: HTMLElement | null;
  statusPositionFrame!: number | null;
  statusReturnFocus!: HTMLElement | null;
  statusResize!: ResizeObserver;
  statusObserver!: MutationObserver;
}
export const statusState = new StatusState();
export function initializeNavigationStatus(): void {
  statusState.statusNotices = document.createElement("div");
  statusState.statusNotices.className = "status-notices";
  statusState.statusNotices.id = "status-notices";
  statusState.statusNotices.setAttribute("popover", "manual");
  statusState.statusNotices.setAttribute("aria-label", "Status messages");
  statusState.statusNotices.setAttribute("role", "status");
  statusState.statusNotices.dataset.preserveNodeTools = "";
  statusState.statusToggle = document.createElement("button");
  statusState.statusToggle.type = "button";
  statusState.statusToggle.className = "status-toggle";
  statusState.statusToggle.setAttribute("aria-label", "Toggle status messages");
  statusState.statusToggle.setAttribute("aria-controls", "status-message-list");
  statusState.statusCount = document.createElement("span");
  statusState.statusToggle.append(statusState.statusCount, createIcon("chevron-down"));
  statusState.statusMessageList = document.createElement("div");
  statusState.statusMessageList.id = "status-message-list";
  statusState.statusMessageList.className = "status-message-list";
  statusState.statusNotices.append(statusState.statusToggle, statusState.statusMessageList);
  document.body.append(statusState.statusNotices);
  const notices = statusState.statusNotices;
  onApplicationDispose(() => {
    if (statusState.statusPositionFrame) cancelAnimationFrame(statusState.statusPositionFrame);
    notices.remove();
  });
  const alerts = requiredQuery(document, ".document-alerts", HTMLElement);
  const alertsHome = document.createComment("folio-alerts");
  alerts.before(alertsHome);
  onApplicationDispose(() => alertsHome.replaceWith(alerts));
  statusState.statusOrigins = new Map();
  statusState.statusCards = new Map();
  statusState.statusDismissed = new WeakMap();
  statusState.statusSuspensions = new WeakMap();
  statusState.statusExpanded = null;
  statusState.statusModal = null;
  statusState.statusOverlayContext = null;
  statusState.statusPositionFrame = 0;
  statusState.statusReturnFocus = null;
  for (const node of new Set(
    [
      ...document.querySelectorAll<HTMLElement>(".document-alerts > *"),
      ...document.querySelectorAll<HTMLDialogElement>("dialog .notice"),
      appState.ui.authError,
      ...document.querySelectorAll<HTMLElement>("[data-status-source]"),
      appState.ui.dirty,
      appState.ui.connectionLabel,
      appState.ui.documentMessage,
      appState.ui.treeMessage,
      appState.ui.treeLimit,
      appState.ui.previewStatus,
    ].filter((node) => !node.hasAttribute("data-inline-status")),
  )) {
    const home = document.createComment("folio-status");
    node.before(home);
    onApplicationDispose(() => home.replaceWith(node));
    node.classList.remove("visually-hidden");
    statusState.statusOrigins.set(node, node.closest<HTMLElement>("dialog, #auth-screen"));
    const card = document.createElement("div");
    card.className = "status-card";
    card.hidden = true;
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "status-dismiss";
    dismiss.setAttribute("aria-label", "Dismiss message");
    dismiss.append(createIcon("x"));
    listen(dismiss, "click", () => {
      if (node.classList.contains("is-error")) return;
      const restore = statusState.statusReturnFocus;
      statusState.statusDismissed.set(node, `${node.className}|${node.textContent}`);
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
    statusState.statusMessageList.append(card);
    statusState.statusCards.set(node, { card, dismiss });
  }
  alerts.remove();
  statusState.statusResize = new ResizeObserver(scheduleStatusPosition);
  const statusResize = statusState.statusResize;
  onApplicationDispose(() => statusResize.disconnect());
  statusState.statusResize.observe(statusState.statusNotices);
  listen(statusState.statusToggle, "click", () => {
    statusState.statusExpanded = !(statusState.statusExpanded ?? !statusState.statusOverlayContext);
    updateStatusMessages();
  });
  listen(statusState.statusNotices, "keydown", (event) => {
    if (event.key !== "Escape" || !(statusState.statusExpanded ?? !statusState.statusOverlayContext)) return;
    event.preventDefault();
    event.stopPropagation();
    statusState.statusExpanded = false;
    updateStatusMessages();
  });
  listen(document, "focusin", (event) => {
    if (!(event.target instanceof Element)) return;

    if (
      event.target instanceof HTMLElement &&
      !event.target.matches("body, html, dialog") &&
      !statusState.statusNotices.contains(event.target)
    )
      statusState.statusReturnFocus = event.target;
  });
  listen(document, "click", scheduleStatusPosition);
  listen(
    document,
    "toggle",
    (event) => {
      if (!(event.target instanceof Element)) return;

      if (event.target.matches?.(".popup") && statusState.statusNotices.matches(":popover-open"))
        updateStatusMessages();
    },
    true,
  );
  listen(document, "folio-node-panel-layout", () => {
    if (statusState.statusNotices.matches(":popover-open")) updateStatusMessages();
  });
  listen(window, "resize", scheduleStatusPosition);
  if (window.visualViewport) listen(window.visualViewport, "resize", scheduleStatusPosition);
  statusState.statusObserver = new MutationObserver(updateStatusMessages);
  const statusObserver = statusState.statusObserver;
  onApplicationDispose(() => statusObserver.disconnect());
  statusState.statusObserver.observe(statusState.statusMessageList, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["hidden", "class", "data-status-suspended"],
  });
  for (const dialog of document.querySelectorAll<HTMLDialogElement>("dialog")) {
    statusState.statusObserver.observe(dialog, { attributes: true, attributeFilter: ["open"] });
    listen(dialog, "close", () => {
      for (const [node, origin] of statusState.statusOrigins) if (origin === dialog) notice(node, "");
    });
  }
}
export function suspendStatusNotice(node: HTMLElement, token: string): void {
  statusState.statusSuspensions.set(node, { token, text: node.textContent, className: node.className });
  node.setAttribute("data-status-suspended", token);
}

export function resumeStatusNotice(node: HTMLElement, token: string): void {
  if (statusState.statusSuspensions.get(node)?.token !== token) return;
  statusState.statusSuspensions.delete(node);
  node.removeAttribute("data-status-suspended");
}

export function setStatusHidden(node: HTMLElement, hidden: boolean): void {
  if (node.hidden !== hidden) node.hidden = hidden;
}

export function statusAvoidTarget() {
  return (
    [...document.querySelectorAll<HTMLElement>("[data-notice-avoid]:not([hidden]), .popup[open] .popup-panel")].find(
      (node) => node.getClientRects().length,
    ) ?? null
  );
}

export function positionStatusMessages(): void {
  statusState.statusPositionFrame = 0;
  if (!statusState.statusNotices.matches(":popover-open")) return;
  const viewportTop = window.visualViewport?.offsetTop ?? 0;
  const viewportBottom = Math.min(innerHeight, viewportTop + (window.visualViewport?.height ?? innerHeight));
  let right = 14;
  let width = Math.min(420, innerWidth - 28);
  let bottom = innerHeight - viewportBottom + 42;
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
    const avoid = statusAvoidTarget() ?? (!appState.ui.authScreen.hidden ? appState.ui.authSubmit : null);
    if (avoid?.getClientRects().length) {
      const bounds = avoid.getBoundingClientRect();
      const noticeBottom = innerHeight - bottom;
      const noticeTop = noticeBottom - Math.min(maxHeight, statusState.statusNotices.offsetHeight);
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
  if (modal && statusState.statusNotices.dataset.summaryOnly === "true") {
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
  for (const [name, value] of positions)
    if (statusState.statusNotices.style[name] !== value) statusState.statusNotices.style[name] = value;
}

export function scheduleStatusPosition(): void {
  if (!statusState.statusPositionFrame && statusState.statusNotices.matches(":popover-open")) {
    statusState.statusPositionFrame = requestAnimationFrame(positionStatusMessages);
  }
}

export function updateStatusMessages(): void {
  const modal = document.querySelector<HTMLDialogElement>("dialog:modal");
  const context = modal ?? statusAvoidTarget() ?? (!appState.ui.authScreen.hidden ? appState.ui.authScreen : null);
  if (statusState.statusOverlayContext !== context || statusState.statusModal !== modal) {
    statusState.statusOverlayContext = context;
    statusState.statusModal = modal;
    statusState.statusExpanded = null;
    statusState.statusResize.disconnect();
    statusState.statusResize.observe(statusState.statusNotices);
    if (context) statusState.statusResize.observe(context);
  }
  const messages = [];
  for (const [node, { card, dismiss }] of statusState.statusCards) {
    if (node.hidden || !node.textContent) {
      statusState.statusDismissed.delete(node);
      setStatusHidden(card, true);
      continue;
    }
    if (node.hasAttribute("data-status-suspended")) {
      const suspended = statusState.statusSuspensions.get(node);
      if (suspended?.text === node.textContent && suspended.className === node.className) {
        setStatusHidden(card, true);
        continue;
      }
      statusState.statusSuspensions.delete(node);
      node.removeAttribute("data-status-suspended");
    }
    const error = node.classList.contains("is-error");
    const origin = statusState.statusOrigins.get(node);
    if (modal && !error && !node.classList.contains("is-warning") && origin !== modal) {
      setStatusHidden(card, true);
      continue;
    }
    const dismissed = !error && statusState.statusDismissed.get(node) === `${node.className}|${node.textContent}`;
    if (dismissed) {
      setStatusHidden(card, true);
      continue;
    }
    messages.push({ node, card, error });
    card.dataset.tone = error ? "error" : node.classList.contains("is-warning") ? "warning" : "info";
    setStatusHidden(dismiss, error);
  }
  const others = messages.filter((message) => !message.error).length;
  const expanded = statusState.statusExpanded ?? !context;
  const summaryOnly = messages.length > 0 && others === messages.length && !expanded;
  if (statusState.statusNotices.dataset.summaryOnly !== String(summaryOnly)) {
    statusState.statusNotices.dataset.summaryOnly = String(summaryOnly);
  }
  const label = `${others} ${messages.length > others ? "other " : ""}message${others === 1 ? "" : "s"}`;
  if (statusState.statusCount.textContent !== label) statusState.statusCount.textContent = label;
  statusState.statusToggle.setAttribute("aria-expanded", String(expanded));
  setStatusHidden(statusState.statusToggle, !others);
  for (const { card, error } of messages) setStatusHidden(card, !error && !expanded);
  setStatusHidden(statusState.statusMessageList, !messages.some((message) => message.error || expanded));
  const parent = modal ?? document.body;
  if (statusState.statusNotices.parentElement !== parent) {
    if (statusState.statusNotices.matches(":popover-open")) statusState.statusNotices.hidePopover();
    parent.append(statusState.statusNotices);
  }
  const urgent = messages.some(({ node, error }) => {
    const origin = statusState.statusOrigins.get(node);
    return error && (origin?.open || (origin === appState.ui.authScreen && !origin.hidden));
  });
  const role = urgent ? "alert" : "status";
  if (statusState.statusNotices.getAttribute("role") !== role) statusState.statusNotices.setAttribute("role", role);
  const open = statusState.statusNotices.matches(":popover-open");
  if (messages.length && !open) statusState.statusNotices.showPopover();
  else if (!messages.length && open) statusState.statusNotices.hidePopover();
  scheduleStatusPosition();
}
