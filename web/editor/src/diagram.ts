// The note never shares a DOM with Mermaid. Only a static SVG image leaves the sandbox.
let renderer: HTMLIFrameElement | undefined;
let channel: Promise<MessagePort> | undefined;
let tail: Promise<unknown> = Promise.resolve();
const cache = new Map<string, string>();
let cachedSize = 0;

function openRenderer() {
  return (channel ??= new Promise<MessagePort>((resolve, reject) => {
    const frame = document.createElement("iframe");
    renderer = frame;
    frame.className = "folio-diagram-renderer";
    frame.tabIndex = -1;
    frame.setAttribute("aria-hidden", "true");
    frame.sandbox.add("allow-scripts");
    frame.src = "/mermaid-renderer.html";
    frame.onload = () => {
      const { port1, port2 } = new MessageChannel();
      frame.contentWindow!.postMessage(null, "*", [port2]);
      resolve(port1);
    };
    frame.onerror = reject;
    document.body.append(frame);
  }));
}

function diagram(source: string, dark: boolean, current: () => boolean) {
  const key = `${dark}\n${source}`;
  const task = tail.then(async () => {
    if (!current()) return null;
    const cached = cache.get(key);
    if (cached) return cached;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const svg = await Promise.race([
        openRenderer().then(
          (port) =>
            new Promise<string | null>((resolve) => {
              port.onmessage = ({ data }) => resolve(typeof data === "string" ? data : null);
              port.postMessage({ source, dark });
            }),
        ),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(reject, 12000);
        }),
      ]);
      if (svg && svg.length < 2_000_000) {
        cache.set(key, svg);
        cachedSize += svg.length;
        while (cache.size > 24 || cachedSize > 2_000_000) {
          const [first, value] = cache.entries().next().value!;
          cachedSize -= value.length;
          cache.delete(first);
        }
      }
      return svg;
    } catch {
      renderer?.remove();
      channel = undefined;
      return null;
    } finally {
      clearTimeout(timeout);
    }
  });
  tail = task.catch(() => null);
  return task;
}

function diagramClass() {
  return class Diagram extends HTMLElement {
    private source = "";
    private revision = 0;
    private timer?: ReturnType<typeof setTimeout>;
    private visible = false;
    private painted?: { source: string; dark: boolean };
    private media = matchMedia("(prefers-color-scheme: dark)");
    private theme = new MutationObserver(() => this.schedule());
    private intersection = new IntersectionObserver(
      ([entry]) => {
        this.visible = entry.isIntersecting;
        this.schedule();
      },
      { rootMargin: "250px" },
    );

    setSource(text: string) {
      if (text === this.source) return;
      this.source = text;
      this.schedule();
    }
    connectedCallback() {
      this.contentEditable = "false";
      this.intersection.observe(this);
      this.theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
      this.media.addEventListener("change", this.schedule);
    }
    disconnectedCallback() {
      this.visible = false;
      this.revision++;
      clearTimeout(this.timer);
      this.intersection.disconnect();
      this.theme.disconnect();
      this.media.removeEventListener("change", this.schedule);
    }
    private schedule = () => {
      const id = ++this.revision;
      clearTimeout(this.timer);
      if (!this.isConnected || !this.visible) return;
      const theme = document.documentElement.dataset.theme;
      const dark = theme === "dark" || (theme !== "light" && this.media.matches);
      if (this.painted?.source === this.source && this.painted.dark === dark) return;
      this.timer = setTimeout(async () => {
        const current = () => this.isConnected && this.revision === id;
        const svg = this.source.length <= 50000 && (await diagram(this.source, dark, current));
        if (!current()) return;
        if (svg) {
          const img = new Image();
          img.alt = "Mermaid diagram";
          img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
          this.replaceChildren(img);
          this.painted = { source: this.source, dark };
        } else {
          this.painted = undefined;
          this.textContent = "Diagram unavailable. Check the source.";
        }
        this.dataset.state = svg ? "ready" : "error";
      }, 180);
    };
  };
}

export function createDiagram(text: string) {
  if (!customElements.get("folio-diagram")) customElements.define("folio-diagram", diagramClass());
  const element = document.createElement("folio-diagram") as InstanceType<ReturnType<typeof diagramClass>>;
  element.setSource(text);
  return element;
}
