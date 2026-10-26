import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    ".next-*/**",
    // The e2e runner's builds, logs and Playwright output.
    "e2e/.run/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Local agent and design-tool state, ignored by git as well.
    ".claude/**",
    ".impeccable/**",
  ]),
  // The README image script is a plain CommonJS file run by Node.
  {
    files: ["docs/images/*.cjs"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  // A module past 700 lines of code gets split by use case. shadcn primitives and test doubles stay out.
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/components/ui/**", "src/test-support/**", "**/__tests__/**", "**/*.test.{ts,tsx}"],
    rules: { "max-lines": ["error", { max: 700, skipBlankLines: true, skipComments: true }] },
  },
  // DDD dependency direction: domain is pure, application never touches infrastructure.
  {
    files: ["src/contexts/*/domain/**", "src/contexts/*/*/domain/**"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [
          { group: ["**/infrastructure/**", "**/application/**", "next/*", "react", "drizzle-orm*", "postgres", "@/platform/**", "@/composition/**"], message: "domain/ must stay pure." },
        ],
      }],
    },
  },
  {
    files: ["src/contexts/*/application/**", "src/contexts/*/*/application/**"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [
          { group: ["**/infrastructure/**", "next/*", "drizzle-orm*", "postgres", "@/composition/**"], message: "application/ depends on ports, not infrastructure." },
          // Platform types (DbHandle, Job, SlotPort) are ports. Runtime platform code opens the database, except the driver-free error helpers.
          { group: ["@/platform/db/*", "!@/platform/db/errors", "@/platform/jobs/*", "!@/platform/jobs/local-day"], allowTypeImports: true, message: "application/ takes the database and job slots through ports; import platform types only (or @/platform/db/errors)." },
        ],
      }],
    },
  },
]);

export default eslintConfig;
