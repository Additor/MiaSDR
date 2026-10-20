import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/** Benchmarks stay out of the default run: `TEST_DATABASE_URL=... pnpm vitest run -c scripts/bench/vitest.config.mts`. */
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("../../src", import.meta.url)) } },
  test: { include: ["scripts/bench/*.bench.ts"], fileParallelism: false, testTimeout: 600_000, hookTimeout: 600_000 },
});
