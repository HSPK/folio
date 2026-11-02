import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const runtimeAssets: Record<string, string> = {
  "@folio/model": "/model.mjs",
  "@folio/workspace-model": "/workspace-model.mjs",
  "@folio/editor-runtime": "/editor.bundle.mjs",
  "@folio/input-latency": "/input-latency.mjs",
};

export default defineConfig({
  root,
  publicDir: false,
  plugins: [
    solid(),
    {
      name: "folio-runtime-assets",
      resolveId(source) {
        const asset = runtimeAssets[source];
        return asset ? { id: asset, external: true } : null;
      },
    },
  ],
  build: {
    target: "es2022",
    outDir: "public",
    emptyOutDir: false,
    cssCodeSplit: false,
    modulePreload: false,
    rolldownOptions: {
      input: fileURLToPath(new URL("./frontend/main.tsx", import.meta.url)),
      output: {
        entryFileNames: "app.mjs",
        codeSplitting: false,
        assetFileNames(asset) {
          if (asset.names.every((name) => name.endsWith(".css"))) return "styles.css";
          throw new Error(`Unexpected UI asset: ${asset.names.join(", ")}`);
        },
      },
    },
  },
});
