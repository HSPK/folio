import { copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { build as buildModule } from "esbuild";

import { buildEditor } from "../editor/build.ts";
import { dependencyNotices } from "../scripts/dependency-licenses.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
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
          context.onResolve({ filter: /^@folio\/model$/ }, () => ({ path: "./model.mjs", external: true }));
        },
      },
    ],
  });
}
const editorOutput = await buildEditor();
for (const name of ["editor.bundle.mjs", "editor.bundle.css", "editor-helpers.mjs", "THIRD-PARTY-LICENSES.txt"]) {
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
await writeFile(path.join(root, "public/THIRD-PARTY-LICENSES.txt"), `${interfaceLicenses}\n${editorLicenses}`);
