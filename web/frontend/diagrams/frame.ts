import type { Mermaid } from "mermaid";

declare const mermaid: Mermaid;

mermaid.initialize({ startOnLoad: false });
window.addEventListener(
  "message",
  (event) => {
    const port = event.ports[0];
    if (event.source !== parent || event.origin !== location.origin || !port) return;
    port.onmessage = async ({ data }) => {
      const { source, dark } = data;
      try {
        if (typeof source !== "string" || source.length > 50000) throw new Error();
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: dark ? "dark" : "default",
          suppressErrorRendering: true,
          htmlLabels: false,
          maxTextSize: 50000,
        });
        const { svg } = await mermaid.render("diagram", source);
        // Give the image intrinsic dimensions; SVG width="100%" otherwise defaults to 300px.
        const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
        const root = doc.documentElement;
        if (!(root instanceof SVGSVGElement)) throw new Error();
        const box = root.viewBox.baseVal;
        if (box.width && box.height) {
          root.setAttribute("width", String(Math.ceil(box.width)));
          root.setAttribute("height", String(Math.ceil(box.height)));
          root.style.removeProperty("max-width");
        }
        port.postMessage(new XMLSerializer().serializeToString(root));
      } catch {
        port.postMessage(null);
      } finally {
        document.body.replaceChildren();
      }
    };
  },
  { once: true },
);
