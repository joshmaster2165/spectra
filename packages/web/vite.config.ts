import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const HUB = "http://127.0.0.1:4317";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/ws": { target: HUB.replace("http", "ws"), ws: true },
      "/state": HUB,
      "/sessions": HUB,
      "/history": HUB,
      "/files": HUB,
      "/review": HUB,
      "/verify": HUB,
    },
  },
});
