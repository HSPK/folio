import { element } from "../../types/elements";
import type { LeaveConfirmation } from "../../services/document-transitions";
import { confirmAction, hasDialogConfirmation } from "../dialogs/dialogs";
import { resumeStatusNotice, suspendStatusNotice } from "../navigation/status";

/** Project transition policy onto one existing dialog; the coordinator owns its cancellation. */
export async function confirmDocumentLeave(request: LeaveConfirmation, owner: AbortSignal) {
  const { action, policy, snapshot, signal } = request;
  if (policy === "discard")
    return confirmAction(
      snapshot.conflict && action === "reload this note from disk"
        ? "Replace your edits with the latest version?"
        : `Discard unsaved changes and ${action}?`,
      {
        label: snapshot.conflict && action === "reload this note from disk" ? "Use latest" : "Discard changes",
        cancelLabel: "Keep editing",
        tone: "destructive",
        signal,
      },
    );
  const open = document.querySelector<HTMLDialogElement>("dialog[open]");
  if (open && hasDialogConfirmation(open)) return false;
  const failures = [
    element("document-message"),
    element("conflict-message"),
    element("collaboration-message"),
    element("size-warning"),
    element("root-warning"),
    element("connection-message"),
  ].filter((node) => !node.hidden && node.textContent);
  const detail = failures.map((node) => node.textContent).join("\n");
  const suspension = `leave-${performance.now()}`;
  for (const node of failures) suspendStatusNotice(node, suspension);
  try {
    return await confirmAction(
      snapshot.conflict
        ? `Leave your unsaved edits and ${action}?`
        : `${detail || "Changes not saved"}\n\nRetry saving before you ${action}?`,
      {
        label: snapshot.conflict ? "Discard my edits" : "Retry save",
        cancelLabel: "Keep editing",
        alternativeLabel: snapshot.conflict ? null : "Discard and continue",
        signal,
      },
    );
  } finally {
    if (!owner.aborted) for (const node of failures) resumeStatusNotice(node, suspension);
  }
}
