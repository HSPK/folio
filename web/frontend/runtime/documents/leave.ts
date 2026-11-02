import type { LeaveConfirmation } from "../../services/document-transitions";
import { appState } from "../core/bootstrap";
import { presenceState } from "../collaboration/presence";
import { confirmAction, hasDialogConfirmation } from "../dialogs/dialogs";
import { resumeStatusNotice, suspendStatusNotice } from "../navigation/status";

/** Project transition policy onto one existing dialog; the coordinator owns its cancellation. */
export async function confirmDocumentLeave(request: LeaveConfirmation, owner: AbortSignal) {
  const { action, policy, snapshot, signal } = request;
  if (policy === "discard")
    return confirmAction(`“${snapshot.path}” has unsaved changes. Discard them and ${action}?`, {
      label: "Discard changes",
      signal,
    });
  const open = document.querySelector<HTMLDialogElement>("dialog[open]");
  if (open && hasDialogConfirmation(open)) return false;
  const failures = [
    appState.ui.documentMessage,
    appState.ui.conflictMessage,
    presenceState.collaborationUi.message,
    appState.ui.sizeWarning,
    appState.ui.rootWarning,
    appState.ui.connectionMessage,
  ].filter((node) => !node.hidden && node.textContent);
  const detail = failures.map((node) => node.textContent).join("\n");
  const suspension = crypto.randomUUID();
  for (const node of failures) suspendStatusNotice(node, suspension);
  try {
    return await confirmAction(
      snapshot.conflict
        ? `${detail || "The disk version changed. Your local edits were not saved."}\n\nKeep editing to resolve the conflict, or discard this local version and ${action}?`
        : `${detail || `The changes in “${snapshot.path}” could not be saved or confirmed.`}\n\nRetry saving before you ${action}, or keep editing.`,
      {
        label: snapshot.conflict ? "Discard and continue" : "Retry save",
        cancelLabel: "Keep editing",
        alternativeLabel: snapshot.conflict ? null : "Discard and continue",
        signal,
      },
    );
  } finally {
    if (!owner.aborted) for (const node of failures) resumeStatusNotice(node, suspension);
  }
}
