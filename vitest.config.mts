import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    include: ["src/**/*.test.ts"],
    // Integration tests share one database; run files one at a time.
    fileParallelism: false,
    exclude: ["node_modules", "reference", ".next"],
  },
});
