import { defineConfig } from "vite"
import solid from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"

export default defineConfig({
  plugins: [tailwindcss(), solid()],
  server: {
    host: "0.0.0.0",
    port: 4096,
    allowedHosts: ["ai.kiseding.top", "kiseding.top"],
    proxy: {
      "/api": "http://127.0.0.1:5173",
    },
  },
})
