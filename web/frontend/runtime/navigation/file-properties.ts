import { decodedBoolean, decodedEntry, decodedNumber, decodedObject, decodedString } from "../../api/contracts";
import { authenticationSession } from "../../state/authentication";
import { projectModel } from "../../state/projects";
import { element, requiredQuery } from "../../types/elements";
import { errorContext } from "../../types/errors";
import { api } from "../core/api";
import { notice } from "../core/dom";
import { listen } from "../lifecycle";

const field = (name: string) => requiredQuery(document, `#file-property-${name}`, HTMLInputElement);
const form = () => requiredQuery(document, "#file-properties-form", HTMLFormElement);
const save = () => requiredQuery(document, "#file-properties-save", HTMLButtonElement);
const error = () => requiredQuery(document, "#file-properties-error", HTMLParagraphElement);
let selected: { path: string; id: string; revision: number; scope: symbol } | null = null;
let generation = 0;

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
  selected = {
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
  notice(error(), "");
  return decodedEntry(data.details);
}

export function initializeFileProperties() {
  listen(form(), "submit", async (event) => {
    event.preventDefault();
    const entry = selected;
    if (!entry || entry.scope !== projectModel.selection || save().disabled) return;
    save().disabled = true;
    notice(error(), "");
    try {
      await api("/api/file-properties", {
        method: "PUT",
        signal: authenticationSession.scope.signal,
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
      if (selected === entry && entry.scope === projectModel.selection) element("details-dialog").close();
    } catch (cause) {
      if (selected === entry && entry.scope === projectModel.selection)
        notice(error(), errorContext(cause).message, "error");
    } finally {
      if (selected === entry) save().disabled = false;
    }
  });
}
