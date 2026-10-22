// Build config for the npm entry points: dist/widget.mjs (ES) and
// dist/widget.cjs (CommonJS), plus the bundled dist/widget.d.ts.
//
// livekit-client is EXTERNAL here. It is a regular `dependency`, so
// npm consumers already have it installed, and bundling it into these
// files made every app that also imports livekit-client directly (e.g.
// @livelayer/react) ship and parse two copies of it.
//
// The self-contained script-tag bundle (dist/widget.js, served as
// v1.js) is built separately by vite.umd.config.ts, which still
// bundles livekit-client.
import { defineConfig } from "vite";
import dts from "vite-plugin-dts";

export default defineConfig({
  plugins: [
    dts({ bundleTypes: true }),
  ],
  build: {
    lib: {
      entry: "src/widget.ts",
      name: "LiveLayer",
      formats: ["es", "cjs"],
      fileName: (format) => (format === "es" ? "widget.mjs" : "widget.cjs"),
    },
    rolldownOptions: {
      // @fingerprintjs/fingerprintjs is dynamically imported with a
      // graceful fallback if it is not installed.
      external: [/^livekit-client(\/|$)/, "@fingerprintjs/fingerprintjs"],
      output: {
        // Same shape the CommonJS branch of the UMD bundle had: named
        // exports plus `default`.
        exports: "named",
        // Rollup put "use strict" at the top of every non-ES output by
        // default; Rolldown's default ('auto') only keeps directives
        // that are in the source, and ours has none. Without this,
        // widget.cjs runs in sloppy mode.
        strict: true,
      },
    },
    minify: true,
    sourcemap: false,
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
  },
});
