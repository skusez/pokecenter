import { defineConfig, loadEnv, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig(({ mode, command }) => {
  // The browser authenticates with whatever cookie the inbox's auth policy
  // accepts, and that cookie never reaches localhost. So the dev server signs
  // proxied requests with the agent's bearer token instead; the token stays in
  // this process and the browser never sees it. Both come from the env (or a
  // .env file) of the project you run this from.
  const env = loadEnv(mode, process.cwd(), "");
  const target = env.POKECENTER_URL;
  const proxy: ProxyOptions | undefined = target
    ? {
        target,
        changeOrigin: true,
        headers: env.POKECENTER_TOKEN ? { authorization: `Bearer ${env.POKECENTER_TOKEN}` } : undefined,
      }
    : undefined;
  if (command === "serve" && !proxy) {
    console.warn("POKECENTER_URL is not set: /api and /a will not reach a worker.");
  }

  return {
    root,
    plugins: [react(), tailwindcss()],
    build: { outDir: fileURLToPath(new URL("../dist/ui", import.meta.url)), emptyOutDir: true },
    server: { port: 5175, strictPort: true, proxy: proxy ? { "/api": proxy, "/a": proxy } : undefined },
  };
});
