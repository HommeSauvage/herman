import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "src/views/main",
  base: "./",
  resolve: {
    tsconfigPaths: true,
  },
  build: {
    outDir: "../../../dist/renderer",
    emptyOutDir: true,
  },
  server: {
    port: 3456,
    strictPort: true,
  },
  plugins: [viteReact(), tailwindcss()],
});
