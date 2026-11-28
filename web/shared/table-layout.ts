export interface TableLayout {
  wrap: boolean;
  widths: number[];
}

export const minColumnWidth = 56;
export const maxColumnWidth = 8192;
export const columnWidth = (value: number) => Math.max(minColumnWidth, Math.min(maxColumnWidth, Math.round(value)));

export function readTableLayout(scope: string | null, index: number, columns: number): TableLayout {
  try {
    const saved = scope && JSON.parse(localStorage.getItem(`folio.table.${scope}.${index}`) ?? "null");
    return {
      wrap: saved?.wrap !== false,
      widths:
        Array.isArray(saved?.widths) &&
        saved.widths.length === columns &&
        saved.widths.every((v: number) => Number.isInteger(v) && v === columnWidth(v))
          ? saved.widths
          : [],
    };
  } catch {
    return { wrap: true, widths: [] };
  }
}

export function storeTableLayout(scope: string | null, index: number, layout: TableLayout) {
  if (!scope || index < 0) return;
  try {
    const key = `folio.table.${scope}.${index}`;
    if (layout.wrap && !layout.widths.length) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(layout));
  } catch {
    /* The current view still works without storage. */
  }
}

/** Presentation only: colgroup lives outside the editable tbody and never enters Markdown. */
export function applyTableLayout(table: HTMLTableElement, columns: number, { wrap, widths }: TableLayout) {
  table.dataset.wrap = String(wrap);
  const fixed = widths.length > 0 && widths.length === columns;
  let group = table.querySelector("colgroup");
  if (fixed) {
    if (!group) table.prepend((group = document.createElement("colgroup")));
    while (group.childElementCount > columns) group.lastElementChild?.remove();
    for (const [index, width] of widths.entries()) {
      const col =
        (group.children[index] as HTMLTableColElement | undefined) ?? group.appendChild(document.createElement("col"));
      col.style.width = `${width}px`;
    }
  } else group?.remove();
  table.style.tableLayout = fixed || wrap ? "fixed" : "auto";
  table.style.width = fixed ? `${widths.reduce((a, b) => a + b, 0)}px` : wrap ? "100%" : "max-content";
  table.style.minWidth = fixed ? "0" : `max(100%, ${columns * 112}px)`;
}
