import { element } from "../../types/elements";
import { createButton } from "@folio/editor-runtime";
import { notice } from "./notice";
import { applicationLifetime } from "../lifecycle";
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

let clearFeedback: (() => void) | undefined;
export function documentNotice(text: string, kind: string = ""): void {
  clearFeedback?.();
  const node = element("document-message");
  notice(node, text, kind);
  node.title = text;
  if (!text || kind !== "success") return;
  let release = () => {};
  const reset = () => {
    clearTimeout(timer);
    release();
    if (clearFeedback !== reset) return;
    clearFeedback = undefined;
    if (node.textContent === text && node.classList.contains("is-success")) {
      notice(node, "");
      node.title = "";
    }
  };
  const timer = window.setTimeout(reset, 1600);
  clearFeedback = reset;
  release = applicationLifetime().defer(reset);
}

export function previewStatus(text: string, error = false): void {
  notice(element("preview-status"), text, error ? "error" : "");
  element("preview-status").hidden = !error;
}
