// Build config for dist/widget.js — the self-contained UMD bundle for
// <script src> usage. The app copies it to v1.js, and unpkg/jsDelivr
// serve it as the package default (package.json "main").
//
// livekit-client is BUNDLED here (zero-config script tag). The npm
// entry points (widget.mjs / widget.cjs) keep it external; see
// vite.config.ts.
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    lib: {
      entry: "src/widget.ts",
      name: "LiveLayer",
      formats: ["umd"],
      fileName: () => "widget.js",
    },
    outDir: "dist",
    emptyOutDir: false, // keep widget.mjs / widget.cjs / widget.d.ts from the npm build
    rolldownOptions: {
      // @fingerprintjs/fingerprintjs is dynamically imported with a
      // graceful fallback if it is not installed.
      external: ["@fingerprintjs/fingerprintjs"],
      output: {
        // Global `LiveLayer` exposes the named exports plus `default`.
        exports: "named",
        // Keep the "use strict" that Rollup emitted by default (see
        // vite.config.ts). v1.js runs as a classic <script> on customer
        // sites, so without it the whole bundle would run in sloppy mode.
        strict: true,
      },
    },
    minify: true,
    sourcemap: false,
  },
});
