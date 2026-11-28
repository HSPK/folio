import type { ConfirmationChoice } from "../../types/domain";
import { element, htmlChildren, requiredQuery } from "../../types/elements";
import { closeMenus } from "../accounts/authentication";
import { listen, onApplicationDispose } from "../lifecycle";

let dialogParents: WeakMap<HTMLDialogElement, HTMLDialogElement>;
let dialogTransitions: WeakSet<HTMLDialogElement>;
let registeredDialogs: WeakSet<HTMLDialogElement>;
let dialogConfirmations: WeakMap<
  HTMLDialogElement,
  {
    region: HTMLElement;
    inert: [HTMLElement, boolean][];
    focus: Element | null;
    resolve: (choice: ConfirmationChoice) => void;
    cleanup: () => void;
  }
>;
let confirmationDialog: HTMLDialogElement | null;

export function initializeDialogsDialogs(): void {
  dialogParents = new WeakMap();
  dialogTransitions = new WeakSet();
  registeredDialogs = new WeakSet();
  dialogConfirmations = new WeakMap();
  confirmationDialog = element("confirmation-dialog");
  onApplicationDispose(closeAllDialogs);
  for (const dialog of document.querySelectorAll<HTMLDialogElement>("dialog")) registerDialog(dialog);
}
export function showDialog(
  dialog: HTMLDialogElement,
  { restoreParent = false }: { restoreParent?: boolean } = {},
): void {
  if (dialog.open) return;
  closeMenus();
  registerDialog(dialog);
  dialogParents.delete(dialog);
  const current = document.querySelector<HTMLDialogElement>("dialog[open]");
  if (current) {
    if (restoreParent) dialogParents.set(dialog, current);
    dialogTransitions.add(current);
    current.close();
  }
  dialog.showModal();
}

export function closeAllDialogs(): void {
  for (const dialog of document.querySelectorAll<HTMLDialogElement>("dialog")) {
    settleDialogConfirmation(dialog, false);
    dialogParents.delete(dialog);
    if (dialog.open) {
      dialogTransitions.add(dialog);
      dialog.close();
    }
  }
}

function registerDialog(dialog: HTMLDialogElement): void {
  if (registeredDialogs.has(dialog)) return;
  registeredDialogs.add(dialog);
  listen(
    dialog,
    "cancel",
    (event) => {
      if (!hasDialogConfirmation(dialog)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      settleDialogConfirmation(dialog, false);
    },
    true,
  );
  listen(dialog, "close", () => {
    settleDialogConfirmation(dialog, false);
    if (dialogTransitions.delete(dialog)) return;
    const parent = dialogParents.get(dialog);
    dialogParents.delete(dialog);
    if (
      parent?.isConnected &&
      element("auth-screen").hidden &&
      !document.querySelector<HTMLDialogElement>("dialog[open]")
    ) {
      parent.showModal();
      parent.dispatchEvent(new Event("dialogrestore"));
    }
  });
}

export function hasDialogConfirmation(dialog: HTMLDialogElement | null) {
  return dialog !== null && dialogConfirmations.has(dialog);
}

export function settleDialogConfirmation(
  dialog: HTMLDialogElement | null,
  accepted: ConfirmationChoice,
  { restoreFocus = true } = {},
): void {
  if (!dialog) return;
  const pending = dialogConfirmations.get(dialog);
  if (!pending) return;
  dialogConfirmations.delete(dialog);
  pending.cleanup();
  delete dialog.dataset.confirmation;
  pending.region.hidden = true;
  for (const [node, inert] of pending.inert) node.inert = inert;
  dialog.dispatchEvent(new Event("confirmationchange"));
  if (dialog === confirmationDialog && dialog.open) dialog.close();
  else if (
    restoreFocus &&
    pending.focus?.isConnected &&
    (pending.focus instanceof HTMLElement || pending.focus instanceof SVGElement)
  )
    pending.focus.focus();
  pending.resolve(accepted);
}

export function confirmAction(
  message: string,
  {
    label = "Continue",
    cancelLabel = "Cancel",
    alternativeLabel = null,
    dialog = document.querySelector<HTMLDialogElement>("dialog[open]"),
    signal,
  }: {
    label?: string | null;
    cancelLabel?: string | null;
    alternativeLabel?: string | null;
    dialog?: HTMLDialogElement | null;
    signal?: AbortSignal;
  } = {},
) {
  if (signal?.aborted) return Promise.resolve(false);
  if (!dialog) {
    if (!confirmationDialog) {
      confirmationDialog = document.createElement("dialog");
      confirmationDialog.id = "confirmation-dialog";
      confirmationDialog.className = "confirmation-dialog";
      confirmationDialog.setAttribute("aria-labelledby", "confirmation-title");
      const title = document.createElement("h2");
      title.id = "confirmation-title";
      title.textContent = "Confirm action";
      confirmationDialog.append(title);
      document.body.append(confirmationDialog);
    }
    dialog = confirmationDialog;
    showDialog(dialog);
  }
  if (hasDialogConfirmation(dialog)) return Promise.resolve(false);
  let region = dialog.querySelector<HTMLElement>("[data-confirmation-region]");
  if (!region) {
    region = document.createElement("section");
    region.className = "project-confirm";
    region.dataset.confirmationRegion = "";
    region.setAttribute("role", "alert");
    const text = document.createElement("p");
    text.dataset.confirmationMessage = "";
    const actions = document.createElement("div");
    actions.className = "dialog-actions";
    for (const accepted of [false, true]) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset[accepted ? "confirmationProceed" : "confirmationCancel"] = "";
      if (accepted) button.className = "button-primary";
      else button.textContent = "Cancel";
      button.addEventListener("click", () => settleDialogConfirmation(dialog, accepted));
      actions.append(button);
    }
    region.append(text, actions);
    const container = htmlChildren(dialog).find((node) => node.tagName === "FORM" && !node.hidden) ?? dialog;
    const heading = container.querySelector<HTMLElement>(":scope > header, :scope > h2");
    if (heading) heading.after(region);
    else container.prepend(region);
  }
  requiredQuery(region, "[data-confirmation-message]", HTMLElement).textContent = message;
  requiredQuery(region, "[data-confirmation-proceed]", HTMLElement).textContent = label;
  requiredQuery(region, "[data-confirmation-cancel]", HTMLElement).textContent = cancelLabel;
  let alternative = region.querySelector<HTMLButtonElement>("[data-confirmation-alternative]");
  if (alternativeLabel && !alternative) {
    alternative = document.createElement("button");
    alternative.type = "button";
    alternative.dataset.confirmationAlternative = "";
    alternative.addEventListener("click", () => settleDialogConfirmation(dialog, "discard"));
    requiredQuery(region, "[data-confirmation-proceed]", HTMLElement).before(alternative);
  }
  if (alternative) {
    alternative.hidden = !alternativeLabel;
    alternative.textContent = alternativeLabel ?? "";
  }
  return new Promise<ConfirmationChoice>((resolve) => {
    const parent = region.parentElement;
    if (!parent) throw new Error("The confirmation surface is no longer attached.");
    const inert = htmlChildren(parent)
      .filter(
        (node): node is HTMLElement => node instanceof HTMLElement && node !== region && node.tagName !== "HEADER",
      )
      .map((node): [HTMLElement, boolean] => [node, node.inert]);
    const abort = () => settleDialogConfirmation(dialog, false, { restoreFocus: false });
    const cleanup = () => signal?.removeEventListener("abort", abort);
    dialogConfirmations.set(dialog, { region, inert, resolve, cleanup, focus: document.activeElement });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    dialog.dataset.confirmation = "open";
    for (const [node] of inert) node.inert = true;
    region.hidden = false;
    dialog.dispatchEvent(new Event("confirmationchange"));
    requiredQuery(region, "[data-confirmation-cancel]", HTMLElement).focus();
  });
}
