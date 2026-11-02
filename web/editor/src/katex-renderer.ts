import katex, { type KatexOptions } from "katex";

const KATEX_CACHE_LIMIT = 64;

export function createCachedKatexRenderer() {
  let options: KatexOptions | undefined;
  const templates = new Map<string, HTMLElement>();
  const values = new WeakMap<HTMLElement, string>();
  return (value: string, element: HTMLElement, nextOptions?: KatexOptions, cacheable = true) => {
    if (options !== nextOptions) {
      options = nextOptions;
      templates.clear();
    }
    const previous = values.get(element);
    if (previous === value) return;
    if (previous !== undefined && previous !== value && templates.get(previous) === element) {
      templates.delete(previous);
    }
    if (!cacheable) {
      katex.render(value, element, nextOptions);
      values.set(element, value);
      return;
    }
    const template = templates.get(value);
    if (template) {
      if (template !== element) {
        templates.delete(value);
        templates.set(value, template);
        element.replaceChildren(...[...template.childNodes].map((child) => child.cloneNode(true)));
      }
      values.set(element, value);
      return;
    }
    katex.render(value, element, nextOptions);
    values.set(element, value);
    templates.set(value, element);
    if (templates.size > KATEX_CACHE_LIMIT) {
      const oldest = templates.keys().next();
      if (oldest.done) throw new Error("The formula cache lost its oldest entry.");
      templates.delete(oldest.value);
    }
  };
}
