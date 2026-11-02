// editor/src/editor-helpers.ts
var sourceEncoder = new TextEncoder();
var MAX_NATIVE_SOURCE_LINES = 4e3;
function shouldVirtualizeSource(source, byteThreshold) {
  if (source.length >= byteThreshold) return true;
  let from = 0;
  if (source.length >= MAX_NATIVE_SOURCE_LINES) {
    for (let line = 0; line < MAX_NATIVE_SOURCE_LINES; line += 1) {
      const next = source.indexOf("\n", from);
      if (next < 0) break;
      if (line === MAX_NATIVE_SOURCE_LINES - 1) return true;
      from = next + 1;
    }
  }
  return source.length * 3 >= byteThreshold && sourceEncoder.encode(source).byteLength >= byteThreshold;
}
function resolveMarkdownUrl(value, notePath, image = false) {
  const raw = String(value ?? "").trim();
  if (!raw || /[\u0000-\u0020\u007f]/u.test(raw.replaceAll(" ", ""))) return null;
  if (/^(?:https?:|mailto:)/i.test(raw)) {
    try {
      const url = new URL(raw);
      if (image && url.protocol !== "https:" && url.protocol !== "http:") return null;
      if (image) return null;
      return url.href;
    } catch {
      return null;
    }
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(raw) || raw.startsWith("//") || raw.includes("\\")) return null;
  if (raw.startsWith("#")) return image ? null : raw;
  const hashIndex = raw.indexOf("#");
  const hash = hashIndex < 0 ? "" : raw.slice(hashIndex);
  const pathPart = (hashIndex < 0 ? raw : raw.slice(0, hashIndex)).split("?")[0];
  let decoded;
  try {
    decoded = decodeURIComponent(pathPart);
  } catch {
    return null;
  }
  if (decoded.includes("\\") || /[\u0000-\u001f]/u.test(decoded)) return null;
  const parts = decoded.startsWith("/") ? [] : notePath.replaceAll("\\", "/").split("/").slice(0, -1);
  for (const part of decoded.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else {
      if (part.includes(":")) return null;
      parts.push(part);
    }
  }
  const path = parts.join("/");
  if (!path) return null;
  return `/${path.split("/").map(encodeURIComponent).join("/")}${hash}`;
}
function sourceLine(source, from) {
  let end = from;
  while (end < source.length && source[end] !== "\r" && source[end] !== "\n") end++;
  const text = source.slice(from, end);
  const ending = source[end] === "\r" && source[end + 1] === "\n" ? "\r\n" : source[end] ?? "";
  return { from, text, end: end + ending.length, ending };
}
function splitFrontMatter(source) {
  const bomLength = source.startsWith("\uFEFF") ? 1 : 0;
  const none = {
    hasMetadata: false,
    prefix: source.slice(0, bomLength),
    body: source.slice(bomLength),
    bodyStart: bomLength
  };
  const opening = sourceLine(source, bomLength);
  if (!/^---[ \t]*$/.test(opening.text) || !opening.ending) return none;
  let position = opening.end;
  while (position < source.length) {
    const line = sourceLine(source, position);
    if (/^(?:---|\.\.\.)[ \t]*$/.test(line.text)) {
      let bodyStart = line.end;
      while (bodyStart < source.length) {
        const blank = sourceLine(source, bodyStart);
        if (!/^[ \t]*$/.test(blank.text) || blank.end === bodyStart) break;
        bodyStart = blank.end;
      }
      return {
        hasMetadata: true,
        prefix: source.slice(0, bodyStart),
        body: source.slice(bodyStart),
        bodyStart,
        opening: source.slice(0, opening.end),
        raw: source.slice(opening.end, line.from),
        suffix: source.slice(line.from, bodyStart),
        lineEnding: opening.ending,
        metadataStart: opening.end,
        metadataEnd: line.from
      };
    }
    if (line.end <= position) break;
    position = line.end;
  }
  return none;
}
function replaceMetadataText(parts, value) {
  if (!parts.hasMetadata) return parts;
  let raw = value.replace(/\r\n?|\n/g, parts.lineEnding);
  if (raw && !/[\r\n]$/.test(raw)) raw += parts.lineEnding;
  const prefix = parts.opening + raw + parts.suffix;
  return { ...parts, raw, prefix, metadataEnd: parts.opening.length + raw.length, bodyStart: prefix.length };
}
function headingSlug(text) {
  let output = "";
  let separator = false;
  for (const character of [...text].slice(0, 160).flatMap((value) => [...value.toLowerCase()])) {
    if (/[\p{Alphabetic}\p{N}_]/u.test(character)) {
      if (separator && output) output += "-";
      separator = false;
      output += character;
    } else if (/[\p{White_Space}-]/u.test(character)) {
      separator = true;
    }
  }
  return output || "section";
}
function assignHeadingIds(texts) {
  const counts = /* @__PURE__ */ new Map();
  const used = /* @__PURE__ */ new Set();
  return texts.map((text) => {
    const slug = headingSlug(text);
    let count = counts.get(slug) ?? 0;
    let candidate;
    do {
      count += 1;
      candidate = count === 1 ? slug : `${slug}-${count}`;
    } while (used.has(candidate));
    counts.set(slug, count);
    used.add(candidate);
    return candidate;
  });
}
function validateAppearance(value) {
  if (!value || typeof value !== "object" || !("theme" in value) || value.theme !== "system" && value.theme !== "light" && value.theme !== "dark") {
    throw new Error("The service returned an invalid appearance theme.");
  }
  const font = (name, label) => {
    if (typeof name !== "string" || !name.trim() || name.length > 200 || /[\u0000-\u001f\u007f]/u.test(name)) {
      throw new Error(`The service returned an invalid ${label} font.`);
    }
    return name.trim();
  };
  return {
    theme: value.theme,
    latinFont: font("latinFont" in value ? value.latinFont : void 0, "English"),
    cjkFont: font("cjkFont" in value ? value.cjkFont : void 0, "Chinese")
  };
}
function quoteFontFamily(value) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\u0000-\u001f\u007f]/gu, (character) => `\\${character.charCodeAt(0).toString(16)} `)}"`;
}
function isGenericFontFamily(value) {
  return /^(?:serif|sans-serif|monospace|system-ui|cursive|fantasy|ui-serif|ui-sans-serif|ui-monospace|ui-rounded|math|emoji|fangsong)$/i.test(
    value
  );
}
function cssFontFamily(value) {
  return isGenericFontFamily(value) ? value.toLowerCase() : quoteFontFamily(value);
}
export {
  assignHeadingIds,
  cssFontFamily,
  headingSlug,
  isGenericFontFamily,
  quoteFontFamily,
  replaceMetadataText,
  resolveMarkdownUrl,
  shouldVirtualizeSource,
  splitFrontMatter,
  validateAppearance
};
