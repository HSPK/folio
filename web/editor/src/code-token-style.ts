import { tags, tagHighlighter } from "@lezer/highlight";

export const codeTokenStyle = tagHighlighter([
  { tag: [tags.keyword, tags.tagName], class: "folio-code-keyword" },
  { tag: [tags.string, tags.character], class: "folio-code-string" },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], class: "folio-code-number" },
  { tag: tags.comment, class: "folio-code-comment" },
  { tag: [tags.typeName, tags.attributeName, tags.propertyName], class: "folio-code-type" },
  { tag: [tags.function(tags.variableName), tags.definition(tags.variableName)], class: "folio-code-function" },
]);
