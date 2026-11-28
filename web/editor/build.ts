import { build } from "esbuild";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dependencyNotices } from "../scripts/dependency-licenses.ts";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.join(packageRoot, "src");
const output = path.join(packageRoot, "dist");
const licenseFallbacks = {
  "overlayscrollbars@2.16.0": path.join(packageRoot, "licenses/overlayscrollbars-2.16.0.txt"),
  "remark-math@6.0.0": path.join(packageRoot, "licenses/remark-math-6.0.0.txt"),
};

/** Build the independent typed editor and its standalone semantic helper module. */
export async function buildEditor() {
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
    loader: { ".woff2": "file" },
    assetNames: "math-fonts/[name]-[hash]",
    plugins: [
      {
        name: "on-demand-formulas",
        setup(context) {
          context.onResolve({ filter: /^\.\/code-syntax\.ts$/ }, (args) =>
            args.kind === "dynamic-import" ? { path: "./code-syntax.mjs", external: true } : undefined,
          );
          context.onResolve({ filter: /^\.\/katex-renderer\.ts$/ }, (args) =>
            args.kind === "dynamic-import" ? { path: "./formula.mjs", external: true } : undefined,
          );
          context.onLoad({ filter: /[/\\]katex\.min\.css$/ }, async ({ path: file }) => ({
            loader: "css",
            resolveDir: path.dirname(file),
            contents: (await readFile(file, "utf8")).replace(/,url\([^)]+\.(?:woff|ttf)\) format\("[^"]+"\)/g, ""),
          }));
        },
      },
    ],
    metafile: true,
  });
  const formula = await build({
    entryPoints: [path.join(sourceRoot, "katex-renderer.ts")],
    outfile: path.join(output, "formula.mjs"),
    bundle: true,
    minify: true,
    format: "esm",
    target: ["es2022"],
    metafile: true,
  });
  const syntax = await build({
    entryPoints: [path.join(sourceRoot, "code-syntax.ts")],
    outfile: path.join(output, "code-syntax.mjs"),
    bundle: true,
    minify: true,
    format: "esm",
    target: ["es2022"],
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
    [...Object.keys(metafile.inputs), ...Object.keys(formula.metafile.inputs), ...Object.keys(syntax.metafile.inputs)],
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
