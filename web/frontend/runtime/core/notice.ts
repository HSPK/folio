export function setText(node: HTMLElement, text: string | null): void {
  if (node.textContent !== text) node.textContent = text;
}

export function notice(node: HTMLElement, text: string | null, kind = ""): void {
  setText(node, text);
  node.hidden = !text;
  node.classList.toggle("is-error", kind === "error");
  node.classList.toggle("is-warning", kind === "warning");
  node.classList.toggle("is-success", kind === "success");
}
