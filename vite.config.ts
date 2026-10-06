import { defineConfig } from "vite";
import { curlBridge } from "./scripts/dev-bridge.ts";

export default defineConfig({
  clearScreen: false,
  plugins: [curlBridge()],
  server: { port: 1420, strictPort: true },
  envPrefix: ["VITE_", "TAURI_"],
  build: { target: "es2022", minify: "esbuild", sourcemap: false },
});
