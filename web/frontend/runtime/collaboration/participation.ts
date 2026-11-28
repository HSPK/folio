import { authenticationSession } from "../../state/authentication";
import { documentSession } from "../../state/document";
import { decodedParticipation } from "../../api/contracts";
import { createSaveSnapshot } from "@folio/model";
import type { Participation } from "../../types/domain";
import { element, clearTimer, requireValue } from "../../types/elements";
import { errorContext } from "../../types/errors";
import { connectionFailure, refreshControls } from "../accounts/authentication";
import { connectivity, isConnectionLoss } from "../core/recovery";
import { api } from "../core/api";
import { appState, dirty } from "../core/bootstrap";
import { ApiError, aborted } from "../core/dom";
import { persistCurrentDraft, recoverDocumentDraft, showDraftRecovery } from "../documents/drafts";
import { acceptDocumentPermissions, resourceState } from "../documents/resources";
import { rememberUnconfirmedSave, saveDocument } from "../documents/saving";
import { listen, onApplicationDispose } from "../lifecycle";
import { publicState, requestPublicPassword } from "../sharing/public";
import {
  collaborativeTarget,
  collaboration,
  connectCollaboration,
  startCollaboration,
  stopCollaboration,
} from "./collaboration";
import { collaborationNotice, renderCollaborators } from "./presence";
export let documentParticipation: Participation | null;

export function initializeCollaborationParticipation(): void {
  documentParticipation = null;
  onApplicationDispose(stopDocumentParticipation);
  listen(document, "compositionstart", (event) => {
    if (!(event.target instanceof Element)) return;
    if (documentParticipation && collaborativeTarget(event.target)) documentParticipation.composing = true;
  });
  listen(document, "compositionend", (event) => {
    if (!(event.target instanceof Element)) return;
    if (documentParticipation && collaborativeTarget(event.target)) {
      const current = documentParticipation;
      window.setTimeout(() => {
        if (current === documentParticipation) current.composing = false;
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
  const current = documentParticipation;
  documentParticipation = null;
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
    resumeSnapshot: collaboration?.initialized
      ? {
          snapshot: createSaveSnapshot(documentSession.current, appState.editor.value),
          id: documentSession.id,
          root: documentSession.current.root,
        }
      : null,
  };
  documentParticipation = current;
  if (!collaboration?.initialized) await recoverDocumentDraft();
  if (current === documentParticipation) await pollDocumentParticipation(current);
}
export async function pollDocumentParticipation(current: Participation | null = documentParticipation): Promise<void> {
  if (!current || current !== documentParticipation || current.polling) return;
  clearTimer(current.timer);
  current.polling = true;
  current.controller = new AbortController();
  let delay = 1000;
  try {
    if (connectivity.serviceLost) {
      delay = 3000;
      return;
    }
    const status = await api("/api/collaboration/presence", {
      decode: decodedParticipation,
      method: "POST",
      signal: current.controller.signal,
      body: { document: current.resource, participant: current.participant, ready: current.ready },
    });
    if (current !== documentParticipation || current.id !== documentSession.id) return;
    if (
      !["solo", "prepare", "join"].includes(status.phase) ||
      (status.participant !== null && !/^[a-f0-9]{48}$/.test(status.participant ?? ""))
    ) {
      throw new ApiError("Incomplete participation response");
    }
    current.participant = status.participant;
    const wasPreparing = current.preparing;
    const previousCollaboration = collaboration;
    const permissionsChanged = acceptDocumentPermissions(status.permissions);
    let prepared = false;
    if (status.phase === "solo" && current.resumeSnapshot && collaboration && !collaboration.connected) {
      if (dirty()) rememberUnconfirmedSave(current.resumeSnapshot);
      await persistCurrentDraft();
      if (current !== documentParticipation) return;
      stopCollaboration();
      current.resumeSnapshot = null;
    }
    if (!requireValue(resourceState.documentPermissions).collaborative) {
      delay = 3000;
      current.ready = false;
      current.preparing = false;
      if (collaboration) {
        await persistCurrentDraft();
        if (current !== documentParticipation) return;
        stopCollaboration();
        collaborationNotice("Shared editing permission removed", true);
      }
    } else if (status.phase === "solo" && !collaboration) {
      current.ready = false;
      current.preparing = false;
      collaborationNotice(current.recoveryRecord ? "Local draft kept" : "");
    } else if (status.phase === "prepare" && collaboration?.initialized) {
      current.ready = true;
    } else if (
      status.phase === "prepare" &&
      !collaboration &&
      !current.ready &&
      !current.composing &&
      !documentSession.conflict &&
      !element("draft-recovery-dialog").open
    ) {
      prepared = true;
      current.preparing = true;
      refreshControls();
      await persistCurrentDraft();
      if (current !== documentParticipation) return;
      if (current.recoveryRecord && dirty()) {
        showDraftRecovery(current.recoveryRecord);
        current.preparing = false;
        refreshControls();
        return;
      }
      if (dirty() && !documentSession.saving && !documentSession.conflict) await saveDocument(true);
      if (current !== documentParticipation) return;
      current.ready = !dirty() && !documentSession.saving && !documentSession.conflict;
      if (!current.ready) current.preparing = false;
      collaborationNotice(
        current.ready ? "Waiting for saved drafts…" : "Save local draft to collaborate",
        !current.ready,
      );
      delay = current.ready ? 150 : 1000;
    } else if (status.phase === "join") {
      current.preparing = false;
      current.resumeSnapshot = null;
      if (!collaboration) await startCollaboration();
      else if (
        !collaboration.connected &&
        !collaboration.retry &&
        !collaboration.connecting &&
        !collaboration.unmerged &&
        !collaboration.failed
      ) {
        await connectCollaboration(collaboration);
      }
    }
    if (
      prepared ||
      permissionsChanged ||
      wasPreparing !== current.preparing ||
      previousCollaboration !== collaboration
    ) {
      renderCollaborators();
      refreshControls();
    }
  } catch (errorCause) {
    const error = errorContext(errorCause);
    if (current !== documentParticipation || aborted(error)) return;
    current.ready = false;
    current.preparing = false;
    if (isConnectionLoss(error)) {
      connectionFailure(error);
      delay = 3000;
      return;
    }
    if (error.status === 410) {
      current.participant = null;
      collaborationNotice("Reconnecting…");
      refreshControls();
      delay = 150;
      return;
    }
    if ([401, 403, 404].includes(error.status)) {
      acceptDocumentPermissions({ writable: false, collaborative: false, owner: false });
      if (collaboration) {
        await persistCurrentDraft().catch((failure) =>
          console.error("Could not persist the revoked session's draft.", failure),
        );
        if (current !== documentParticipation) return;
        stopCollaboration();
      }
      if (publicState.publicView && error.status === 401) requestPublicPassword();
    }
    collaborationNotice(`Access refresh failed: ${error.message}`, true);
    refreshControls();
    delay = 3000;
  } finally {
    current.polling = false;
    if (current === documentParticipation)
      current.timer = window.setTimeout(() => void pollDocumentParticipation(current), delay);
  }
}
