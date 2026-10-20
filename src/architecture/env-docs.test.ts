import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ENV_VARIABLES } from "../shared/env";

/** Variables Docker Compose reads and the app does not. They appear in `.env.example` and the configuration doc only. */
const COMPOSE_ONLY = ["POSTGRES_PASSWORD", "PORT", "COMPOSE_FILE"];

const ROOT = process.cwd();
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");

/** `NAME=` at the start of a line, active or commented out. Prose comments never start with NAME=. */
function exampleVariables(): string[] {
  const names = new Set<string>();
  for (const line of read(".env.example").split("\n")) {
    const match = /^#?\s*([A-Z][A-Z0-9_]*)=/.exec(line);
    if (match) names.add(match[1]);
  }
  return [...names];
}

/** The backticked name in the first column of every table row. */
function docVariables(): string[] {
  const names = new Set<string>();
  for (const line of read("docs/configuration.md").split("\n")) {
    const match = /^\|\s*`([A-Z][A-Z0-9_]*)`\s*\|/.exec(line);
    if (match) names.add(match[1]);
  }
  return [...names];
}

const known = [...ENV_VARIABLES, ...COMPOSE_ONLY];
const diff = (a: string[], b: string[]) => a.filter((x) => !b.includes(x)).sort();

describe("env schema, .env.example and docs/configuration.md agree", () => {
  it("lists a non-empty schema", () => {
    expect(ENV_VARIABLES.length).toBeGreaterThan(20);
    expect(ENV_VARIABLES).toContain("PAUSE_OUTBOUND");
  });

  it("documents every schema variable in .env.example", () => {
    expect(diff(ENV_VARIABLES, exampleVariables())).toEqual([]);
  });

  it(".env.example holds no variable the schema does not read", () => {
    expect(diff(exampleVariables(), known)).toEqual([]);
  });

  it("documents every schema variable in docs/configuration.md", () => {
    expect(diff(ENV_VARIABLES, docVariables())).toEqual([]);
  });

  it("docs/configuration.md names no variable the schema does not read", () => {
    expect(diff(docVariables(), known)).toEqual([]);
  });

  it("lists the compose-only variables in both files", () => {
    expect(diff(COMPOSE_ONLY, exampleVariables())).toEqual([]);
    expect(diff(COMPOSE_ONLY, docVariables())).toEqual([]);
  });
});
