import { replaceMetadataText } from "./editor-helpers.ts";
import { attachScrollbars } from "./scrollbars.ts";
import { lineColumn, rawOffset } from "./cursor-coordinates.ts";
import { mountTagEditor, tagsFromValues } from "./metadata-tags.ts";
import {
  editableMetadataProperty,
  isMetadataValues,
  metadataPropertyDocument,
  replaceYamlProperty,
} from "./metadata-properties.ts";
import { isNode } from "yaml";
import type { EditorSession, InlineEditorOptions, MetadataEditor } from "./types/editor.ts";
import { hasMetadata } from "./editor-session.ts";
import { errorMessage } from "./errors.ts";

type MetadataOptions = Pick<
  InlineEditorOptions,
  "onTitle" | "onChange" | "onSelection" | "onHeadingSelection" | "onTag" | "onNotice"
> & {
  readOnly: boolean;
  styleNonce?: string;
  active: (state: EditorSession) => boolean;
  fullSource: (state: EditorSession) => string;
  publishOutline: (state: EditorSession) => void;
};

export function mountMetadata(
  state: EditorSession,
  page: HTMLElement,
  {
    readOnly,
    styleNonce,
    active,
    fullSource,
    onTitle,
    onChange,
    publishOutline,
    onSelection,
    onHeadingSelection,
    onTag,
    onNotice,
  }: MetadataOptions,
) {
  if (!hasMetadata(state)) {
    onTitle?.(null);
    onNotice?.("");
    return;
  }
  const region = document.createElement("section");
  region.className = "folio-metadata frontmatter";
  const details = document.createElement("details");
  const summary = document.createElement("summary");
  const disclosure = document.createElement("span");
  disclosure.className = "folio-metadata-disclosure";
  disclosure.setAttribute("aria-hidden", "true");
  const caption = document.createElement("span");
  caption.className = "folio-metadata-caption";
  caption.textContent = "Properties";
  const digest = document.createElement("span");
  digest.className = "folio-metadata-summary";
  summary.append(disclosure, caption, digest);
  const panel = document.createElement("div");
  panel.className = "folio-metadata-panel";
  const textarea = document.createElement("textarea");
  textarea.className = "folio-metadata-source";
  textarea.setAttribute("aria-label", "YAML metadata source");
  textarea.spellcheck = false;
  textarea.disabled = readOnly;
  textarea.value = state.parts.raw;
  textarea.rows = Math.max(4, Math.min(10, textarea.value.split("\n").length));
  const metadataScroll = document.createElement("div");
  metadataScroll.className = "folio-metadata-scroll";
  metadataScroll.setAttribute("data-overlayscrollbars-initialize", "");
  metadataScroll.append(textarea);
  const warning = document.createElement("p");
  warning.className = "folio-metadata-warning";
  warning.setAttribute("role", "alert");
  warning.id = `folio-metadata-warning-${state.ticket}`;
  warning.hidden = true;
  textarea.setAttribute("aria-describedby", warning.id);
  const showWarning = (message: string) => {
    warning.textContent = message;
    warning.hidden = Boolean(onNotice) || !message;
    onNotice?.(message, "error");
  };
  const fields = new Map<string, HTMLInputElement>();
  const propertyPositions = new Map<string, number>();
  for (const [key, name] of [
    ["title", "Title"],
    ["status", "Status"],
  ]) {
    const label = document.createElement("label");
    label.className = "folio-property";
    const nameNode = document.createElement("span");
    nameNode.textContent = name;
    const input = document.createElement("input");
    input.type = "text";
    if (key === "title") input.maxLength = 200;
    input.setAttribute("aria-label", `Document ${key}`);
    input.placeholder = key === "title" ? "Use file name" : "Not set";
    const commit = (event: Event) => {
      if ((event instanceof InputEvent && event.isComposing) || input.disabled || !active(state)) return;
      try {
        const next = replaceYamlProperty(state.parts.raw, key, input.value);
        textarea.value = next;
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      } catch (error) {
        showWarning(errorMessage(error));
      }
    };
    input.addEventListener("input", commit);
    input.addEventListener("compositionend", commit);
    for (const type of ["focus", "input", "compositionend"])
      input.addEventListener(type, () => {
        const from = state.parts.metadataStart + (propertyPositions.get(key) ?? 0);
        metadata.navigation = { from, to: from };
      });
    label.append(nameNode, input);
    panel.append(label);
    fields.set(key, input);
  }
  const tagLabel = document.createElement("span");
  tagLabel.className = "folio-property-label";
  tagLabel.textContent = "Tags";
  panel.append(tagLabel);
  const tags = mountTagEditor(panel, textarea, { onTag, onError: showWarning });
  tags.setReadOnly(readOnly);
  const advanced = document.createElement("details");
  advanced.className = "folio-metadata-advanced";
  const advancedToggle = document.createElement("summary");
  advancedToggle.append(disclosure.cloneNode(), document.createTextNode("Edit YAML"));
  advanced.append(advancedToggle, metadataScroll);
  const hint = document.createElement("p");
  hint.className = "folio-property-hint";
  hint.textContent = "Other properties and structured values are available in YAML.";
  panel.append(advanced, hint);
  details.append(summary, panel);
  region.append(details, warning);
  page.append(region);
  state.scrollbars.push(attachScrollbars(metadataScroll, textarea, { nonce: styleNonce }));
  const metadata: MetadataEditor = { details, advanced, textarea, tags, fields };
  state.metadata = metadata;
  const updateSummary = () => {
    let message = "";
    let title = "";
    let values: string[] = [];
    let data: Record<string, unknown> = {};
    let parsed: ReturnType<typeof metadataPropertyDocument> | undefined;
    try {
      parsed = metadataPropertyDocument(state.parts.raw);
      const value: unknown = parsed.toJS({ maxAliasCount: 50 }) ?? {};
      if (!isMetadataValues(value)) throw new Error("Metadata must be a YAML mapping.");
      data = value;
      title = typeof data.title === "string" || typeof data.title === "number" ? String(data.title) : "";
      values = tagsFromValues(data);
      if (parsed.warnings.length) message = parsed.warnings[0].message;
    } catch (error) {
      message = errorMessage(error);
    }
    for (const [key, input] of fields) {
      const node = parsed?.get(key, true);
      propertyPositions.set(key, isNode(node) ? (node.range?.[0] ?? 0) : 0);
      const editable = parsed && editableMetadataProperty(parsed, key);
      input.disabled = textarea.disabled || !editable || Boolean(message);
      input.title = editable ? "" : "Edit this structured value in YAML";
      if (document.activeElement !== input) input.value = editable ? String(data[key] ?? "") : "";
    }
    const status = typeof data.status === "string" || typeof data.status === "number" ? String(data.status) : "";
    digest.textContent = message
      ? "Check YAML"
      : [status, ...values.slice(0, 3), values.length > 3 ? `+${values.length - 3}` : ""].filter(Boolean).join(" · ") ||
        title ||
        "No common properties";
    digest.title = digest.textContent;
    hint.hidden =
      !message &&
      Object.keys(data).every((key) => ["title", "status", "tag", "tags"].includes(key)) &&
      [...fields.values()].every((input) => !input.title);
    if (message) summary.setAttribute("aria-describedby", warning.id);
    else summary.removeAttribute("aria-describedby");
    showWarning(message);
    textarea.setAttribute("aria-invalid", String(Boolean(message)));
    tags.render(values);
    onTitle?.(title || null);
  };
  textarea.addEventListener("input", () => {
    if (!active(state)) return;
    state.parts = replaceMetadataText(state.parts, textarea.value);
    updateSummary();
    onChange(fullSource(state));
    publishOutline(state);
  });
  const selection = () => {
    if (!active(state)) return;
    const offset = state.parts.metadataStart + rawOffset(state.parts.raw, textarea.selectionStart);
    metadata.navigation = {
      from: offset,
      to: state.parts.metadataStart + rawOffset(state.parts.raw, textarea.selectionEnd),
    };
    onHeadingSelection?.(null);
    if (onSelection) onSelection(lineColumn(fullSource(state), offset));
  };
  state.refreshMetadata = updateSummary;
  for (const event of ["select", "keyup", "click", "focus"]) textarea.addEventListener(event, selection);
  updateSummary();
}
