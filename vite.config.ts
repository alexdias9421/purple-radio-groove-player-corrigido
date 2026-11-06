import { defineConfig } from "@lovable.dev/vite-tanstack-config";

export default defineConfig({
  base: "./",
  // Força o modo estático (Client-side apenas)
  tanstackStart: {
    spa: { enabled: true },
  },
});
