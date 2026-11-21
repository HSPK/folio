import { replaceMetadataRaw } from "./editor-helpers.ts";
import { mountTagEditor, replaceYamlTags, tagsFromValues } from "./metadata-tags.ts";
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

type MetadataOptions = Pick<InlineEditorOptions, "onTitle" | "onChange" | "onTag" | "onNotice"> & {
  readOnly: () => boolean;
  active: (state: EditorSession) => boolean;
  fullSource: (state: EditorSession) => string;
  publishOutline: (state: EditorSession) => void;
};

export function mountMetadata(
  state: EditorSession,
  page: HTMLElement,
  { readOnly, active, fullSource, onTitle, onChange, publishOutline, onTag, onNotice }: MetadataOptions,
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
  caption.append(disclosure, "Properties");
  const digest = document.createElement("span");
  digest.className = "folio-metadata-summary";
  const badge = document.createElement("span");
  badge.className = "folio-property-badge";
  const preview = document.createElement("span");
  preview.className = "folio-property-preview";
  digest.append(badge, preview);
  summary.append(caption, digest);
  const panel = document.createElement("div");
  panel.className = "folio-metadata-panel";
  const warning = document.createElement("p");
  warning.className = "folio-metadata-warning";
  warning.setAttribute("role", "alert");
  warning.id = `folio-metadata-warning-${state.ticket}`;
  warning.hidden = true;
  const showWarning = (message: string) => {
    warning.textContent = message;
    warning.hidden = Boolean(onNotice) || !message;
    onNotice?.(message, "error");
  };
  const fields = new Map<string, HTMLInputElement>();
  const propertyPositions = new Map<string, number>();
  const commitRaw = (raw: string) => {
    if (!active(state) || readOnly() || raw === state.parts.raw) return;
    state.parts = replaceMetadataRaw(state.parts, raw);
    updateSummary();
    onChange(fullSource(state));
    publishOutline(state);
  };
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
    const commit = (event: Event) => {
      if ((event instanceof InputEvent && event.isComposing) || input.disabled || !active(state)) return;
      try {
        commitRaw(replaceYamlProperty(state.parts.raw, key, input.value));
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
  const tagRow = document.createElement("div");
  tagRow.className = "folio-property";
  const tagLabel = document.createElement("span");
  tagLabel.textContent = "Tags";
  tagRow.append(tagLabel);
  panel.append(tagRow);
  const tags = mountTagEditor(tagRow, {
    onChange: (values) => commitRaw(replaceYamlTags(state.parts.raw, values)),
    onTag,
    onError: showWarning,
  });
  details.append(summary, panel);
  region.append(details, warning);
  page.append(region);
  const metadata: MetadataEditor = { details, summary };
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
      if (!isMetadataValues(value)) throw new Error("Metadata must be a YAML mapping");
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
      input.disabled = readOnly() || !editable || Boolean(message);
      input.title = editable ? "" : "Edit this structured value in Source mode";
      input.placeholder = message || !editable ? "See Source mode" : key === "title" ? "Use file name" : "Not set";
      if (document.activeElement !== input) input.value = editable ? String(data[key] ?? "") : "";
    }
    const status = typeof data.status === "string" || typeof data.status === "number" ? String(data.status) : "";
    badge.textContent = message ? "Check YAML" : status;
    badge.hidden = !badge.textContent;
    badge.classList.toggle("is-warning", Boolean(message));
    const tagPreview = values.slice(0, 3).map((tag) => `#${tag}`);
    if (values.length > 3) tagPreview.push(`+${values.length - 3}`);
    preview.textContent = message ? "" : tagPreview.join("  ") || (status ? "" : title);
    digest.title = [badge.textContent, preview.textContent].filter(Boolean).join(" · ");
    if (message) summary.setAttribute("aria-describedby", warning.id);
    else summary.removeAttribute("aria-describedby");
    showWarning(message ? `${message} — Check the front matter in Source mode.` : "");
    tags.setReadOnly(readOnly() || Boolean(message));
    tags.render(values);
    onTitle?.(title || null);
  };
  state.refreshMetadata = updateSummary;
  updateSummary();
}
