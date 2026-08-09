import { defineConfig } from "vite";

export default defineConfig({
  // GitHub Pages serverar appen under /spanish/
  base: "/spanish/",
  build: { target: "es2020" },
});
