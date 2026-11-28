import type { Lifetime } from "./lifetime";

const pending = new WeakMap<HTMLButtonElement, () => void>();
export const resetButtonFeedback = (button: HTMLButtonElement) => pending.get(button)?.();

export function buttonFeedback(button: HTMLButtonElement, label: string, lifetime: Lifetime) {
  pending.get(button)?.();
  if (lifetime.signal.aborted || !button.isConnected) return;
  const children = [...button.childNodes];
  const aria = button.getAttribute("aria-label");
  let release = () => {};
  const reset = () => {
    clearTimeout(timer);
    release();
    if (pending.get(button) !== reset) return;
    pending.delete(button);
    if (button.textContent === label) button.replaceChildren(...children);
    if (button.getAttribute("aria-label") === label) {
      if (aria === null) button.removeAttribute("aria-label");
      else button.setAttribute("aria-label", aria);
    }
  };
  button.textContent = label;
  button.setAttribute("aria-label", label);
  pending.set(button, reset);
  const timer = window.setTimeout(reset, 1600);
  release = lifetime.defer(reset);
}
