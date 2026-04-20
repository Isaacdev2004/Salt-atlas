import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],

  server: {
    // Dev-only: forward /api to the Express backend (see backend/server.js).
    proxy: {
      "/api": "http://localhost:5000",
    },
  },

  build: {
    sourcemap: false,
    chunkSizeWarningLimit: 1800,
  },
});
