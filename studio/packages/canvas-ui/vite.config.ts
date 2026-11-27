import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type ProxyOptions } from "vite";

const backendProxy: ProxyOptions = {
  target: "http://127.0.0.1:4317",
  changeOrigin: true,
  configure(proxy) {
    proxy.on("proxyReq", (request) => {
      request.setHeader("Host", "127.0.0.1:4317");
      request.setHeader("Origin", "http://127.0.0.1:4317");
    });
  },
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": backendProxy,
      "/health": backendProxy,
      "/render": backendProxy,
      "/inspect": backendProxy,
    },
  },
});
