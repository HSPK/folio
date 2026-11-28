import { decodedBoolean, decodedEntry, decodedNumber, decodedObject, decodedString } from "../../api/contracts";
import { authenticationSession } from "../../state/authentication";
import { projectModel } from "../../state/projects";
import { element, requiredQuery } from "../../types/elements";
import { errorContext } from "../../types/errors";
import { api } from "../core/api";
import { documentNotice, notice } from "../core/dom";
import { confirmAction } from "../dialogs/dialogs";
import { listen } from "../lifecycle";

const field = (name: string) => requiredQuery(document, `#file-property-${name}`, HTMLInputElement);
const form = () => requiredQuery(document, "#file-properties-form", HTMLFormElement);
const save = () => requiredQuery(document, "#file-properties-save", HTMLButtonElement);
const error = () => requiredQuery(document, "#file-properties-error", HTMLParagraphElement);
let selected: {
  path: string;
  id: string;
  revision: number;
  scope: symbol;
  signature: string;
  submitted: string | null;
} | null = null;
let generation = 0;
const signature = () =>
  JSON.stringify([
    field("title").value,
    field("tags").value,
    requiredQuery(document, "#file-property-description", HTMLTextAreaElement).value,
  ]);

export async function closeFileDetails() {
  const entry = selected;
  if (
    entry &&
    signature() !== (entry.submitted ?? entry.signature) &&
    !(await confirmAction("Discard your unsaved properties?", {
      label: "Discard changes",
      tone: "destructive",
      signal: authenticationSession.scope.signal,
    }))
  )
    return;
  if (entry === selected) element("details-dialog").close();
}

export async function loadFileProperties(path: string) {
  const ticket = ++generation,
    scope = projectModel.selection;
  selected = null;
  form().hidden = save().hidden = true;
  if (/\.(md|markdown)$/i.test(path)) return null;
  const data = decodedObject(
    await api(`/api/file-properties?${new URLSearchParams({ path })}`, {
      signal: authenticationSession.scope.signal,
    }),
    "file properties",
  );
  if (ticket !== generation || scope !== projectModel.selection) throw new DOMException("File changed", "AbortError");
  const entry = decodedObject(data.entry, "file identity");
  const snapshot = decodedObject(data.snapshot, "properties snapshot");
  const props = decodedObject(snapshot.properties, "properties");
  const identity = {
    path,
    id: decodedString(entry.id, "file ID"),
    revision: decodedNumber(snapshot.revision, "revision"),
    scope,
  };
  field("title").value = decodedString(props.title, "title");
  field("tags").value = Array.isArray(props.tags) ? props.tags.map((t) => decodedString(t, "tag")).join(", ") : "";
  requiredQuery(document, "#file-property-description", HTMLTextAreaElement).value = decodedString(
    props.description,
    "description",
  );
  const writable = decodedBoolean(data.writable, "properties permission");
  for (const input of form().querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input,textarea"))
    input.readOnly = !writable;
  form().hidden = false;
  save().hidden = !writable;
  save().disabled = false;
  save().textContent = "Save";
  form().setAttribute("aria-busy", "false");
  selected = { ...identity, signature: signature(), submitted: null };
  notice(error(), "");
  return decodedEntry(data.details);
}

export function initializeFileProperties() {
  listen(element("details-dialog"), "cancel", (event) => {
    event.preventDefault();
    void closeFileDetails();
  });
  listen(element("details-dialog"), "close", () => {
    if (!element("details-dialog").open) {
      selected = null;
      generation++;
    }
  });
  listen(form(), "submit", async (event) => {
    event.preventDefault();
    const entry = selected;
    if (!entry || entry.scope !== projectModel.selection || save().disabled) return;
    const owner = authenticationSession.scope;
    save().disabled = true;
    save().textContent = "Saving…";
    form().setAttribute("aria-busy", "true");
    const submitted = signature();
    entry.submitted = submitted;
    notice(error(), "");
    try {
      const revision = await api("/api/file-properties", {
        decode: (value) => decodedNumber(decodedObject(value, "properties snapshot").revision, "revision"),
        method: "PUT",
        signal: owner.signal,
        body: {
          path: entry.path,
          id: entry.id,
          revision: entry.revision,
          properties: {
            title: field("title").value.trim(),
            tags: [
              ...new Set(
                field("tags")
                  .value.split(/[,，\n]/)
                  .map((t) => t.trim())
                  .filter(Boolean),
              ),
            ],
            description: requiredQuery(document, "#file-property-description", HTMLTextAreaElement).value,
          },
        },
      });
      if (selected === entry && entry.scope === projectModel.selection) {
        entry.revision = revision;
        entry.signature = submitted;
        if (signature() === submitted) element("details-dialog").close();
        else notice(error(), "Saved; newer edits unsaved", "warning");
      }
    } catch (cause) {
      if (!owner.signal.aborted && entry.scope === projectModel.selection) {
        const message = errorContext(cause).message;
        if (selected === entry) notice(error(), message, "error");
        else documentNotice(`Properties not saved for ${entry.path}: ${message}`, "error");
      }
    } finally {
      entry.submitted = null;
      if (selected === entry) {
        save().disabled = false;
        save().textContent = "Save";
        form().setAttribute("aria-busy", "false");
      }
    }
  });
}
