import { copyFile, cp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { build } from "vite";
import { build as buildModule } from "esbuild";

import { buildEditor } from "../editor/build.ts";
import { versionedAsset } from "../vite.config";
import { dependencyNotices } from "../scripts/dependency-licenses.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
// A single offline page, with permission to execute only these exact bundled bytes.
const frame = await buildModule({
  entryPoints: [path.join(root, "frontend/diagrams/frame.ts")],
  bundle: true,
  write: false,
  minify: true,
  format: "iife",
  target: ["es2022"],
});
const mermaidDir = path.join(root, "node_modules/mermaid");
const diagramScript = (
  (await readFile(path.join(mermaidDir, "dist/mermaid.min.js"), "utf8")) +
  "\n" +
  frame.outputFiles[0].text
).replace(/\r\n?/g, "\n");
if (/<\/script/i.test(diagramScript)) throw new Error("Mermaid bundle cannot be embedded inline.");
await writeFile(
  path.join(root, "public/mermaid-renderer.html"),
  `<!doctype html><html><head><meta charset="utf-8"><title>Diagram renderer</title><script>${diagramScript}</script></head><body></body></html>`,
);
await writeFile(
  path.join(root, "public/mermaid-renderer.csp"),
  `default-src 'none'; script-src 'sha256-${createHash("sha256").update(diagramScript).digest("base64")}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-scripts`,
);
for (const [source, output] of [
  ["index.ts", "model.mjs"],
  ["workspace.ts", "workspace-model.mjs"],
]) {
  await buildModule({
    entryPoints: [path.join(root, "frontend/models", source)],
    outfile: path.join(root, "public", output),
    bundle: true,
    format: "esm",
    target: ["es2022"],
    banner: { js: `// Generated from frontend/models/${source}; do not edit.` },
    plugins: [
      {
        name: "shared-browser-model",
        setup(context) {
          context.onResolve({ filter: /^@folio\/model$/ }, () => ({
            path: `./${versionedAsset("model.mjs")}`,
            external: true,
          }));
        },
      },
    ],
  });
}
const editorOutput = await buildEditor();
await cp(path.join(editorOutput, "math-fonts"), path.join(root, "public/math-fonts"), { recursive: true });
for (const name of [
  "editor.bundle.mjs",
  "editor.bundle.css",
  "formula.mjs",
  "code-syntax.mjs",
  "editor-helpers.mjs",
  "THIRD-PARTY-LICENSES.txt",
]) {
  await copyFile(path.join(editorOutput, name), path.join(root, "public", name));
}
await buildModule({
  entryPoints: [path.join(root, "frontend/diagnostics/input-latency.ts")],
  outfile: path.join(root, "public/input-latency.mjs"),
  bundle: true,
  format: "esm",
  target: ["es2022"],
  banner: { js: "// Generated from frontend/diagnostics/input-latency.ts; do not edit." },
});
await copyFile(path.join(root, "frontend/styles/workspace.css"), path.join(root, "public/workspace.css"));

const modules = new Set<string>();
await build({
  configFile: path.join(root, "vite.config.ts"),
  plugins: [
    {
      name: "folio-bundled-licenses",
      moduleParsed(module) {
        if (module.id.startsWith(path.join(root, "frontend/runtime")) && module.id.endsWith(".mjs")) {
          throw new Error(`Application controllers must be loaded from TypeScript: ${module.id}`);
        }
        modules.add(module.id);
      },
    },
  ],
});
const editorLicenses = await readFile(path.join(editorOutput, "THIRD-PARTY-LICENSES.txt"), "utf8");
const interfaceLicenses = await dependencyNotices(
  modules,
  "Third-party software bundled with Folio's Solid interface\n",
);
const diagramLicense = await readFile(path.join(mermaidDir, "LICENSE"), "utf8");
await writeFile(
  path.join(root, "public/THIRD-PARTY-LICENSES.txt"),
  `${interfaceLicenses}\n${editorLicenses}\nMermaid (including bundled notices in the renderer)\n${diagramLicense}`,
);
