import type { Lifetime } from "../../shared/lifetime.ts";
export function createNodeInspector({
  lifetime,
  root,
  panel,
  onResize_fn,
  onOpen_fn,
  allowSide = true,
}: {
  lifetime: Lifetime;
  root: HTMLElement;
  panel: HTMLElement;
  onResize_fn: () => void;
  onOpen_fn: () => void;
  allowSide?: boolean;
}) {
  let opened = false;
  let frame = 0;
  let signature = "";
  let reveal = false;
  const setRootSize = (name: string, value: string) => {
    if (root.style.getPropertyValue(name) !== value) root.style.setProperty(name, value);
  };
  const notify = () => root.dispatchEvent(new Event("folio-node-panel-layout", { bubbles: true }));
  const update = () => {
    frame = 0;
    if (!opened) return;
    const bounds = root.getBoundingClientRect();
    const viewport = window.visualViewport;
    const visibleLeft = Math.max(bounds.left, viewport?.offsetLeft ?? 0);
    const visibleRight = Math.min(bounds.right, (viewport?.offsetLeft ?? 0) + (viewport?.width ?? innerWidth));
    const visibleTop = Math.max(bounds.top, viewport?.offsetTop ?? 0);
    const visibleBottom = Math.min(bounds.bottom, (viewport?.offsetTop ?? 0) + (viewport?.height ?? innerHeight));
    const visibleWidth = visibleRight - visibleLeft;
    const visibleHeight = visibleBottom - visibleTop;
    const side = allowSide && visibleWidth >= 1000;
    const width = side ? 264 : Math.min(420, visibleWidth - 24);
    panel.style.width = `${width}px`;
    panel.style.maxHeight = `${Math.max(80, side ? visibleHeight - 24 : Math.min(visibleHeight * 0.5, 340))}px`;
    const height = panel.getBoundingClientRect().height;
    const left = side ? visibleRight - width - 12 : visibleLeft + (visibleWidth - width) / 2;
    const top = side ? visibleTop + 12 : visibleBottom - height - 12;
    const next = [side, width, height, left, top, bounds.left, bounds.width, bounds.height, visibleBottom].join(":");
    if (next !== signature) {
      signature = next;
      panel.dataset.dock = side ? "side" : "bottom";
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
      setRootSize("--folio-node-panel-width", side ? `${width + 24}px` : "0px");
      setRootSize("--folio-node-panel-height", side ? "0px" : `${bounds.bottom - visibleBottom + height + 24}px`);
      onResize_fn();
      notify();
    }
    if (reveal) {
      reveal = false;
      onOpen_fn();
    }
  };
  const schedule = () => {
    if (opened && !frame) frame = requestAnimationFrame(update);
  };
  const resize = new ResizeObserver(schedule);
  lifetime.defer(() => {
    resize.disconnect();
    cancelAnimationFrame(frame);
    opened = false;
    setRootSize("--folio-node-panel-width", "0px");
    setRootSize("--folio-node-panel-height", "0px");
  });
  resize.observe(root);
  resize.observe(panel);
  lifetime.listen(window, "resize", schedule);
  if (window.visualViewport) {
    lifetime.listen(window.visualViewport, "resize", schedule);
    lifetime.listen(window.visualViewport, "scroll", schedule);
  }
  return {
    refresh: schedule,
    setOpen(value: boolean) {
      const next = Boolean(value);
      if (opened === next) {
        schedule();
        return;
      }
      opened = next;
      panel.hidden = !opened;
      if (opened) {
        reveal = true;
        schedule();
      } else {
        cancelAnimationFrame(frame);
        frame = 0;
        signature = "";
        reveal = false;
        setRootSize("--folio-node-panel-width", "0px");
        setRootSize("--folio-node-panel-height", "0px");
        onResize_fn();
        notify();
      }
    },
  };
}
