import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * The UI bundle.
 *
 * The build lands in `resources/app` rather than `dist`, because that is the
 * directory the Neutralino shell serves as its document root and the directory
 * `neu build` zips into `resources.neu`. A separate `dist` would work in
 * development and be missing from every packaged build, which is the kind of
 * difference that only shows up after an install.
 */
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "resources/app",
    emptyOutDir: true,
  },
  server: {
    host: "127.0.0.1",
    port: 5174,
  },
});