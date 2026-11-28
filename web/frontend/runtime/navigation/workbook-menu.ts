import { createButton } from "@folio/editor-runtime";
import { decodedArray, decodedNumber, decodedObject, decodedString } from "../../api/contracts";
import { errorContext } from "../../types/errors";

export interface ColumnFilter {
  col: number;
  values: string[];
  exclude: boolean;
}

export function openColumnMenu(
  anchor: HTMLButtonElement,
  name: string,
  filter: ColumnFilter | undefined,
  signal: AbortSignal,
  values: (signal: AbortSignal) => Promise<unknown>,
  apply: (filter: Omit<ColumnFilter, "col"> | undefined) => void,
  sort: (direction: "asc" | "desc" | "none") => void,
  direction: "asc" | "desc" | "none",
) {
  const owner = new AbortController();
  const scope = AbortSignal.any([signal, owner.signal]);
  const menu = document.createElement("div");
  menu.className = "sheet-column-menu";
  menu.popover = "auto";
  menu.setAttribute("role", "dialog");
  menu.setAttribute("aria-label", `${name} filter and sort`);
  let frame = 0;
  const close = () => {
    if (owner.signal.aborted) return;
    owner.abort();
    cancelAnimationFrame(frame);
    menu.remove();
    anchor.setAttribute("aria-expanded", "false");
  };
  signal.addEventListener("abort", close, { once: true, signal: owner.signal });
  menu.addEventListener("toggle", () => {
    if (!menu.matches(":popover-open")) close();
  });

  const heading = document.createElement("div"),
    title = document.createElement("strong");
  heading.className = "sheet-filter-heading";
  title.textContent = name;
  title.title = name;
  const dismiss = createButton({
    label: "Close filter",
    icon: "x",
    onClick: () => {
      close();
      anchor.focus({ preventScroll: true });
    },
  });
  heading.append(title, dismiss);
  const sorting = document.createElement("div");
  sorting.className = "sheet-sort";
  for (const [label, value, glyph] of [
    ["Ascending", "asc", "↑"],
    ["Descending", "desc", "↓"],
    ["Unsorted", "none", "↕"],
  ] as const) {
    const button = createButton({ label: label });
    button.addEventListener("click", () => {
      close();
      anchor.focus({ preventScroll: true });
      sort(value);
    });
    const icon = document.createElement("span"),
      mark = document.createElement("span");
    icon.textContent = glyph;
    mark.textContent = value === direction ? "✓" : "";
    icon.setAttribute("aria-hidden", "true");
    mark.setAttribute("aria-hidden", "true");
    button.prepend(icon);
    button.append(mark);
    button.setAttribute("aria-pressed", String(value === direction));
    sorting.append(button);
  }
  const search = document.createElement("input");
  search.type = "search";
  search.placeholder = "Search values…";
  search.setAttribute("aria-label", `Search ${name} values`);
  const list = document.createElement("div"),
    spacer = document.createElement("div");
  list.className = "sheet-filter-values";
  list.setAttribute("aria-label", "Column values");
  list.setAttribute("role", "list");
  list.tabIndex = -1;
  list.append(spacer);
  const message = document.createElement("p");
  message.setAttribute("role", "status");
  message.textContent = "Loading…";
  const select = document.createElement("input"),
    count = document.createElement("small");
  count.setAttribute("aria-hidden", "true");
  select.type = "checkbox";
  select.disabled = true;
  const all = document.createElement("label");
  all.className = "sheet-filter-all";
  all.append(select, "Select all", count);
  const footer = document.createElement("div");
  footer.className = "sheet-filter-actions";
  const confirm = createButton({ label: "Apply" });
  confirm.addEventListener("click", () => {
    const selected = (search.value ? visible : entries)
      .filter((entry) => chosen.has(entry.text))
      .map((entry) => entry.text);
    const included = new Set(selected);
    const excluded = entries.filter((entry) => !included.has(entry.text)).map((entry) => entry.text);
    close();
    anchor.focus({ preventScroll: true });
    apply(
      excluded.length === 0
        ? undefined
        : selected.length <= excluded.length
          ? { values: selected, exclude: false }
          : { values: excluded, exclude: true },
    );
  });
  confirm.disabled = true;
  footer.append(
    createButton({
      label: "Clear",
      onClick: () => {
        close();
        anchor.focus({ preventScroll: true });
        apply(undefined);
      },
    }),
    createButton({
      label: "Cancel",
      onClick: () => {
        close();
        anchor.focus({ preventScroll: true });
      },
    }),
    confirm,
  );
  confirm.className = "button-primary";
  menu.append(heading, sorting, search, all, message, list, footer);
  type Entry = { text: string; count: number; lower: string };
  let entries: Entry[] = [],
    visible: Entry[] = [],
    active = 0,
    start = -1,
    end = -1;
  const chosen = new Set<string>();
  const rowHeight = 28;
  function updateAll() {
    const selected = visible.reduce((n, entry) => n + Number(chosen.has(entry.text)), 0);
    select.checked = visible.length > 0 && selected === visible.length;
    select.indeterminate = selected > 0 && selected < visible.length;
    count.textContent = `${selected} / ${visible.length}`;
  }
  function render(focus = false) {
    const first = Math.max(0, Math.floor(list.scrollTop / rowHeight) - 3);
    const last = Math.min(visible.length, first + Math.ceil((list.clientHeight || 196) / rowHeight) + 7);
    const focused = list.contains(document.activeElement);
    if (start !== first || end !== last) {
      start = first;
      end = last;
      spacer.style.height = `${visible.length * rowHeight}px`;
      spacer.replaceChildren(
        ...visible.slice(start, end).map((entry, offset) => {
          const index = start + offset;
          const label = document.createElement("label"),
            checkbox = document.createElement("input");
          label.style.top = `${index * rowHeight}px`;
          label.setAttribute("role", "listitem");
          label.setAttribute("aria-posinset", String(index + 1));
          label.setAttribute("aria-setsize", String(visible.length));
          checkbox.type = "checkbox";
          checkbox.dataset.index = String(index);
          checkbox.onfocus = () => {
            active = index;
          };
          checkbox.onchange = () => {
            if (checkbox.checked) chosen.add(entry.text);
            else chosen.delete(entry.text);
            updateAll();
          };
          const title = document.createElement("span"),
            total = document.createElement("small");
          title.textContent = entry.text || "(Blank)";
          title.title = title.textContent;
          total.textContent = String(entry.count);
          label.append(checkbox, title, total);
          return label;
        }),
      );
    }
    for (const checkbox of spacer.querySelectorAll("input")) {
      const index = Number(checkbox.dataset.index);
      checkbox.checked = chosen.has(visible[index].text);
      checkbox.tabIndex = index === active ? 0 : -1;
    }
    if (focus || focused) {
      const checkbox = spacer.querySelector<HTMLInputElement>(`[data-index="${active}"]`);
      (checkbox ?? list).focus({ preventScroll: true });
    }
    updateAll();
  }
  const move = (index: number) => {
    active = Math.max(0, Math.min(visible.length - 1, index));
    if (active * rowHeight < list.scrollTop) list.scrollTop = active * rowHeight;
    else if ((active + 1) * rowHeight > list.scrollTop + list.clientHeight)
      list.scrollTop = (active + 1) * rowHeight - list.clientHeight;
    render(true);
  };
  list.onscroll = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => render());
  };
  list.onkeydown = (event) => {
    const index =
      event.key === "ArrowDown"
        ? active + 1
        : event.key === "ArrowUp"
          ? active - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? visible.length - 1
              : event.key === "PageDown"
                ? active + 7
                : event.key === "PageUp"
                  ? active - 7
                  : -1;
    if (index < 0 || !visible.length) return;
    event.preventDefault();
    move(index);
  };
  const searchValues = () => {
    const query = search.value.toLocaleLowerCase();
    visible = query ? entries.filter((entry) => entry.lower.includes(query)) : entries;
    list.style.flexBasis = `${Math.max(28, Math.min(196, visible.length * rowHeight))}px`;
    active = 0;
    start = -1;
    list.scrollTop = 0;
    message.textContent = visible.length ? "" : "No matching values";
    confirm.disabled = !visible.length;
    render();
    place();
  };
  search.oninput = searchValues;
  select.onchange = () => {
    for (const entry of visible) {
      if (select.checked) chosen.add(entry.text);
      else chosen.delete(entry.text);
    }
    render();
  };
  menu.onkeydown = (event) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      anchor.focus({ preventScroll: true });
    } else if (event.target === search && event.key === "ArrowDown" && visible.length) {
      event.preventDefault();
      move(0);
    } else if (event.key === "Enter" && event.target === search && !confirm.disabled) {
      event.preventDefault();
      confirm.click();
    }
  };
  document.body.append(menu);
  anchor.setAttribute("aria-expanded", "true");
  menu.showPopover();
  menu.style.margin = "0";
  menu.style.inset = "auto";
  const place = () => {
    const bounds = anchor.getBoundingClientRect(),
      rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(bounds.left, innerWidth - rect.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(bounds.bottom + 3, innerHeight - rect.height - 8))}px`;
  };
  place();
  search.focus({ preventScroll: true });
  void values(scope)
    .then((response) => {
      if (scope.aborted) return;
      const data = decodedObject(response, "column values");
      entries = decodedArray(
        data.values,
        (value) => {
          if (!Array.isArray(value) || value.length !== 2) throw new Error("Invalid column values.");
          const text = decodedString(value[0], "column value");
          return { text, count: decodedNumber(value[1], "value count"), lower: text.toLocaleLowerCase() };
        },
        "column values",
      );
      const selected = new Set(filter?.values);
      for (const entry of entries) if (!filter || selected.has(entry.text) !== filter.exclude) chosen.add(entry.text);
      select.disabled = false;
      searchValues();
      place();
    })
    .catch((cause: unknown) => {
      if (!scope.aborted) message.textContent = errorContext(cause).message;
    });
  return close;
}
