import { build } from "esbuild";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dependencyNotices } from "../scripts/dependency-licenses.ts";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.join(packageRoot, "src");
const defaultOutput = path.join(packageRoot, "dist");
const licenseFallbacks = {
  "overlayscrollbars@2.16.0": path.join(packageRoot, "licenses/overlayscrollbars-2.16.0.txt"),
  "remark-math@6.0.0": path.join(packageRoot, "licenses/remark-math-6.0.0.txt"),
};

/** Build the independent typed editor and its standalone semantic helper module. */
export async function buildEditor(output = defaultOutput) {
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const { metafile } = await build({
    entryPoints: [path.join(sourceRoot, "index.ts")],
    outfile: path.join(output, "editor.bundle.mjs"),
    bundle: true,
    minify: true,
    format: "esm",
    target: ["es2022"],
    legalComments: "eof",
    loader: { ".woff": "dataurl", ".woff2": "dataurl", ".ttf": "dataurl" },
    metafile: true,
  });
  await build({
    entryPoints: [path.join(sourceRoot, "editor-helpers.ts")],
    outfile: path.join(output, "editor-helpers.mjs"),
    bundle: true,
    format: "esm",
    target: ["es2022"],
  });
  const notices = await dependencyNotices(
    Object.keys(metafile.inputs),
    "Third-party software bundled with @folio/editor\nRebuild: npm install && npm run build\n",
    licenseFallbacks,
  );
  await writeFile(path.join(output, "THIRD-PARTY-LICENSES.txt"), notices);
  const cssPath = path.join(output, "editor.bundle.css");
  const css = await readFile(cssPath, "utf8");
  await writeFile(cssPath, css.replace(/[ \t]+$/gm, ""));
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildEditor();
