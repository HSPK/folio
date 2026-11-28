export function normalizeNotePath(path: string) {
  return path.replace(/\\/g, "/");
}

export function noteName(path: string) {
  const name = normalizeNotePath(path).split("/").at(-1) ?? "";
  return name.replace(/\.(?:md|markdown)$/i, "") || name;
}

export function isReservedFileName(name: string) {
  return /^(con|prn|aux|nul|clock\$|com[1-9¹²³]|lpt[1-9¹²³])$/i.test(name.split(".")[0].trimEnd());
}

function validatePortablePath(value: string, emptyMessage: string) {
  const path = normalizeNotePath(value.trim());
  if (!path) throw new Error(emptyMessage);
  if (path.startsWith("/") || /^[a-z]:/i.test(path)) throw new Error("Use a path relative to the notes folder.");
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("Remove empty, . or .. path segments.");
  }
  if (parts.some((part) => /[<>:"|?*\u0000-\u001F]/u.test(part) || /[. ]$/.test(part))) {
    throw new Error("Remove reserved characters and trailing spaces or periods.");
  }
  if (parts.some(isReservedFileName)) throw new Error("Reserved name, such as CON or NUL.");
  return { path, parts };
}

export function validateNewNotePath(value: string) {
  const { path, parts } = validatePortablePath(value, "Enter a note path.");
  if (!/\.(md|markdown)$/i.test(parts.at(-1) ?? "")) throw new Error("Use .md or .markdown.");
  return path;
}

export function validateNewDirectoryPath(value: string) {
  const { path, parts } = validatePortablePath(value, "Enter a folder path.");
  const forbidden = new Set(["node_modules", "target", "venv", "__pycache__", "build", "dist"]);
  if (parts.some((part) => part.startsWith(".") || forbidden.has(part.toLowerCase()))) {
    throw new Error("Hidden and dependency folders cannot be created.");
  }
  return path;
}

export function entryDestination(
  path: string,
  directory: string,
  replacementName = path.slice(path.lastIndexOf("/") + 1),
) {
  const target = normalizeNotePath(directory).replace(/^\/+|\/+$/g, "");
  return target ? `${target}/${replacementName}` : replacementName;
}

export function parseHiddenPatterns(value: unknown) {
  const patterns = [
    ...new Set(
      String(value ?? "")
        .split(/\r\n|\r|\n/)
        .map((line) => normalizeNotePath(line.trim()))
        .filter((line) => line && !line.startsWith("#")),
    ),
  ];
  if (
    patterns.length > 100 ||
    patterns.some(
      (pattern) =>
        pattern.length > 200 ||
        pattern.startsWith("/") ||
        pattern.split("/").some((part) => part === "..") ||
        /[\u0000-\u001f\u007f]/u.test(pattern),
    )
  ) {
    throw new Error("Use at most 100 relative hide patterns of up to 200 characters.");
  }
  return patterns;
}

export function createHiddenPathMatcher(patterns: readonly string[]) {
  const expressions = patterns.map((pattern) => {
    const base = pattern.endsWith("/**")
      ? pattern.slice(0, -3)
      : pattern.endsWith("/")
        ? pattern.slice(0, -1)
        : pattern;
    const source = base
      .split("/")
      .map((part, index, parts) => {
        const last = index === parts.length - 1;
        if (part === "**") return last ? ".*" : "(?:[^/]+/)*";
        return (
          part
            .replace(/[.+^${}()|[\]\\]/g, "\\$&")
            .replaceAll("*", "[^/]*")
            .replaceAll("?", "[^/]") + (last ? "" : "/")
        );
      })
      .join("");
    const suffix = "(?:/.*)?";
    return new RegExp(base.includes("/") ? `^${source}${suffix}$` : `(?:^|/)${source}${suffix}$`, "i");
  });
  return (value: string) => {
    const path = normalizeNotePath(value);
    return expressions.some((expression) => expression.test(path));
  };
}
