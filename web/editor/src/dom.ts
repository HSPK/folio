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
