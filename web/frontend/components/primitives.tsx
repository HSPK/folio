import { autoUpdate, computePosition, flip, offset, shift, size } from "@floating-ui/dom";
import { onCleanup, onMount, splitProps, type JSX } from "solid-js";
import { requiredQuery } from "../types/elements";

type IconButtonProps = Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, "children" | "type" | "aria-label"> & {
  label: string;
  icon: string;
};

export function IconButton(props: IconButtonProps) {
  const [local, attributes] = splitProps(props, ["label", "icon", "title", "class"]);
  return (
    <button
      {...attributes}
      class={local.class ?? "icon-button"}
      type="button"
      title={local.title ?? local.label}
      aria-label={local.label}
    >
      <svg data-icon={local.icon} aria-hidden="true"></svg>
    </button>
  );
}

export function DialogHeading(props: { id: string; title: string }) {
  return (
    <header class="workspace-heading">
      <h2 id={`${props.id}-title`}>{props.title}</h2>
      <IconButton id={`${props.id}-close`} title="Close" label={`Close ${props.title.toLowerCase()}`} icon="x" />
    </header>
  );
}

function menuItems(panel: HTMLElement) {
  return [...panel.querySelectorAll<HTMLElement>("button:not(:disabled), a[href], summary")].filter(
    (node) => node.getClientRects().length && !node.closest("[hidden], [inert]"),
  );
}

export function navigateMenu(event: KeyboardEvent, panel: HTMLElement) {
  if (
    !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) ||
    event.target instanceof HTMLInputElement ||
    event.target instanceof HTMLSelectElement
  )
    return;
  const items = menuItems(panel);
  if (!items.length) return;
  const active = document.activeElement;
  const index = active instanceof HTMLElement ? items.indexOf(active) : -1;
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
  event.preventDefault();
  items[next].focus();
}

/** Native popovers own visibility, dismissal and focus; only positioning needs a service. */
export function AppMenu(props: JSX.IntrinsicElements["div"]) {
  let menu!: HTMLDivElement;
  onMount(() => {
    const trigger = requiredQuery(menu, ":scope > button", HTMLButtonElement);
    const panel = requiredQuery(menu, ":scope > [popover]", HTMLDivElement);
    const controller = new AbortController();
    const { signal } = controller;
    let stop: (() => void) | undefined;
    let generation = 0;
    panel.addEventListener(
      "beforetoggle",
      (event) => {
        const open = event.newState === "open";
        const current = ++generation;
        panel.inert = !open;
        trigger.setAttribute("aria-expanded", String(open));
        stop?.();
        stop = undefined;
        if (!open) return;
        // Native opening finishes before the next animation frame.
        const frame = requestAnimationFrame(() => {
          if (signal.aborted || current !== generation) return;
          stop = autoUpdate(trigger, panel, () => {
            void computePosition(trigger, panel, {
              placement: "bottom-end",
              strategy: "fixed",
              middleware: [
                offset(5),
                flip({ padding: 12 }),
                shift({ padding: 12 }),
                size({
                  padding: 12,
                  apply({ availableWidth, availableHeight }) {
                    panel.style.maxWidth = `${availableWidth}px`;
                    panel.style.maxHeight = `${Math.min(680, availableHeight)}px`;
                  },
                }),
              ],
            }).then(({ x, y }) => {
              if (signal.aborted || current !== generation) return;
              panel.style.left = `${x}px`;
              panel.style.top = `${y}px`;
            });
          });
          menuItems(panel)[0]?.focus({ preventScroll: true });
        });
        stop = () => cancelAnimationFrame(frame);
      },
      { signal },
    );
    panel.addEventListener("keydown", (event) => navigateMenu(event, panel), { signal });
    onCleanup(() => {
      controller.abort();
      stop?.();
    });
  });
  return <div {...props} ref={menu} />;
}
