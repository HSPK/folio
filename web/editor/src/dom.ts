import { createIcon } from "./icons.ts";

export function createButton({
  label,
  icon,
  text,
  onClick,
}: {
  label: string;
  icon?: string;
  text?: string;
  onClick?: (event: MouseEvent) => void;
}) {
  const button = document.createElement("button");
  button.type = "button";
  button.title = label;
  const caption = text ?? (icon ? "" : label);
  if (icon || caption !== label) button.setAttribute("aria-label", label);
  if (icon) button.append(createIcon(icon));
  if (caption) button.append(document.createTextNode(caption));
  if (onClick) button.addEventListener("click", onClick);
  return button;
}

export function closestElement(target: EventTarget | null, selector: string) {
  const element = target instanceof Element ? target.closest(selector) : null;
  return element instanceof HTMLElement ? element : null;
}

export function isElement(node: Node): node is Element {
  return node.nodeType === Node.ELEMENT_NODE;
}

export function nodeElement(node: Node | null) {
  return node ? (isElement(node) ? node : node.parentElement) : null;
}
