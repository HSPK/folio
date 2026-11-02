import * as Dialog from "@kobalte/core/dialog";
import * as Popover from "@kobalte/core/popover";
import {
  createContext,
  createSignal,
  onCleanup,
  onMount,
  Show,
  splitProps,
  useContext,
  type Accessor,
  type JSX,
} from "solid-js";
import { insert, spread } from "solid-js/web";

type AppDialogProps = Omit<JSX.IntrinsicElements["dialog"], "ref" | "open"> & {
  id: string;
};

/** Mount only the interaction layer; native form and editor references stay stable. */
export function AppDialog(props: AppDialogProps) {
  const [open, setOpen] = createSignal(false);
  const [local, attributes] = splitProps(props, ["children", "id"]);
  let dialog!: HTMLDialogElement;
  let nativeShow: HTMLDialogElement["showModal"];
  let nativeClose: HTMLDialogElement["close"];

  function close(value?: string) {
    setOpen(false);
    nativeClose.call(dialog, value);
  }

  function dismiss() {
    if (dialog.open && dialog.dispatchEvent(new Event("cancel", { cancelable: true }))) close();
  }

  function bind(node: HTMLDialogElement) {
    dialog = node;
    nativeShow = node.showModal;
    nativeClose = node.close;
    node.showModal = () => {
      nativeShow.call(node);
      setOpen(true);
    };
    node.close = close;
    const synchronize = () => setOpen(node.open);
    node.addEventListener("close", synchronize);
    onCleanup(() => {
      node.removeEventListener("close", synchronize);
      node.showModal = nativeShow;
      node.close = nativeClose;
    });
  }

  function InteractionLayer(layer: JSX.IntrinsicElements["dialog"]) {
    spread(dialog, layer, false, true);
    return null;
  }

  return (
    <Dialog.Root
      open={open()}
      modal={false}
      onOpenChange={(next) => {
        if (!next) dismiss();
      }}
      preventScroll={false}
    >
      <dialog {...attributes} id={local.id} ref={bind}>
        {local.children}
      </dialog>
      <Show when={open()}>
        <Dialog.Content
          as={InteractionLayer}
          id={local.id}
          aria-labelledby={props["aria-labelledby"]}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            dismiss();
          }}
        />
      </Show>
    </Dialog.Root>
  );
}

interface MenuPanel {
  host: HTMLElement;
  panel: HTMLDivElement;
}

interface MenuContextValue {
  open: Accessor<boolean>;
  setOpen: (next: boolean) => void;
  panels: Set<MenuPanel>;
  trigger: () => HTMLElement | null;
}

const MenuContext = createContext<MenuContextValue>();

function menuContext() {
  const context = useContext(MenuContext);
  if (!context) throw new Error("Menu primitives must be inside AppMenu.");
  return context;
}

/** Bridge persistent popup contents to a conditionally mounted Kobalte layer. */
export function AppMenu(props: JSX.IntrinsicElements["details"]) {
  const [open, setOpen] = createSignal(false);
  const [local, attributes] = splitProps(props, ["children", "ref", "open"]);
  const panels = new Set<MenuPanel>();
  let details!: HTMLDetailsElement;
  const descriptor = Object.getOwnPropertyDescriptor(HTMLDetailsElement.prototype, "open");
  if (!descriptor?.get || !descriptor.set) throw new Error("Native details state is unavailable.");
  const nativeGet = descriptor.get;
  const nativeSet = descriptor.set;

  function changeOpen(next: boolean) {
    nativeSet.call(details, next);
    setOpen(next);
    if (!next) for (const { host, panel } of panels) host.append(panel);
  }

  const context: MenuContextValue = {
    open,
    setOpen: changeOpen,
    panels,
    trigger: () => details.querySelector(":scope > summary"),
  };

  function bind(node: HTMLDetailsElement) {
    details = node;
    Object.defineProperty(node, "open", {
      configurable: true,
      get: () => nativeGet.call(node),
      set: (next: boolean) => changeOpen(Boolean(next)),
    });
    onCleanup(() => {
      Reflect.deleteProperty(node, "open");
    });
  }

  return (
    <Popover.Root
      open={open()}
      onOpenChange={changeOpen}
      placement="bottom-end"
      gutter={5}
      overflowPadding={12}
      fitViewport
      preventScroll={false}
    >
      <MenuContext.Provider value={context}>
        <details {...attributes} ref={bind}>
          {local.children}
        </details>
      </MenuContext.Provider>
    </Popover.Root>
  );
}

type MenuTriggerProps = {
  children?: JSX.Element;
  class?: string;
  title?: string;
  "aria-label"?: string;
  "aria-controls"?: string;
};

/** Keep native summary semantics while Kobalte owns popup state. */
export function AppMenuTrigger(props: MenuTriggerProps) {
  return <Popover.Trigger as="summary" {...props} onClick={(event) => event.preventDefault()} />;
}

/** Focus visible actions without interfering with embedded form controls. */
function navigateMenu(event: KeyboardEvent, panel: HTMLElement) {
  if (
    !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) ||
    event.target instanceof HTMLInputElement ||
    event.target instanceof HTMLSelectElement
  )
    return;
  const items = [...panel.querySelectorAll<HTMLElement>("button:not(:disabled), a[href], summary")].filter(
    (node) => node.getClientRects().length && !node.closest("[hidden], [inert]"),
  );
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
  items[next].focus({ preventScroll: true });
}

/** Preserve popup nodes between openings and let Kobalte handle positioning. */
export function AppMenuContent(props: JSX.IntrinsicElements["div"]) {
  const menu = menuContext();
  const panel = document.createElement("div");
  const [local, attributes] = splitProps(props, ["children", "ref"]);
  spread(panel, attributes, false, true);
  insert(panel, () => local.children);
  let host!: HTMLDivElement;
  const registration: MenuPanel = {
    get host() {
      return host;
    },
    panel,
  };
  menu.panels.add(registration);
  onMount(() => {
    if (!menu.open()) host.append(panel);
  });
  onCleanup(() => {
    menu.panels.delete(registration);
  });

  function PanelElement(layer: JSX.IntrinsicElements["div"]) {
    spread(panel, layer, false, true);
    return panel;
  }

  return (
    <div class="menu-panel-host" ref={host}>
      <Show when={menu.open()}>
        <Popover.Content
          as={PanelElement}
          id={props.id}
          class={props.class}
          role={props.role}
          aria-label={props["aria-label"]}
          onKeyDown={(event) => navigateMenu(event, panel)}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            menu.setOpen(false);
            menu.trigger()?.focus({ preventScroll: true });
          }}
        />
      </Show>
    </div>
  );
}
