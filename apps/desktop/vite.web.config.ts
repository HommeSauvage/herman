import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  base: "./",
  resolve: {
    tsconfigPaths: true,
  },
  build: {
    outDir: "../web-dist",
    emptyOutDir: true,
  },
  server: {
    port: 3457,
    strictPort: true,
  },
  plugins: [viteReact(), tailwindcss()],
});
