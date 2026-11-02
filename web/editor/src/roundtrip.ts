export function normalizeSerializedBody(source: string) {
  if (!source.includes("<br />")) return source;
  const withoutListPlaceholders = source
    .replace(/^([ \t]*(?:[*+-]|\d+[.)]))[ \t]+<br \/>\r?\n[ \t]+(#{1,6}[ \t]+.*)$/gm, "$1 $2")
    .replace(/^([ \t]*(?:[*+-]|\d+[.)]))[ \t]+<br \/>[ \t]*$/gm, "$1 ");
  return withoutListPlaceholders
    .split("\n")
    .map((line) => (/^\s*\|.*\|\s*$/.test(line) ? line.replace(/(^|\|)([ \t]*)<br \/>[ \t]*(?=\|)/g, "$1$2") : line))
    .join("\n");
}
