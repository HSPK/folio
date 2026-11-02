// Generated from frontend/models/index.ts; do not edit.

// frontend/models/authentication.ts
function accountIdentity(user) {
  return user ? JSON.stringify([user.scope ?? "", user.id ?? user.username]) : null;
}

// frontend/models/paths.ts
function normalizeNotePath(path) {
  return path.replace(/\\/g, "/");
}
function isReservedFileName(name) {
  return /^(con|prn|aux|nul|clock\$|com[1-9¹²³]|lpt[1-9¹²³])$/i.test(name.split(".")[0].trimEnd());
}
function validatePortablePath(value, emptyMessage) {
  const path = normalizeNotePath(value.trim());
  if (!path) throw new Error(emptyMessage);
  if (path.startsWith("/") || /^[a-z]:/i.test(path))
    throw new Error("Use a path relative to the notes folder, not an absolute path.");
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("Use a file name and existing folders, without empty, . or .. segments.");
  }
  if (parts.some((part) => /[<>:"|?*\u0000-\u001F]/u.test(part) || /[. ]$/.test(part))) {
    throw new Error("Use portable file and folder names without reserved characters or a trailing space or period.");
  }
  if (parts.some(isReservedFileName))
    throw new Error("Names such as CON or NUL are reserved for cross-platform compatibility.");
  return { path, parts };
}
function validateNewNotePath(value) {
  const { path, parts } = validatePortablePath(value, "Enter a relative path for the new note.");
  if (!/\.(md|markdown)$/i.test(parts.at(-1) ?? "")) throw new Error("The new note must end in .md or .markdown.");
  return path;
}
function validateNewDirectoryPath(value) {
  const { path, parts } = validatePortablePath(value, "Enter a relative path for the new folder.");
  const forbidden = /* @__PURE__ */ new Set(["node_modules", "target", "venv", "__pycache__", "build", "dist"]);
  if (parts.some((part) => part.startsWith(".") || forbidden.has(part.toLowerCase()))) {
    throw new Error("Hidden and dependency folders cannot be created.");
  }
  return path;
}
function entryDestination(path, directory, replacementName = path.slice(path.lastIndexOf("/") + 1)) {
  const target = normalizeNotePath(directory).replace(/^\/+|\/+$/g, "");
  return target ? `${target}/${replacementName}` : replacementName;
}
function parseHiddenPatterns(value) {
  const patterns = [
    ...new Set(
      String(value ?? "").split(/\r\n|\r|\n/).map((line) => normalizeNotePath(line.trim())).filter((line) => line && !line.startsWith("#"))
    )
  ];
  if (patterns.length > 100 || patterns.some(
    (pattern) => pattern.length > 200 || pattern.startsWith("/") || pattern.split("/").some((part) => part === "..") || /[\u0000-\u001f\u007f]/u.test(pattern)
  )) {
    throw new Error("Use at most 100 relative hide patterns of up to 200 characters.");
  }
  return patterns;
}
function createHiddenPathMatcher(patterns) {
  const expressions = patterns.map((pattern) => {
    const base = pattern.endsWith("/**") ? pattern.slice(0, -3) : pattern.endsWith("/") ? pattern.slice(0, -1) : pattern;
    const source = base.split("/").map((part, index, parts) => {
      const last = index === parts.length - 1;
      if (part === "**") return last ? ".*" : "(?:[^/]+/)*";
      return part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]*").replaceAll("?", "[^/]") + (last ? "" : "/");
    }).join("");
    const suffix = "(?:/.*)?";
    return new RegExp(base.includes("/") ? `^${source}${suffix}$` : `(?:^|/)${source}${suffix}$`, "i");
  });
  return (value) => {
    const path = normalizeNotePath(value);
    return expressions.some((expression) => expression.test(path));
  };
}

// frontend/models/navigation.ts
var resourceIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
var isResourceId = (value) => typeof value === "string" && resourceIdPattern.test(value);
function browserDocumentTitle(document, modified = false) {
  if (!document) return "Folio";
  const title = document.title?.trim() || normalizeNotePath(document.path).split("/").at(-1);
  return `${title}${modified ? " *" : ""} \u2014 Folio`;
}
function readLaunchUrl(value) {
  const url = new URL(value);
  const ordinaryFragments = [];
  let token = null;
  for (const part of url.hash.slice(1).split("&")) {
    const match = /^token=([a-f0-9]+)$/i.exec(part);
    if (match) token ??= match[1];
    else ordinaryFragments.push(part);
  }
  if (token !== null) url.hash = ordinaryFragments.join("&");
  return { url, token };
}
function readNoteRoute(value) {
  const url = new URL(value);
  if (url.searchParams.has("file") || url.searchParams.has("path"))
    throw new Error("Path-based document URLs are no longer supported.");
  const id = url.searchParams.get("document");
  if (id !== null && !isResourceId(id)) throw new Error("Use a UUID v7 document URL.");
  return { id, hash: url.hash };
}
function makeNoteUrl(value, id, hash2 = "") {
  if (id != null && !isResourceId(id)) throw new Error("A document URL requires a UUID v7.");
  const url = new URL(value);
  url.searchParams.delete("file");
  url.searchParams.delete("path");
  if (id && url.pathname !== "/share") url.searchParams.set("document", id);
  else url.searchParams.delete("document");
  url.hash = hash2;
  return url;
}
var RequestGate = class {
  #ticket = null;
  next() {
    return this.#ticket = /* @__PURE__ */ Symbol("folio-request");
  }
  isCurrent(ticket) {
    return ticket === this.#ticket;
  }
  invalidate() {
    this.#ticket = null;
  }
};

// frontend/models/document.ts
var MAX_MARKDOWN_BYTES = 4 * 1024 * 1024;
var encoder = new TextEncoder();
function normalizeEditorText(text) {
  return text.includes("\r") ? text.replace(/\r\n?/g, "\n") : text;
}
function createDocumentModel(document) {
  const raw = document.bom && !document.content.startsWith("\uFEFF") ? `\uFEFF${document.content}` : document.content;
  const bom = raw.startsWith("\uFEFF");
  const source = bom ? raw.slice(1) : raw;
  const counts = /* @__PURE__ */ new Map();
  let lineEnding = null;
  for (let index = 0; index < source.length; index += 1) {
    let ending;
    if (source[index] === "\r") {
      ending = source[index + 1] === "\n" ? "\r\n" : "\r";
      if (ending === "\r\n") index += 1;
    } else if (source[index] === "\n") ending = "\n";
    else continue;
    lineEnding ??= ending;
    counts.set(ending, (counts.get(ending) ?? 0) + 1);
  }
  for (const [ending, count] of counts) if (count > (counts.get(lineEnding ?? "") ?? 0)) lineEnding = ending;
  return {
    id: document.id,
    project: document.project,
    path: document.path,
    content: raw,
    html: document.html,
    version: document.version,
    title: typeof document.title === "string" ? document.title : null,
    text: normalizeEditorText(source),
    format: { bom, lineEnding: lineEnding ?? "\n", mixed: counts.size > 1 }
  };
}
function isDirty(document, editorText) {
  return Boolean(document && normalizeEditorText(editorText) !== document.text);
}
function serializeEditorText(document, editorText) {
  const text = normalizeEditorText(editorText);
  if (text === document.text) return document.content;
  const bom = document.format.bom ? "\uFEFF" : "";
  if (!document.format.mixed)
    return bom + (document.format.lineEnding === "\n" ? text : text.replace(/\n/g, document.format.lineEnding));
  let from = 0;
  while (from < document.text.length && from < text.length && document.text[from] === text[from]) from += 1;
  let oldTo = document.text.length;
  let newTo = text.length;
  while (oldTo > from && newTo > from && document.text[oldTo - 1] === text[newTo - 1]) {
    oldTo--;
    newTo--;
  }
  const source = bom ? document.content.slice(1) : document.content;
  let raw = 0;
  let normalized = 0;
  const [rawFrom, rawTo] = [from, oldTo].map((target) => {
    while (normalized < target) {
      raw += source[raw] === "\r" && source[raw + 1] === "\n" ? 2 : 1;
      normalized++;
    }
    return raw;
  });
  const prefix = source.slice(0, rawFrom);
  const suffix = source.slice(rawTo);
  let changed = text.slice(from, newTo).replace(/\n/g, document.format.lineEnding);
  if (!changed && prefix.endsWith("\r") && suffix.startsWith("\n")) changed = "\r";
  else if (changed) {
    if (prefix.endsWith("\r") && changed.startsWith("\n")) changed = "\r" + changed;
    if (changed.endsWith("\r") && suffix.startsWith("\n")) changed += "\n";
  }
  return bom + prefix + changed + suffix;
}
function createSaveSnapshot(document, editorText) {
  return Object.freeze({
    id: document.id,
    path: document.path,
    version: document.version,
    text: normalizeEditorText(editorText),
    content: serializeEditorText(document, editorText)
  });
}
function reconcileSave(snapshot, response, currentEditorText) {
  if (!isResourceId(snapshot.id) || response.id !== snapshot.id)
    throw new Error("The service returned a different note after saving.");
  const document = createDocumentModel(response);
  const currentText = normalizeEditorText(currentEditorText);
  const text = currentText === snapshot.text ? document.text : currentText;
  return { document, text, dirty: isDirty(document, text) };
}
function markdownByteLength(content) {
  return encoder.encode(content).byteLength;
}
function formatByteCount(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

// shared/objects.ts
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// frontend/models/drafts.ts
var hash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
var position = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
function decodedSelection(value) {
  if (value === null) return null;
  if (!isRecord(value) || !position(value.from) || !position(value.to))
    throw new Error("This local recovery selection is invalid.");
  return Object.freeze({ from: value.from, to: value.to });
}
function decodedDraftIdentity(value) {
  if (!value.scope || !hash(value.secret))
    throw new Error("The private recovery key is unavailable. Reconnect before closing unsaved work.");
  return Object.freeze({ scope: value.scope, secret: value.secret });
}
function decodedDraft(value) {
  if (!isRecord(value) || value.project !== null && typeof value.project !== "string" || !isResourceId(value.document) || typeof value.path !== "string" || typeof value.source !== "string" || typeof value.version !== "string" || !value.version || value.room !== null && typeof value.room !== "string" || typeof value.updates !== "string" || value.updates.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.updates) || typeof value.unmerged !== "boolean" || typeof value.tab !== "string" || !value.tab || typeof value.keep !== "boolean")
    throw new Error("This local recovery record is invalid.");
  return Object.freeze({
    project: value.project,
    document: value.document,
    path: value.path,
    source: value.source,
    version: value.version,
    room: value.room,
    updates: value.updates,
    unmerged: value.unmerged,
    selection: decodedSelection(value.selection),
    tab: value.tab,
    keep: value.keep
  });
}
function decodedEncryptedDraft(value) {
  if (!isRecord(value) || !hash(value.key) || !hash(value.document) || !hash(value.owner) || typeof value.generation !== "string" || !/^[a-f0-9]{32}$/i.test(value.generation) || typeof value.updated !== "number" || !Number.isFinite(value.updated) || value.updated < 0 || !(value.iv instanceof Uint8Array) || value.iv.byteLength !== 12 || typeof value.compressed !== "boolean" || !(value.payload instanceof ArrayBuffer) && !(value.payload instanceof Blob))
    throw new Error("This encrypted recovery record is invalid.");
  return {
    key: value.key,
    document: value.document,
    owner: value.owner,
    generation: value.generation,
    updated: value.updated,
    iv: new Uint8Array(value.iv),
    compressed: value.compressed,
    payload: value.payload
  };
}

// frontend/models/library.ts
function fileLabel(file) {
  return file.title ?? (file.name.replace(/\.(?:md|markdown)$/i, "") || file.name);
}
function fileDisplayKey(file) {
  return fileLabel(file).normalize("NFC").replace(/\s+/g, " ").trim().toLocaleLowerCase();
}
function countFileDisplays(files) {
  const counts = /* @__PURE__ */ new Map();
  for (const file of files) {
    const key = fileDisplayKey(file);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}
var noteSearchCache = /* @__PURE__ */ new WeakMap();
function filterNotes(files, query) {
  const needle = normalizeNotePath(query.trim()).toLowerCase();
  if (!needle) return files;
  return files.filter((file) => {
    let searchable = noteSearchCache.get(file);
    if (!searchable || searchable.path !== file.path || searchable.name !== file.name || searchable.title !== file.title) {
      searchable = {
        path: file.path,
        name: file.name,
        title: file.title,
        normalizedPath: file.path.toLowerCase(),
        normalizedName: file.name.toLowerCase(),
        normalizedTitle: file.title?.toLowerCase() ?? ""
      };
      noteSearchCache.set(file, searchable);
    }
    return searchable.normalizedPath.includes(needle) || searchable.normalizedName.includes(needle) || searchable.normalizedTitle.includes(needle);
  });
}
function sameTreeStructure(left, right) {
  return left.length === right.length && left.every((entry, index) => {
    const other = right[index];
    return other && (entry.id ?? null) === (other.id ?? null) && entry.path === other.path && entry.name === other.name;
  });
}
function sameTreeEntries(left, right) {
  return sameTreeStructure(left, right) && left.every((entry, index) => (entry.title ?? null) === (right[index].title ?? null));
}
var treeCollator = new Intl.Collator(void 0, { numeric: true, sensitivity: "base" });
function buildFileTree(files, directories = []) {
  const root = { name: "", title: null, path: "", directories: /* @__PURE__ */ new Map(), files: [] };
  const ensureChild = (parent, name) => {
    let child = parent.directories.get(name);
    if (!child) {
      child = {
        name,
        title: null,
        path: parent.path ? `${parent.path}/${name}` : name,
        directories: /* @__PURE__ */ new Map(),
        files: []
      };
      parent.directories.set(name, child);
    }
    return child;
  };
  const ensurePath = (path, includeLeaf) => {
    const normalized = normalizeNotePath(path);
    let parent = root;
    let start = 0;
    while (start < normalized.length) {
      const slash = normalized.indexOf("/", start);
      if (slash < 0) return includeLeaf ? ensureChild(parent, normalized.slice(start)) : parent;
      parent = ensureChild(parent, normalized.slice(start, slash));
      start = slash + 1;
    }
    return parent;
  };
  for (const directory of directories) {
    const branch = ensurePath(directory.path, true);
    if (directory.title) branch.title = directory.title;
  }
  for (const file of files) ensurePath(file.path, false).files.push(file);
  const compare = (a, b) => treeCollator.compare(a.title ?? a.name, b.title ?? b.name);
  const finish = (branch) => ({
    name: branch.name,
    title: branch.title,
    path: branch.path,
    directories: [...branch.directories.values()].sort(compare).map(finish),
    files: [...branch.files].sort(compare)
  });
  return finish(root);
}

// frontend/models/preferences.ts
function createPreferenceDefaults() {
  return {
    imageDirectory: "assets/images",
    imageCompression: "original",
    imageMaxEdge: 0,
    imageQuality: 85,
    autoSaveDelayMs: 1e3,
    defaultView: "live",
    sourceLineWrap: true,
    spellcheck: true,
    fontSizePx: 17,
    lineHeightPercent: 175,
    density: "comfortable",
    defaultSidebar: "files",
    sidebarOpen: true,
    hiddenPatterns: [],
    treeRefreshSeconds: 0,
    largeDocumentThresholdKib: 768,
    previewDelayMs: 300,
    outlineDelayMs: 75,
    reducedMotion: false,
    highContrast: false,
    strongFocus: true
  };
}

// frontend/models/projects.ts
function projectSharing(value) {
  if (value !== "private" && value !== "read" && value !== "edit") throw new Error("Choose valid project permissions.");
  return value;
}
function documentSharing(value) {
  if (value === "inherit" || value === "publicRead" || value === "publicEdit") return value;
  return projectSharing(value);
}
function projectSource(value) {
  if (value !== "new" && value !== "folder") throw new Error("Choose new or folder as the project source.");
  return value;
}
function ownedProjectChange(value) {
  return value.action === "document" ? Object.freeze({
    ...value,
    publicOptions: value.publicOptions ? Object.freeze({ ...value.publicOptions }) : void 0
  }) : Object.freeze({ ...value });
}

// frontend/models/word-count.ts
function createWordCounter(segmenter = new Intl.Segmenter(void 0, { granularity: "word" })) {
  let lines = null;
  let counts = [];
  let total = 0;
  const countLine = (line) => {
    let count = 0;
    for (const word of segmenter.segment(line)) if (word.isWordLike) count++;
    return count;
  };
  return {
    count(source) {
      source = String(source);
      const nextLines = source.split("\n");
      if (lines === null) {
        counts = new Array(nextLines.length).fill(0);
        let line = 0;
        let lineEnd = nextLines[0]?.length ?? 0;
        for (const word of segmenter.segment(source)) {
          if (!word.isWordLike) continue;
          while (word.index > lineEnd && line + 1 < nextLines.length) {
            line++;
            lineEnd += nextLines[line].length + 1;
          }
          counts[line]++;
          total++;
        }
        lines = nextLines;
        return total;
      }
      const nextCounts = new Array(nextLines.length);
      let prefix = 0;
      while (prefix < lines.length && prefix < nextLines.length && lines[prefix] === nextLines[prefix]) {
        nextCounts[prefix] = counts[prefix];
        prefix++;
      }
      let oldEnd = lines.length;
      let nextEnd = nextLines.length;
      while (oldEnd > prefix && nextEnd > prefix && lines[oldEnd - 1] === nextLines[nextEnd - 1]) {
        oldEnd--;
        nextEnd--;
      }
      for (let index = prefix; index < oldEnd; index++) total -= counts[index];
      for (let index = prefix; index < nextEnd; index++) {
        nextCounts[index] = countLine(nextLines[index]);
        total += nextCounts[index];
      }
      for (let offset = 0; oldEnd + offset < lines.length; offset++)
        nextCounts[nextEnd + offset] = counts[oldEnd + offset];
      lines = nextLines;
      counts = nextCounts;
      return total;
    }
  };
}

// frontend/models/workspace-lists.ts
function sameWorkspaceNote(note, project, id) {
  return note.project === project && note.id === id;
}
function restoredWorkspaceNote(workspace, requested, saved) {
  const recent = workspace.recent.filter((note) => !requested || note.project === requested);
  return [...recent, ...workspace.favorites].find(
    (note) => saved && (!requested || note.project === requested) && sameWorkspaceNote(note, saved.project, saved.id)
  ) ?? recent[0] ?? null;
}
export {
  MAX_MARKDOWN_BYTES,
  RequestGate,
  accountIdentity,
  browserDocumentTitle,
  buildFileTree,
  countFileDisplays,
  createDocumentModel,
  createHiddenPathMatcher,
  createPreferenceDefaults,
  createSaveSnapshot,
  createWordCounter,
  decodedDraft,
  decodedDraftIdentity,
  decodedEncryptedDraft,
  documentSharing,
  entryDestination,
  fileDisplayKey,
  fileLabel,
  filterNotes,
  formatByteCount,
  isDirty,
  isReservedFileName,
  isResourceId,
  makeNoteUrl,
  markdownByteLength,
  normalizeEditorText,
  normalizeNotePath,
  ownedProjectChange,
  parseHiddenPatterns,
  projectSharing,
  projectSource,
  readLaunchUrl,
  readNoteRoute,
  reconcileSave,
  restoredWorkspaceNote,
  sameTreeEntries,
  sameTreeStructure,
  sameWorkspaceNote,
  serializeEditorText,
  validateNewDirectoryPath,
  validateNewNotePath
};
