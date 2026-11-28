import { element } from "../../types/elements";
import { createButton } from "@folio/editor-runtime";
import { notice } from "./notice";
export { notice, setText } from "./notice";
export { ApiError, isAbortError as aborted } from "../../api/error";

export function createListRow(title: string, detail: string, onOpen?: () => void): HTMLDivElement {
  const row = document.createElement("div");
  const name = onOpen ? createButton({ label: title, onClick: onOpen }) : document.createElement("span");
  name.className = "workspace-item-name";
  if (!onOpen) name.textContent = title;
  const description = document.createElement("small");
  description.textContent = detail;
  name.append(description);
  row.append(name);
  return row;
}

export function documentNotice(text: string, kind: string = ""): void {
  notice(element("document-message"), text, kind);
  element("document-message").title = text;
}

export function previewStatus(text: string, error = false): void {
  notice(element("preview-status"), text, error ? "error" : "");
  element("preview-status").hidden = !error;
}
