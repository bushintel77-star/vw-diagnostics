import { resolve } from "path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Config for serving the renderer as a plain web app (`npm run dev:web`).
 * Lives next to the renderer root so vite finds it even when invoked
 * without --config; mirrors the aliases from the root vite.config.mjs.
 * (The root vite.config.mjs additionally carries the vitest setup.)
 */
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Same-origin bridge to the live monitor server (scripts/dev-web.mjs),
      // so the browser never makes a cross-origin request to 127.0.0.1.
      "/live": {
        target: "http://127.0.0.1:5175",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/live/, ""),
      },
    },
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
      "@renderer": resolve(__dirname, "src"),
      "@shared": resolve(__dirname, "../shared"),
      "@/components": resolve(__dirname, "src/components"),
      "@/utils": resolve(__dirname, "src/utils"),
      "@/hooks": resolve(__dirname, "src/hooks"),
    },
  },
});
