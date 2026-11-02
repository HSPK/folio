import { validateAppearance, quoteFontFamily, cssFontFamily, isGenericFontFamily } from "./editor-helpers.ts";
import type { Appearance } from "./types/editor.ts";

interface AppearanceState {
  settings: Appearance;
  signature: string;
  face: FontFace | null;
  alias: string;
  fontResult: Promise<string>;
}

const appearanceRoots = new WeakMap<HTMLElement, AppearanceState>();
let fontGeneration = 0;
const cjkGlyphs =
  "U+2E80-2FFF,U+3000-303F,U+3040-30FF,U+3100-312F,U+31A0-31FF,U+31C0-31EF,U+3400-4DBF,U+4E00-9FFF,U+AC00-D7AF,U+F900-FAFF,U+FE30-FE4F,U+FF00-FFEF,U+20000-323AF";

export function applyAppearance(value: unknown, root = document.documentElement) {
  const settings = validateAppearance(value);
  const signature = JSON.stringify(settings);
  const previous = appearanceRoots.get(root);
  if (previous?.signature === signature) {
    return previous.fontResult.then((warning) => ({
      changed: false,
      warning: previous.face?.status === "loaded" ? "" : warning,
    }));
  }
  const state: AppearanceState = {
    face: null,
    alias: "",
    fontResult: Promise.resolve(""),
    ...previous,
    settings,
    signature,
  };
  appearanceRoots.set(root, state);
  if (root.dataset.theme !== settings.theme) root.dataset.theme = settings.theme;
  if (
    !previous ||
    previous.settings.latinFont !== settings.latinFont ||
    previous.settings.cjkFont !== settings.cjkFont
  ) {
    const owner = root.ownerDocument;
    const latin = cssFontFamily(settings.latinFont);
    const cjk = cssFontFamily(settings.cjkFont);
    if (!previous || previous.settings.cjkFont !== settings.cjkFont) {
      state.face = null;
      state.alias = "";
      const genericCjk = isGenericFontFamily(settings.cjkFont);
      state.fontResult = Promise.resolve(genericCjk ? "" : "This browser uses a font-stack fallback for Chinese text.");
      if (!genericCjk && typeof FontFace !== "undefined" && owner.fonts) {
        try {
          // A local, CJK-only face precedes the English family without downloading fonts.
          const alias = `Folio Local CJK ${++fontGeneration}`;
          const face = new FontFace(alias, `local(${cjk})`, { unicodeRange: cjkGlyphs });
          owner.fonts.add(face);
          state.face = face;
          state.alias = alias;
          let timeout: number | undefined;
          state.fontResult = Promise.race([
            face.load().then(
              () => "",
              () => `The Chinese font “${settings.cjkFont}” is unavailable. Using a local fallback.`,
            ),
            new Promise<string>((resolve) => {
              timeout = window.setTimeout(
                () => resolve("The selected Chinese font is taking too long to load. Using a local fallback."),
                4000,
              );
            }),
          ]).finally(() => window.clearTimeout(timeout));
        } catch {
          state.fontResult = Promise.resolve(
            "The selected Chinese font could not be configured. Using a local fallback.",
          );
        }
      }
    }
    const family = state.alias ? `${quoteFontFamily(state.alias)}, ` : "";
    const set = (name: string, text: string) => {
      if (root.style.getPropertyValue(name) !== text) root.style.setProperty(name, text);
    };
    set("--font-latin", latin);
    set("--font-cjk", cjk);
    set("--document-font", `${family}${latin}, ${cjk}, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif`);
    set("--code-font", `"Cascadia Code", Consolas, ${family}monospace`);
    if (previous?.face && previous.face !== state.face) owner.fonts.delete(previous.face);
  }
  return state.fontResult.then((warning) => ({
    changed: true,
    warning: state.face?.status === "loaded" ? "" : warning,
  }));
}
