import { authenticationSession } from "../../state/authentication";
import { documentSession } from "../../state/document";
import { decodedParticipation } from "../../api/contracts";
import { createSaveSnapshot } from "@folio/model";
import type { Participation } from "../../types/domain";
import { clearTimer, requireValue } from "../../types/elements";
import { errorContext } from "../../types/errors";
import { refreshControls } from "../accounts/authentication";
import { api } from "../core/api";
import { appState, dirty } from "../core/bootstrap";
import { ApiError, aborted } from "../core/dom";
import { persistCurrentDraft, recoverDocumentDraft, showDraftRecovery } from "../documents/drafts";
import { acceptDocumentPermissions, resourceState } from "../documents/resources";
import { rememberUnconfirmedSave, saveDocument } from "../documents/saving";
import { listen, onApplicationDispose } from "../lifecycle";
import { publicState, requestPublicPassword } from "../sharing/public";
import { collaborationState, connectCollaboration, startCollaboration, stopCollaboration } from "./collaboration";
import { collaborationNotice, renderCollaborators } from "./presence";
class ParticipationState {
  documentParticipation!: Participation | null;
}
export const participationState = new ParticipationState();
export function initializeCollaborationParticipation(): void {
  participationState.documentParticipation = null;
  onApplicationDispose(stopDocumentParticipation);
  listen(document, "compositionstart", (event) => {
    if (!(event.target instanceof Element)) return;
    if (participationState.documentParticipation && collaborationState.collaborativeTarget(event.target))
      participationState.documentParticipation.composing = true;
  });
  listen(document, "compositionend", (event) => {
    if (!(event.target instanceof Element)) return;
    if (participationState.documentParticipation && collaborationState.collaborativeTarget(event.target)) {
      const current = participationState.documentParticipation;
      window.setTimeout(() => {
        if (current === participationState.documentParticipation) current.composing = false;
      }, 0);
    }
  });
  listen(window, "focus", () => void pollDocumentParticipation());
  listen(window, "pagehide", () => stopDocumentParticipation());
}
export function stopDocumentParticipation({
  notify = true,
}: {
  notify?: boolean;
} = {}): void {
  const current = participationState.documentParticipation;
  participationState.documentParticipation = null;
  if (!current) return;
  clearTimer(current.timer);
  current.controller?.abort();
  if (notify && current.participant) {
    void api("/api/collaboration/presence", {
      method: "POST",
      keepalive: true,
      body: { document: current.resource, participant: current.participant, leave: true },
    }).catch((error) => console.warn("Document participation will expire after disconnect.", error.message));
  }
}
export async function startDocumentParticipation({
  participant = null,
  ready = false,
}: {
  participant?: string | null;
  ready?: boolean;
} = {}): Promise<void> {
  if (!documentSession.current || (authenticationSession.mode !== "users" && !publicState.publicView)) {
    void recoverDocumentDraft();
    return;
  }
  const current = {
    id: documentSession.id,
    resource: documentSession.current.id,
    path: documentSession.current.path,
    participant,
    ready,
    preparing: false,
    composing: false,
    timer: null,
    controller: null,
    polling: false,
    recoveryRecord: null,
    resumeSnapshot: collaborationState.collaboration?.initialized
      ? {
          snapshot: createSaveSnapshot(documentSession.current, appState.ui.editor.value),
          id: documentSession.id,
          root: documentSession.current.root,
        }
      : null,
  };
  participationState.documentParticipation = current;
  if (!collaborationState.collaboration?.initialized) await recoverDocumentDraft();
  if (current === participationState.documentParticipation) await pollDocumentParticipation(current);
}
export async function pollDocumentParticipation(
  current: Participation | null = participationState.documentParticipation,
): Promise<void> {
  if (!current || current !== participationState.documentParticipation || current.polling) return;
  clearTimer(current.timer);
  current.polling = true;
  current.controller = new AbortController();
  let delay = 1000;
  try {
    const status = await api("/api/collaboration/presence", {
      decode: decodedParticipation,
      method: "POST",
      signal: current.controller.signal,
      body: { document: current.resource, participant: current.participant, ready: current.ready },
    });
    if (current !== participationState.documentParticipation || current.id !== documentSession.id) return;
    if (
      !["solo", "prepare", "join"].includes(status.phase) ||
      (status.participant !== null && !/^[a-f0-9]{48}$/.test(status.participant ?? ""))
    ) {
      throw new ApiError("The service returned incomplete document participation.");
    }
    current.participant = status.participant;
    const wasPreparing = current.preparing;
    const previousCollaboration = collaborationState.collaboration;
    const permissionsChanged = acceptDocumentPermissions(status.permissions);
    let prepared = false;
    if (
      status.phase === "solo" &&
      current.resumeSnapshot &&
      collaborationState.collaboration &&
      !collaborationState.collaboration.connected
    ) {
      if (dirty()) rememberUnconfirmedSave(current.resumeSnapshot);
      await persistCurrentDraft();
      if (current !== participationState.documentParticipation) return;
      stopCollaboration();
      current.resumeSnapshot = null;
    }
    if (!requireValue(resourceState.documentPermissions).collaborative) {
      delay = 3000;
      current.ready = false;
      current.preparing = false;
      if (collaborationState.collaboration) {
        await persistCurrentDraft();
        if (current !== participationState.documentParticipation) return;
        stopCollaboration();
        collaborationNotice("Shared editing permission was removed. Any unsaved local text is kept.", true);
      }
    } else if (status.phase === "solo" && !collaborationState.collaboration) {
      current.ready = false;
      current.preparing = false;
      collaborationNotice(
        current.recoveryRecord ? "A local collaborative draft is kept. It will merge when shared editing resumes." : "",
      );
    } else if (status.phase === "prepare" && collaborationState.collaboration?.initialized) {
      current.ready = true;
    } else if (
      status.phase === "prepare" &&
      !collaborationState.collaboration &&
      !current.ready &&
      !current.composing &&
      !documentSession.conflict &&
      !appState.element("draft-recovery-dialog").open
    ) {
      prepared = true;
      current.preparing = true;
      refreshControls();
      await persistCurrentDraft();
      if (current !== participationState.documentParticipation) return;
      if (current.recoveryRecord && dirty()) {
        showDraftRecovery(current.recoveryRecord);
        current.preparing = false;
        refreshControls();
        return;
      }
      if (dirty() && !documentSession.saving && !documentSession.conflict) await saveDocument(true);
      if (current !== participationState.documentParticipation) return;
      current.ready = !dirty() && !documentSession.saving && !documentSession.conflict;
      if (!current.ready) current.preparing = false;
      collaborationNotice(
        current.ready
          ? "Another authorized editor is here. Waiting for saved drafts before shared editing…"
          : "Shared editing is waiting. Save or resolve this local draft first.",
        !current.ready,
      );
      delay = current.ready ? 150 : 1000;
    } else if (status.phase === "join") {
      current.preparing = false;
      current.resumeSnapshot = null;
      if (!collaborationState.collaboration) await startCollaboration();
      else if (
        !collaborationState.collaboration.connected &&
        !collaborationState.collaboration.connecting &&
        !collaborationState.collaboration.unmerged &&
        !collaborationState.collaboration.failed
      ) {
        await connectCollaboration(collaborationState.collaboration);
      }
    }
    if (
      prepared ||
      permissionsChanged ||
      wasPreparing !== current.preparing ||
      previousCollaboration !== collaborationState.collaboration
    ) {
      renderCollaborators();
      refreshControls();
    }
  } catch (errorCause) {
    const error = errorContext(errorCause);
    if (current !== participationState.documentParticipation || aborted(error)) return;
    current.ready = false;
    current.preparing = false;
    if (error.status === 410) {
      current.participant = null;
      collaborationNotice("Document presence expired; reconnecting…");
      refreshControls();
      delay = 150;
      return;
    }
    if ([401, 403, 404].includes(error.status)) {
      acceptDocumentPermissions({ writable: false, collaborative: false, owner: false });
      if (collaborationState.collaboration) {
        await persistCurrentDraft().catch((failure) =>
          console.error("Could not persist the revoked session's draft.", failure),
        );
        if (current !== participationState.documentParticipation) return;
        stopCollaboration();
      }
      if (publicState.publicView && error.status === 401) requestPublicPassword();
    }
    collaborationNotice(`Document access could not be refreshed: ${error.message} Local text is kept.`, true);
    refreshControls();
    delay = 3000;
  } finally {
    current.polling = false;
    if (current === participationState.documentParticipation)
      current.timer = window.setTimeout(() => void pollDocumentParticipation(current), delay);
  }
}
