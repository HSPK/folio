import { isMap, isScalar, parseDocument } from "yaml";
import type { Document, YAMLMap } from "yaml";

export function assertMetadataMap<T extends Document>(
  parsed: T,
  message: string,
): asserts parsed is T & { contents: YAMLMap | null } {
  if (parsed.contents && !isMap(parsed.contents)) throw new Error(message);
}

export function isMetadataValues(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function metadataPropertyDocument(raw: string) {
  const parsed = parseDocument(raw.replace(/\r(?!\n)/g, "\n"), { uniqueKeys: true });
  if (parsed.errors.length) throw new Error(`Invalid YAML: ${parsed.errors[0].message}`);
  assertMetadataMap(parsed, "Metadata should be a YAML mapping (key: value). Its original text is preserved.");
  return parsed;
}

export function editableMetadataProperty(parsed: ReturnType<typeof metadataPropertyDocument>, key: string) {
  const node = parsed.get(key, true);
  if (node === undefined) return !parsed.contents?.flow;
  return (
    isScalar(node) &&
    !node.anchor &&
    !node.tag &&
    (node.value === null ||
      typeof node.value === "number" ||
      (typeof node.value === "string" && !/[\r\n]/.test(node.value)))
  );
}

export function replaceYamlProperty(raw: string, key: string, value: string) {
  if (!["title", "status"].includes(key)) throw new Error("This property must be edited in YAML.");
  const parsed = metadataPropertyDocument(raw);
  if (!editableMetadataProperty(parsed, key))
    throw new Error(`Edit ${key} directly in YAML to preserve its structure.`);
  const node = parsed.get(key, true);
  if (node !== undefined && !isScalar(node)) throw new Error(`Edit ${key} directly in YAML to preserve its structure.`);
  if (String(node?.value ?? "") === value) return raw;
  const text = node?.type === "QUOTE_SINGLE" ? `'${value.replace(/'/g, "''")}'` : JSON.stringify(value);
  const ending = raw.includes("\r\n") ? "\r\n" : raw.includes("\r") ? "\r" : "\n";
  if (!node) return `${raw}${raw && !/[\r\n]$/.test(raw) ? ending : ""}${key}: ${text}${ending}`;
  if (!node.range) throw new Error(`Edit ${key} directly in YAML to preserve its structure.`);
  const [from, to] = node.range;
  const newline = raw.slice(from, to).match(/(?:\r\n|\r|\n)$/)?.[0] ?? "";
  const spacing = raw[from - 1] === ":" ? " " : "";
  return raw.slice(0, from) + spacing + text + newline + raw.slice(to);
}
