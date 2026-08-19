import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Absolute asset URLs: the gateway always mounts the SPA at /, and nested
  // client routes (/tasks/:id) must resolve assets from the root.
  base: "/",
  server: {
    proxy: { "/api": "http://127.0.0.1:4173" },
  },
});
