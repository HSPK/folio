const paths = {
  file: "M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9ZM14 3v6h6M8 14h8M8 17h5",
  "file-plus": "M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9ZM14 3v6h6M12 12v6M9 15h6",
  "file-minus": "M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9ZM14 3v6h6M9 15h6",
  folder: "M3 8V6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z",
  "folder-plus": "M3 8V6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2ZM12 11v6M9 14h6",
  refresh: "M20 5v5h-5M4 19v-5h5M5.4 8a7 7 0 0 1 11.5-3L20 8M4 16l3.1 3A7 7 0 0 0 18.6 16",
  search: "M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM15.2 15.2 21 21",
  download: "M12 3v12M7 10l5 5 5-5M4 17v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3",
  upload: "M12 16V4M7 9l5-5 5 5M4 17v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3",
  check: "m5 12 4.5 4.5L19 7",
  "circle-check": "M21 12a9 9 0 1 1-4-7.5M8 11.5l4 4 9-10",
  "circle-dot": "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM12 12h.01",
  "circle-help": "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM9.5 9a2.5 2.5 0 1 1 4.5 1.5c-1 1-2 1-2 2.5M12 17h.01",
  sidebar: "M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2ZM9 4v16",
  "expand-width": "M3 5v14M21 5v14M7 12h10M10 9l-3 3 3 3M14 9l3 3-3 3",
  command: "M9 7V5a2 2 0 1 0-2 2h10a2 2 0 1 0-2-2v14a2 2 0 1 0 2-2H7a2 2 0 1 0 2 2Z",
  settings:
    "m9.5 3-.6 2.3-2 .9-2.1-.7-2.5 4.2 1.7 1.6v2.4l-1.7 1.6 2.5 4.2 2.1-.7 2 .9.6 2.3h5l.6-2.3 2-.9 2.1.7 2.5-4.2-1.7-1.6v-2.4l1.7-1.6-2.5-4.2-2.1.7-2-.9-.6-2.3ZM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z",
  "more-horizontal": "M5 12h.01M12 12h.01M19 12h.01",
  x: "m6 6 12 12M18 6 6 18",
  "chevron-down": "m6 9 6 6 6-6",
  "arrow-left": "M20 12H4m6-6-6 6 6 6",
  "arrow-right": "M4 12h16m-6-6 6 6-6 6",
  "arrow-up": "M12 20V4m-6 6 6-6 6 6",
  "arrow-down": "M12 4v16m-6-6 6 6 6-6",
  "arrow-left-right": "M3 7h18m-4-4 4 4-4 4M21 17H3m4-4-4 4 4 4",
  plus: "M12 5v14M5 12h14",
  minus: "M5 12h14",
  grip: "M8 5h.01M16 5h.01M8 12h.01M16 12h.01M8 19h.01M16 19h.01",
  trash: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7",
  "circle-x": "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM9 9l6 6M15 9l-6 6",
  image: "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM3 17l6-6 5 5 3-3 4 4M16 7h.01",
  "zoom-in": "M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM15.2 15.2 21 21M7.5 10.5h6M10.5 7.5v6",
  "align-left": "M4 5h16M4 10h10M4 15h16M4 20h10",
  "align-center": "M4 5h16M7 10h10M4 15h16M7 20h10",
  "align-right": "M4 5h16M10 10h10M4 15h16M10 20h10",
  lock: "M7 10V7a5 5 0 0 1 10 0v3M6 10h12a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2ZM12 14v3",
  users:
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM22 21v-2a4 4 0 0 0-3-3.9M17 3.1a4 4 0 0 1 0 7.8",
  globe: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18M12 3a17 17 0 0 1 0 18 17 17 0 0 1 0-18Z",
  link: "m10 13 4-4M9 16l-2 2a4 4 0 0 1-5-5l4-4a4 4 0 0 1 5 0M15 8l2-2a4 4 0 0 1 5 5l-4 4a4 4 0 0 1-5 0",
  copy: "M9 8V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-3M5 8h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Z",
  edit: "m14 5 5 5M4 20l5-1L20 8a3.5 3.5 0 0 0-5-5L4 14ZM3 21h18",
  "triangle-alert": "m10.3 4-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3l-8-14a2 2 0 0 0-3.4 0ZM12 9v4M12 17h.01",
  text: "M4 5h16M12 5v15M8 20h8",
  "heading-1": "M4 5v14M13 5v14M4 12h9M17 9l3-2v12M17 19h6",
  "heading-2": "M3 5v14M11 5v14M3 12h8M16 10a3 3 0 1 1 5 2l-5 7h6",
  "heading-3": "M3 5v14M11 5v14M3 12h8M16 8h3a2.5 2.5 0 0 1 0 5h-1M18 13h1a3 3 0 0 1 0 6h-3",
  list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  "list-ordered": "M9 6h12M9 12h12M9 18h12M3 4h1v5M2 9h4M2 15a2 2 0 1 1 3.5 1.3L2 20h4",
  quote: "M10 5H4v7h6ZM4 12c0 4 2 6 5 7M21 5h-6v7h6ZM15 12c0 4 2 6 5 7",
  code: "m8 6-6 6 6 6M16 6l6 6-6 6M14 3l-4 18",
  table: "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM3 9h18M3 15h18M9 3v18M15 3v18",
};

const attributes = {
  viewBox: "0 0 24 24",
  width: "18",
  height: "18",
  fill: "none",
  stroke: "currentColor",
  "stroke-width": "1.7",
  "stroke-linecap": "round",
  "stroke-linejoin": "round",
  "aria-hidden": "true",
  focusable: "false",
};
export type IconName = keyof typeof paths;
const templates = new WeakMap<Document, Map<IconName, SVGSVGElement>>();

function isIconName(name: unknown): name is IconName {
  return typeof name === "string" && Object.hasOwn(paths, name);
}

export function createIcon(name: unknown, ownerDocument = document) {
  if (!isIconName(name)) throw new Error(`Unknown interface icon: ${String(name)}`);
  let icons = templates.get(ownerDocument);
  if (!icons) {
    icons = new Map();
    templates.set(ownerDocument, icons);
  }
  let template = icons.get(name);
  if (!template) {
    const svg = ownerDocument.createElementNS("http://www.w3.org/2000/svg", "svg");
    for (const [key, value] of Object.entries(attributes)) svg.setAttribute(key, value);
    svg.classList.add("folio-icon");
    svg.dataset.icon = name;
    const shape = ownerDocument.createElementNS(svg.namespaceURI, "path");
    shape.setAttribute("d", paths[name]);
    svg.append(shape);
    icons.set(name, svg);
    template = svg;
  }
  return ownerDocument.importNode(template, true);
}

export function hydrateIcons(root: ParentNode) {
  for (const svg of root.querySelectorAll<SVGSVGElement>("svg[data-icon]")) {
    const icon = createIcon(svg.dataset.icon, svg.ownerDocument);
    for (const [key, value] of Object.entries(attributes)) svg.setAttribute(key, value);
    svg.classList.add("folio-icon");
    svg.replaceChildren(...icon.childNodes);
  }
}
