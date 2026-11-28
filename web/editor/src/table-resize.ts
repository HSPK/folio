import {
  applyTableLayout,
  columnWidth,
  minColumnWidth,
  maxColumnWidth,
  type TableLayout,
} from "../../shared/table-layout.ts";

export function tableResizers(
  scroll: HTMLElement,
  table: HTMLTableElement,
  layout: TableLayout,
  save: () => void,
  refresh: () => void,
) {
  const sheet = document.createElement("div");
  sheet.className = "folio-table-sheet";
  const rail = document.createElement("div");
  rail.className = "folio-table-resizers";
  rail.contentEditable = "false";
  sheet.append(table, rail);
  scroll.append(sheet);
  let columns = 0;
  let frame = 0;
  let drag: { id: number; x: number; index: number; before: number[]; measured: number[] } | null = null;
  const measured = () =>
    Array.from(table.rows[0]?.cells ?? [], (cell) => columnWidth(cell.getBoundingClientRect().width));
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(position);
  };
  function position() {
    frame = 0;
    const row = table.rows[0];
    if (row?.cells.length !== columns) return;
    const base = sheet.getBoundingClientRect().left;
    const rects = Array.from(row.cells, (cell) => cell.getBoundingClientRect());
    for (const [i, r] of rects.entries()) {
      const bar = rail.children[i] as HTMLElement;
      bar.style.left = `${r.right - base - 9}px`;
      bar.style.height = `${r.height}px`;
      bar.setAttribute("aria-valuenow", String(Math.round(r.width)));
    }
    refresh();
  }
  const observer = new ResizeObserver(schedule);
  observer.observe(table);
  const apply = () => {
    applyTableLayout(table, columns, layout);
    schedule();
  };
  function finish(commit: boolean) {
    if (!drag) return;
    if (commit) save();
    else {
      layout.widths = drag.before;
      apply();
    }
    const id = drag.id;
    drag = null;
    delete sheet.dataset.resizing;
    if (rail.hasPointerCapture(id)) rail.releasePointerCapture(id);
  }
  const handleIndex = (e: Event) =>
    e.target instanceof HTMLElement && e.target.parentNode === rail ? Number(e.target.dataset.column) : -1;
  rail.addEventListener("pointerdown", (e) => {
    const index = handleIndex(e);
    if (index < 0 || !e.isPrimary || e.button !== 0 || drag) return;
    e.preventDefault();
    drag = { id: e.pointerId, x: e.clientX, index, before: layout.widths, measured: measured() };
    sheet.dataset.resizing = "true";
    rail.setPointerCapture(e.pointerId);
  });
  rail.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const widths = [...drag.measured];
    widths[drag.index] = columnWidth(widths[drag.index] + e.clientX - drag.x);
    layout.widths = widths;
    apply();
  });
  rail.addEventListener("pointerup", (e) => {
    if (e.pointerId === drag?.id) finish(true);
  });
  rail.addEventListener("lostpointercapture", () => finish(false));
  rail.addEventListener("pointercancel", () => finish(false));
  rail.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && drag) {
      e.preventDefault();
      finish(false);
      return;
    }
    const i = handleIndex(e);
    if (i < 0 || !["ArrowLeft", "ArrowRight"].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    const widths = measured();
    widths[i] = columnWidth(widths[i] + (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 32 : 8));
    layout.widths = widths;
    apply();
    save();
  });
  return {
    rail,
    apply,
    sync(count: number) {
      if (count === columns) {
        // Intrinsic column widths can change after text edits without resizing the overall table.
        if (!layout.wrap && !layout.widths.length) schedule();
        return;
      }
      finish(false);
      columns = count;
      if (layout.widths.length !== count) layout.widths = [];
      rail.replaceChildren(
        ...Array.from({ length: count }, (_, index) => {
          const bar = document.createElement("span");
          bar.tabIndex = 0;
          bar.dataset.column = String(index);
          bar.setAttribute("role", "separator");
          bar.setAttribute("aria-orientation", "vertical");
          bar.setAttribute("aria-label", `Resize column ${index + 1}`);
          bar.setAttribute("aria-valuemin", String(minColumnWidth));
          bar.setAttribute("aria-valuemax", String(maxColumnWidth));
          return bar;
        }),
      );
      apply();
    },
    destroy() {
      finish(false);
      observer.disconnect();
      cancelAnimationFrame(frame);
    },
  };
}
