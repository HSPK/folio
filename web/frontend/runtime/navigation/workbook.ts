import { createButton } from "@folio/editor-runtime";
import { decodedArray, decodedNumber, decodedObject, decodedString } from "../../api/contracts";
import { errorContext } from "../../types/errors";
import { api } from "../core/api";
import { openColumnMenu, type ColumnFilter } from "./workbook-menu";

const button = (label: string, click: () => void) => {
  const el = createButton({ label: label });

  el.onclick = click;
  return el;
};
const columnName = (i: number): string =>
  (i >= 26 ? columnName(Math.floor(i / 26) - 1) : "") + String.fromCharCode(65 + (i % 26));

function sizeHandle(axis: "width" | "height", label: string, initial: number, apply: (n: number) => void) {
  const handle = document.createElement("span");
  const horizontal = axis === "width",
    min = horizontal ? 24 : 20,
    max = horizontal ? 1200 : 480;
  handle.className = `sheet-resize resize-${axis}`;
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-orientation", horizontal ? "vertical" : "horizontal");
  handle.setAttribute("aria-label", label);
  handle.setAttribute("aria-valuemin", String(min));
  handle.setAttribute("aria-valuemax", String(max));
  handle.setAttribute("aria-valuenow", String(initial));
  handle.title = label;
  handle.tabIndex = 0;
  let value = initial;
  const set = (next: number) => {
    value = Math.round(Math.max(min, Math.min(max, next)));
    handle.setAttribute("aria-valuenow", String(value));
    apply(value);
  };
  handle.onpointerdown = (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const start = horizontal ? event.clientX : event.clientY,
      before = value;
    handle.setPointerCapture(event.pointerId);
    handle.onpointermove = (e) => {
      if (e.pointerId === event.pointerId) set(before + (horizontal ? e.clientX : e.clientY) - start);
    };
    handle.onlostpointercapture = () => {
      handle.onpointermove = null;
    };
  };
  handle.onkeydown = (event) => {
    const delta =
      event.key === (horizontal ? "ArrowRight" : "ArrowDown")
        ? 1
        : event.key === (horizontal ? "ArrowLeft" : "ArrowUp")
          ? -1
          : 0;
    if (!delta) return;
    event.preventDefault();
    set(value + delta * (event.shiftKey ? 1 : 8));
  };
  return handle;
}

type SheetView = ReturnType<typeof emptyView>;
function emptyView() {
  return {
    row: 0,
    col: 0,
    filters: new Map<number, ColumnFilter>(),
    sortCol: -1,
    desc: false,
    widths: new Map<number, number>(),
    heights: new Map<number, number>(),
  };
}

export async function openWorkbook(
  url: string,
  signal: AbortSignal,
  body: HTMLElement,
  sheets: HTMLElement,
  tools: HTMLElement,
  status: HTMLElement,
) {
  const views = new Map<number, SheetView>();
  const facets = new Map<string, { request: Promise<unknown>; owner: AbortController; time: number }>();
  let sheet = 0,
    view = emptyView(),
    pending: AbortController | undefined,
    closeMenu: (() => void) | undefined;
  views.set(0, view);
  const paging = document.createElement("div");
  paging.className = "sheet-paging";
  tools.replaceChildren(paging);
  const clearFacets = () => {
    for (const entry of facets.values()) entry.owner.abort();
    facets.clear();
  };
  signal.addEventListener("abort", clearFacets, { once: true });

  function columnValues(column: number, current: SheetView, index: number) {
    const query = new URLSearchParams({ view: "values", sheet: String(index), facetCol: String(column) });
    const filters = [...current.filters.values()].filter((filter) => filter.col !== column);
    if (filters.length) query.set("filters", JSON.stringify(filters));
    const key = query.toString(),
      cached = facets.get(key);
    if (cached && Date.now() - cached.time < 2000) return cached.request;
    cached?.owner.abort();
    facets.delete(key);
    while (facets.size >= 4) {
      const first = facets.keys().next().value!;
      facets.get(first)!.owner.abort();
      facets.delete(first);
    }
    const owner = new AbortController();
    const request = api(`${url}&${query}`, { signal: AbortSignal.any([signal, owner.signal]) }).catch((cause) => {
      if (facets.get(key)?.owner === owner) facets.delete(key);
      throw cause;
    });
    facets.set(key, { request, owner, time: Date.now() });
    return request;
  }

  function switchSheet(index: number) {
    if (sheet === index) return;
    sheet = index;
    view = views.get(index) ?? emptyView();
    views.set(index, view);
    void load();
  }
  function renderTabs(names: string[]) {
    if (names.length !== sheets.childElementCount || names.some((n, i) => sheets.children[i]?.textContent !== n))
      sheets.replaceChildren(
        ...names.map((name, i) => {
          const tab = button(name, () => switchSheet(i));
          tab.title = name;
          tab.setAttribute("role", "tab");
          tab.tabIndex = i === sheet ? 0 : -1;
          tab.setAttribute("aria-selected", String(i === sheet));
          tab.id = `sheet-tab-${i}`;
          tab.setAttribute("aria-controls", body.id);
          tab.onkeydown = (e) => {
            const next =
              e.key === "ArrowRight"
                ? (i + 1) % names.length
                : e.key === "ArrowLeft"
                  ? (i + names.length - 1) % names.length
                  : e.key === "Home"
                    ? 0
                    : e.key === "End"
                      ? names.length - 1
                      : -1;
            if (next < 0) return;
            e.preventDefault();
            const el = sheets.children[next];
            if (el instanceof HTMLButtonElement) {
              el.focus();
              el.click();
            }
          };
          return tab;
        }),
      );
    body.setAttribute("role", "tabpanel");
    body.setAttribute("aria-labelledby", `sheet-tab-${sheet}`);
  }
  async function load(message = "Loading…") {
    closeMenu?.();
    pending?.abort();
    clearFacets();
    const request = (pending = new AbortController());
    body.setAttribute("aria-busy", "true");
    status.textContent = message;
    for (const [i, tab] of [...sheets.querySelectorAll("button")].entries()) {
      tab.tabIndex = i === sheet ? 0 : -1;
      tab.setAttribute("aria-selected", String(i === sheet));
    }
    const { row, col, sortCol, desc } = view;
    const params = new URLSearchParams({ view: "table", sheet: String(sheet), row: String(row), col: String(col) });
    if (view.filters.size) params.set("filters", JSON.stringify([...view.filters.values()]));
    if (sortCol !== -1) {
      params.set("sortCol", String(sortCol));
      params.set("desc", String(desc));
    }
    try {
      const data = decodedObject(
        await api(`${url}&${params}`, { signal: AbortSignal.any([signal, request.signal]) }),
        "worksheet",
      );
      if (signal.aborted || request !== pending) return;
      const names = decodedArray(data.sheets, (n) => decodedString(n, "sheet name"), "sheets");
      const headers = decodedArray(data.headers, (n) => decodedString(n, "column header"), "headers");
      const numbers = decodedArray(data.rowNumbers, (n) => decodedNumber(n, "row number"), "row numbers");
      const height = decodedNumber(data.height, "height"),
        width = decodedNumber(data.width, "width");
      const rows = decodedNumber(data.rows, "page rows"),
        cols = decodedNumber(data.cols, "page columns");
      const values: string[] = [];
      const layout = decodedObject(data.layout, "worksheet layout");
      const rowHeights = new Map(
        decodedArray(
          layout.rowHeights,
          (entry): [number, number] => {
            if (!Array.isArray(entry)) throw new Error("Invalid row height.");
            return [decodedNumber(entry[0], "row"), decodedNumber(entry[1], "height")];
          },
          "row heights",
        ),
      );
      const columnWidths = decodedArray(
        layout.columnWidths,
        (entry): [number, number, number] => {
          if (!Array.isArray(entry)) throw new Error("Invalid column width.");
          return entry.map((n) => decodedNumber(n, "column width")) as [number, number, number];
        },
        "column widths",
      );
      if (!Array.isArray(data.cells)) throw new Error("Invalid worksheet.");
      for (const cell of data.cells) {
        if (!Array.isArray(cell) || cell.length !== 3) throw new Error("Invalid cell.");
        const r = decodedNumber(cell[0], "cell row") - row;
        const c = decodedNumber(cell[1], "cell column") - col;
        if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || r >= rows || c < 0 || c >= cols)
          throw new Error("Invalid cell.");
        values[r * cols + c] = decodedString(cell[2], "cell");
      }
      renderTabs(names);
      const oldFocus =
        document.activeElement instanceof HTMLElement ? document.activeElement.dataset.sortColumn : undefined;
      const table = document.createElement("table"),
        columns = document.createElement("colgroup");
      table.className = "sheet-grid";
      table.setAttribute("aria-label", names[sheet]);
      table.append(columns);
      const numberCol = document.createElement("col");
      numberCol.style.width = "48px";
      columns.append(numberCol);
      const head = table.createTHead().insertRow(),
        tbody = table.createTBody();
      head.append(document.createElement("th"));
      if (typeof layout.headerHeight === "number")
        table.style.setProperty("--sheet-header-height", `${layout.headerHeight}px`);
      const widths = headers.map((label, i) => {
        const c = col + i;
        if (view.widths.has(c)) return view.widths.get(c)!;
        const stored = columnWidths.findLast(([start, end]) => c >= start && c <= end)?.[2] ?? layout.defaultWidth;
        if (typeof stored === "number") {
          view.widths.set(c, stored);
          return stored;
        }
        const sample = [label, ...numbers.map((_, r) => values[r * cols + i] ?? "")];
        const length = Math.max(
          ...sample.map((s) =>
            Math.max(
              ...s
                .slice(0, 512)
                .split("\n")
                .map((line) => [...line.slice(0, 80)].reduce((n, ch) => n + (ch.charCodeAt(0) > 255 ? 1.8 : 1), 0)),
            ),
          ),
        );
        const width = Math.max(104, Math.min(320, Math.round(30 + length * 7.5)));
        view.widths.set(c, width);
        return width;
      });
      const setWidth = () => {
        table.style.width = `${48 + widths.reduce((a, b) => a + b, 0)}px`;
      };
      headers.forEach((label, i) => {
        const c = col + i,
          name = label || columnName(c);
        const column = document.createElement("col");
        column.style.width = `${widths[i]}px`;
        columns.append(column);
        const th = document.createElement("th");
        th.scope = "col";
        th.setAttribute("aria-sort", c !== sortCol ? "none" : desc ? "descending" : "ascending");
        const sort = button(name, () => {
          closeMenu?.();
          const currentView = view;
          closeMenu = openColumnMenu(
            sort,
            name,
            view.filters.get(c),
            signal,
            () => columnValues(c, currentView, sheet),
            (filter) => {
              if (filter) currentView.filters.set(c, { col: c, ...filter });
              else currentView.filters.delete(c);
              currentView.row = 0;
              void load("Filtering…");
            },
            (direction) => {
              currentView.sortCol = direction === "none" ? -1 : c;
              currentView.desc = direction === "desc";
              currentView.row = 0;
              void load("Sorting…");
            },
            c === currentView.sortCol ? (currentView.desc ? "desc" : "asc") : "none",
          );
        });
        sort.onpointerenter = () => {
          if (pending !== request || signal.aborted) return;
          void columnValues(c, view, sheet).catch(() => {});
        };
        sort.dataset.sortColumn = String(c);
        sort.title = `Filter and sort ${name}`;
        sort.setAttribute("aria-label", name);
        sort.setAttribute("aria-haspopup", "dialog");
        sort.setAttribute("aria-expanded", "false");
        if (view.filters.has(c)) sort.dataset.filtered = "";
        th.append(
          sort,
          sizeHandle("width", `Resize column ${columnName(c)}`, widths[i], (n) => {
            view.widths.set(c, n);
            widths[i] = n;
            column.style.width = `${n}px`;
            setWidth();
          }),
        );
        head.append(th);
      });
      setWidth();
      numbers.forEach((number, i) => {
        const tr = tbody.insertRow(),
          th = document.createElement("th");
        let h =
          view.heights.get(number) ??
          rowHeights.get(number) ??
          (typeof layout.defaultHeight === "number" ? layout.defaultHeight : undefined);
        if (h === undefined) {
          const wrappedLines = Math.max(
            1,
            ...headers.map((_, j) =>
              (values[i * cols + j] ?? "")
                .slice(0, 512)
                .split("\n")
                .reduce(
                  (lines, text) =>
                    lines +
                    Math.max(
                      1,
                      Math.ceil(
                        ([...text].reduce((n, ch) => n + (ch.charCodeAt(0) > 255 ? 1.8 : 1), 0) * 7.5) /
                          Math.max(10, widths[j] - 18),
                      ),
                    ),
                  0,
                ),
            ),
          );
          h = Math.min(112, Math.max(28, wrappedLines * 18 + 2));
        }
        tr.style.setProperty("--sheet-row-height", `${h}px`);
        th.scope = "row";
        th.textContent = String(number);
        th.append(
          sizeHandle("height", `Resize row ${number}`, h, (n) => {
            view.heights.set(number, n);
            tr.style.setProperty("--sheet-row-height", `${n}px`);
          }),
        );
        tr.append(th);
        headers.forEach((_, j) => {
          const text = document.createElement("span");
          text.textContent = values[i * cols + j] ?? "";
          tr.insertCell().append(text);
        });
      });
      paging.replaceChildren();
      for (const [label, icon, r, c, disabled, show] of [
        ["Previous rows", "arrow-up", row - rows, col, row === 0, height > rows],
        ["Next rows", "arrow-down", row + rows, col, row + rows >= height, height > rows],
        ["Previous columns", "arrow-left", row, col - cols, col === 0, width > cols],
        ["Next columns", "arrow-right", row, col + cols, col + cols >= width, width > cols],
      ] as const) {
        if (!show) continue;
        const b = createButton({
          label,
          icon,
          onClick: () => {
            view.row = r;
            view.col = c;
            void load();
          },
        });
        b.setAttribute("aria-label", label);
        b.title = label;
        b.disabled = disabled;
        paging.append(b);
      }
      body.replaceChildren(table);
      if (oldFocus !== undefined)
        table
          .querySelector<HTMLElement>(`[data-sort-column="${CSS.escape(oldFocus)}"]`)
          ?.focus({ preventScroll: true });
      body.scrollTop = 0;
      status.textContent = !width ? "Empty worksheet" : !height && view.filters.size ? "No matching rows" : "";
    } catch (cause) {
      if (!request.signal.aborted && !signal.aborted) status.textContent = errorContext(cause).message;
    } finally {
      if (!signal.aborted && pending === request) body.removeAttribute("aria-busy");
    }
  }
  await load();
}
