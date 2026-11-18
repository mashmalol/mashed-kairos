import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// The repo root has its own package.json / bun.lock (the Bun bot). This app is
// isolated under ui/. In dev, /events and /history are proxied to the backend
// (VITE_API_URL, default http://localhost:3000) so the SSE connection is
// same-origin — the bot's server does not send CORS headers. In production,
// build the UI and serve it from the bot's origin (or behind the same proxy).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  // PROXY_TARGET (server-only) picks the dev proxy upstream; VITE_API_URL, when set, is
  // compiled into the client and used as an absolute SSE URL for standalone deployments.
  const target = env.PROXY_TARGET || env.VITE_API_URL || "http://localhost:3000";
  return {
    plugins: [react()],
    server: {
      port: 5173,
      strictPort: false,
      proxy: {
        "/events": { target, changeOrigin: true },
        "/history": { target, changeOrigin: true },
      },
    },
  };
});
