import { OverlayScrollbars } from "overlayscrollbars";
import "./scrollbars.css";
import type { DeferredScrollbars, ScrollbarHandle } from "./types/editor.ts";

interface ScrollbarOptions {
  nonce?: string;
  horizontal?: boolean;
}

interface DeferredEntry {
  viewport: HTMLElement;
  instance: ScrollbarHandle | null;
}

export function deferScrollbars(root: HTMLElement, options: ScrollbarOptions = {}): DeferredScrollbars {
  const entries = new Map<HTMLElement, DeferredEntry>();
  const contrast = window.matchMedia("(forced-colors: active)");
  const initialize = (host: HTMLElement, entry: DeferredEntry) => {
    entry.instance ??= attachScrollbars(host, entry.viewport, options);
  };
  const activate = (event: Event) => {
    let node = event.target instanceof Element ? event.target : null;
    while (node) {
      if (node instanceof HTMLElement) {
        const entry = entries.get(node);
        if (entry) initialize(node, entry);
      }
      if (node === root) break;
      node = node.parentElement;
    }
  };
  const updateContrast = () => {
    if (contrast.matches) for (const [host, entry] of entries) initialize(host, entry);
  };
  const events = ["pointerover", "focusin", "scroll"];
  for (const event of events) root.addEventListener(event, activate, event === "scroll");
  contrast.addEventListener("change", updateContrast);
  return {
    attach({ host, viewport }) {
      const entry: DeferredEntry = { viewport, instance: null };
      entries.set(host, entry);
      if (contrast.matches) initialize(host, entry);
      return {
        destroy() {
          if (entries.get(host) !== entry) return;
          entries.delete(host);
          entry.instance?.destroy();
        },
      };
    },
    destroy() {
      for (const event of events) root.removeEventListener(event, activate, event === "scroll");
      contrast.removeEventListener("change", updateContrast);
      for (const entry of entries.values()) entry.instance?.destroy();
      entries.clear();
    },
  };
}

export function attachScrollbars(
  host: HTMLElement,
  viewport: HTMLElement,
  { nonce, horizontal = true }: ScrollbarOptions = {},
): ScrollbarHandle {
  OverlayScrollbars.nonce(nonce ?? document.querySelector<HTMLMetaElement>('meta[name="folio-style-nonce"]')?.content);
  const contrast = window.matchMedia("(forced-colors: active)");
  const instance = OverlayScrollbars(
    {
      target: host,
      elements: { viewport, padding: false, content: false },
    },
    {
      overflow: { x: horizontal ? "scroll" : "hidden", y: "scroll" },
      scrollbars: {
        theme: "os-theme-notes",
        visibility: "auto",
        autoHide: contrast.matches ? "never" : "move",
        autoHideDelay: 750,
        autoHideSuspend: false,
        dragScroll: true,
        clickScroll: "instant",
      },
    },
  );
  let updateTimer: number | undefined;
  const update = () => instance.update();
  const scheduleUpdate = () => {
    window.clearTimeout(updateTimer);
    updateTimer = window.setTimeout(() => {
      updateTimer = undefined;
      instance.update();
    }, 120);
  };
  const updateContrast = () =>
    instance.options({
      scrollbars: { autoHide: contrast.matches ? "never" : "move" },
    });
  viewport.addEventListener("input", scheduleUpdate);
  contrast.addEventListener("change", updateContrast);
  return {
    update,
    destroy() {
      window.clearTimeout(updateTimer);
      viewport.removeEventListener("input", scheduleUpdate);
      contrast.removeEventListener("change", updateContrast);
      instance.destroy();
    },
  };
}
