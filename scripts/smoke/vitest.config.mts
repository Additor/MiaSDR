import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/** Live vendor calls stay out of the default run: `SMOKE_HUNTER_KEY=... pnpm vitest run -c scripts/smoke/vitest.config.mts`. */
export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("../../src", import.meta.url)) } },
  test: { include: ["scripts/smoke/*.smoke.ts"], fileParallelism: false, testTimeout: 60_000 },
});
