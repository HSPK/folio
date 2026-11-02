import { appState } from "./bootstrap";
import { notice } from "./notice";
export { notice, setText } from "./notice";
export { ApiError, isAbortError as aborted } from "../../api/error";

export function documentNotice(text: string, kind: string = ""): void {
  notice(appState.ui.documentMessage, text, kind);
  appState.ui.documentMessage.title = text;
}

export function previewStatus(text: string, error = false): void {
  notice(appState.ui.previewStatus, text, error ? "error" : "");
  appState.ui.previewStatus.hidden = !error;
}
