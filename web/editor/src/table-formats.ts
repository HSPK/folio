import { escapeImageAttribute } from "./image-syntax.ts";
import type { Node } from "@milkdown/prose/model";

export function tableRows(table: Node) {
  const rows: string[][] = [];
  table.forEach((row) => {
    const cells: string[] = [];
    row.forEach((cell) =>
      cells.push(
        cell.textBetween(0, cell.content.size, "\n", (leaf) =>
          leaf.type.name === "hardbreak" ? "\n" : String(leaf.attrs.alt ?? leaf.attrs.label ?? leaf.attrs.target ?? ""),
        ),
      ),
    );
    rows.push(cells);
  });
  return rows;
}

function separated(rows: readonly string[][], separator: string, newline: string) {
  return (
    rows
      .map((row) =>
        row
          .map((value) =>
            /["\r\n]/.test(value) || value.includes(separator) ? `"${value.replace(/"/g, '""')}"` : value,
          )
          .join(separator),
      )
      .join(newline) + newline
  );
}

export function tableFormat({
  table,
  format,
  markdown_fn,
}: {
  table: Node;
  format: string;
  markdown_fn?: (table: Node) => string;
}) {
  const rows = tableRows(table);
  if (format === "markdown") {
    if (!markdown_fn) throw new Error("Markdown table export requires its body serializer.");
    return markdown_fn(table);
  }
  if (format === "csv") return separated(rows, ",", "\r\n");
  if (format === "tsv") return separated(rows, "\t", "\n");
  if (format === "json") return JSON.stringify(rows, null, 2);
  if (format === "html") {
    const lines: string[] = [];
    table.forEach((row, _offset, index) => {
      const cells: string[] = [];
      row.forEach((cell, _offset, column) => {
        const tag = cell.type.name === "table_header" ? "th" : "td";
        const align = cell.attrs.alignment;
        const style = ["left", "center", "right"].includes(align) ? ` style="text-align:${align}"` : "";
        cells.push(`<${tag}${style}>${escapeImageAttribute(rows[index][column]).replace(/&#10;/g, "<br>")}</${tag}>`);
      });
      lines.push(`  <tr>${cells.join("")}</tr>`);
    });
    return `<table>\n${lines.join("\n")}\n</table>`;
  }
  throw new RangeError("Choose Markdown, HTML, CSV, TSV, or JSON.");
}
