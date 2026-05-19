// Build config for bridge.js — the iframe→host postMessage relay.
// Built as an IIFE so consumers can drop it in via plain
// <script src="https://livelayer.studio/bridge.js"> without `type="module"`.
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    lib: {
      entry: "src/bridge.ts",
      name: "LiveLayerBridge",
      formats: ["iife"],
      fileName: () => "bridge.js",
    },
    outDir: "dist",
    emptyOutDir: false, // preserve widget.js + widget.mjs from the main build
    minify: "esbuild",
    sourcemap: false,
    // Bridge is self-contained; no externals.
  },
});
