import { createIcon } from "@folio/editor-runtime";
import { onApplicationDispose } from "../lifecycle";

/** Give every `[data-menu-icon]` action a leading glyph that survives later label rewrites. */
export function decorateMenuIcons(): void {
  const decorate = (node: HTMLElement) => {
    if (node.firstElementChild?.classList.contains("menu-icon")) return;
    node.querySelector(":scope > .menu-icon")?.remove();
    const icon = createIcon(node.dataset.menuIcon);
    icon.classList.add("menu-icon");
    node.prepend(icon);
  };
  const observer = new MutationObserver((records) => {
    for (const record of records) if (record.target instanceof HTMLElement) decorate(record.target);
  });
  onApplicationDispose(() => observer.disconnect());
  for (const node of document.querySelectorAll<HTMLElement>("[data-menu-icon]")) {
    decorate(node);
    observer.observe(node, { childList: true });
  }
}
