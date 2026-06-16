import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    assetsDir: "web-assets"
  },
  server: {
    proxy: {
      "/health": "http://localhost:5174",
      "/.well-known": "http://localhost:5174",
      "/words": "http://localhost:5174",
      "/imports": "http://localhost:5174",
      "/exports": "http://localhost:5174",
      "/reviews": "http://localhost:5174",
      "/stats": "http://localhost:5174",
      "/resource-packs": "http://localhost:5174",
      "/pair": "http://localhost:5174",
      "/sync": "http://localhost:5174",
      "/assets": "http://localhost:5174"
    }
  }
});
