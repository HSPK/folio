import type { ConfirmationChoice } from "../../types/domain";
import { htmlChildren, requiredQuery } from "../../types/elements";
import { closeMenus } from "../accounts/authentication";
import { appState } from "../core/bootstrap";
import { listen, onApplicationDispose } from "../lifecycle";

class DialogState {
  dialogParents!: WeakMap<HTMLDialogElement, HTMLDialogElement>;
  dialogTransitions!: WeakSet<HTMLDialogElement>;
  registeredDialogs!: WeakSet<HTMLDialogElement>;
  dialogConfirmations!: WeakMap<
    HTMLDialogElement,
    {
      region: HTMLElement;
      inert: [HTMLElement, boolean][];
      focus: Element | null;
      resolve: (choice: ConfirmationChoice) => void;
      cleanup: () => void;
    }
  >;
  confirmationDialog!: HTMLDialogElement | null;
}
export const dialogState = new DialogState();
export function initializeDialogsDialogs(): void {
  dialogState.dialogParents = new WeakMap();
  dialogState.dialogTransitions = new WeakSet();
  dialogState.registeredDialogs = new WeakSet();
  dialogState.dialogConfirmations = new WeakMap();
  dialogState.confirmationDialog = appState.element("confirmation-dialog");
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
  dialogState.dialogParents.delete(dialog);
  const current = document.querySelector<HTMLDialogElement>("dialog[open]");
  if (current) {
    if (restoreParent) dialogState.dialogParents.set(dialog, current);
    dialogState.dialogTransitions.add(current);
    current.close();
  }
  dialog.showModal();
}

export function closeAllDialogs(): void {
  for (const dialog of document.querySelectorAll<HTMLDialogElement>("dialog")) {
    settleDialogConfirmation(dialog, false);
    dialogState.dialogParents.delete(dialog);
    if (dialog.open) {
      dialogState.dialogTransitions.add(dialog);
      dialog.close();
    }
  }
}

export function registerDialog(dialog: HTMLDialogElement): void {
  if (dialogState.registeredDialogs.has(dialog)) return;
  dialogState.registeredDialogs.add(dialog);
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
    if (dialogState.dialogTransitions.delete(dialog)) return;
    const parent = dialogState.dialogParents.get(dialog);
    dialogState.dialogParents.delete(dialog);
    if (
      parent?.isConnected &&
      appState.ui.authScreen.hidden &&
      !document.querySelector<HTMLDialogElement>("dialog[open]")
    ) {
      parent.showModal();
      parent.dispatchEvent(new Event("dialogrestore"));
    }
  });
}

export function hasDialogConfirmation(dialog: HTMLDialogElement | null) {
  return dialog !== null && dialogState.dialogConfirmations.has(dialog);
}

export function settleDialogConfirmation(
  dialog: HTMLDialogElement | null,
  accepted: ConfirmationChoice,
  { restoreFocus = true } = {},
): void {
  if (!dialog) return;
  const pending = dialogState.dialogConfirmations.get(dialog);
  if (!pending) return;
  dialogState.dialogConfirmations.delete(dialog);
  pending.cleanup();
  delete dialog.dataset.confirmation;
  pending.region.hidden = true;
  for (const [node, inert] of pending.inert) node.inert = inert;
  dialog.dispatchEvent(new Event("confirmationchange"));
  if (dialog === dialogState.confirmationDialog && dialog.open) dialog.close();
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
    if (!dialogState.confirmationDialog) {
      dialogState.confirmationDialog = document.createElement("dialog");
      dialogState.confirmationDialog.id = "confirmation-dialog";
      dialogState.confirmationDialog.className = "confirmation-dialog";
      dialogState.confirmationDialog.setAttribute("aria-labelledby", "confirmation-title");
      const title = document.createElement("h2");
      title.id = "confirmation-title";
      title.textContent = "Confirm action";
      dialogState.confirmationDialog.append(title);
      document.body.append(dialogState.confirmationDialog);
    }
    dialog = dialogState.confirmationDialog;
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
    dialogState.dialogConfirmations.set(dialog, { region, inert, resolve, cleanup, focus: document.activeElement });
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
