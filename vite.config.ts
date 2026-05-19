import { defineConfig } from "vite";
import dts from "vite-plugin-dts";

export default defineConfig({
  plugins: [
    dts({ rollupTypes: true }),
  ],
  build: {
    lib: {
      entry: "src/widget.ts",
      name: "LiveLayer",
      formats: ["umd", "es"],
      fileName: (format) => format === "es" ? "widget.mjs" : "widget.js",
    },
    // livekit-client is bundled (not external) for zero-config script tag usage.
    // This adds ~150KB gzipped but means users don't need to install it separately.
    // @fingerprintjs/fingerprintjs is external — it's dynamically imported with
    // a graceful fallback if not installed.
    rollupOptions: {
      external: ["@fingerprintjs/fingerprintjs"],
    },
    minify: "esbuild",
    sourcemap: false,
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
  },
});
