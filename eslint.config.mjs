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
    ignores: ["src/components/ui/**", "src/test-support/**", "**/*.test.{ts,tsx}"],
    rules: { "max-lines": ["error", { max: 700, skipBlankLines: true, skipComments: true }] },
  },
  // DDD dependency direction: domain is pure, application never touches infrastructure.
  {
    files: ["src/contexts/*/domain/**", "src/contexts/*/*/domain/**"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [
          { group: ["**/infrastructure/**", "**/application/**", "next/*", "react", "drizzle-orm*", "postgres"], message: "domain/ must stay pure." },
        ],
      }],
    },
  },
  {
    files: ["src/contexts/*/application/**", "src/contexts/*/*/application/**"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [
          { group: ["**/infrastructure/**", "next/*", "drizzle-orm*", "postgres"], message: "application/ depends on ports, not infrastructure." },
        ],
      }],
    },
  },
]);

export default eslintConfig;
