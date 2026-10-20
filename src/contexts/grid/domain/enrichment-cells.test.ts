import { describe, expect, it } from "vitest";
import { cascadeTargets, inputsReady, runRoots, type CascadeColumn } from "./enrichment-cascade";
import { boundedAudit, cleanError, redactSecrets } from "./enrichment-redact";
import { assertWithinLimits, clampConcurrency, resolveMaxRows } from "./enrichment-run-limits";
import { normalizeDomain, pluck, render, renderBody, validateInput } from "./enrichment-templates";

const col = (key: string, type: string, config: Record<string, unknown>, dependsOn: string[] = [], autoRun = true): CascadeColumn => ({ key, type, config, dependsOn, autoRun });

describe("redaction", () => {
  it("removes a key wherever it appears, including inside escaped JSON", () => {
    const out = redactSecrets({ url: "https://x.test/?key=sk-live-123456", nested: [{ echo: "token sk-live-123456 used" }] }, ["sk-live-123456"]);
    expect(JSON.stringify(out)).not.toContain("sk-live-123456");
    expect(JSON.stringify(out)).toContain("[redacted]");
    expect(JSON.stringify(redactSecrets({ a: 'pa"ss\\word99' }, ['pa"ss\\word99']))).not.toContain("word99");
    // A key passed as a query parameter shows up URL-encoded.
    const key = "ab+cd/ef=gh 12";
    const encoded = redactSecrets({ url: `https://x.test/?api=${encodeURIComponent(key)}`, form: `api=${new URLSearchParams({ k: key }).toString().slice(2)}` }, [key]);
    expect(encoded).toEqual({ url: "https://x.test/?api=[redacted]", form: "api=[redacted]" });
  });
  it("ignores secrets too short to match safely", () => {
    expect(redactSecrets({ a: "abc" }, ["ab"])).toEqual({ a: "abc" });
  });
  it("cleans error text and bounds audit size", () => {
    expect(cleanError("bad\nkey sk-live-123456\u0000", ["sk-live-123456"])).toBe("bad key [redacted]");
    expect(boundedAudit({ a: "x".repeat(40_000) })).toMatchObject({ truncated: true });
  });
});

describe("run limits", () => {
  it("caps rows and cost", () => {
    expect(resolveMaxRows(undefined)).toBe(1000);
    expect(() => resolveMaxRows(0)).toThrow();
    expect(() => resolveMaxRows(10_001)).toThrow();
    expect(() => assertWithinLimits({ rows: 11, worstCaseCents: 0, maxRows: 10 })).toThrow(/limit of 10/);
    expect(() => assertWithinLimits({ rows: 1, worstCaseCents: 5.5, maxRows: 10, maxCostCents: 5 })).toThrow(/5.50 cents/);
    expect(assertWithinLimits({ rows: 1, worstCaseCents: 5, maxRows: 10, maxCostCents: 5 })).toBe(5);
  });
  it("clamps concurrency to 1..16", () => {
    expect([clampConcurrency(0), clampConcurrency(99), clampConcurrency(undefined), clampConcurrency(3.9)]).toEqual([1, 16, 8, 3]);
  });
});

describe("templates", () => {
  it("encodes tokens for URLs and keeps types in JSON bodies", () => {
    expect(render("/p/{{name}}", { name: "a b/../c" }, encodeURIComponent)).toBe("/p/a%20b%2F..%2Fc");
    expect(renderBody({ n: "{{count}}", s: "hi {{name}}", [`{{k}}`]: 1 }, { count: 3, name: "x" })).toEqual({ n: 3, s: "hi x", "{{k}}": 1 });
  });
  it("reads only own properties", () => {
    expect(render("{{constructor}}", {})).toBe("");
    expect(pluck({ a: [{ b: 1 }] }, "a.0.b")).toBe(1);
    expect(pluck({ a: 1 }, "toString")).toBeNull();
  });
  it("validates inputs before a paid call", () => {
    expect(validateInput("email", "nope")).toMatch(/email/);
    expect(validateInput("email", "a@b.co")).toBeNull();
    expect(validateInput("domain", "https://www.Acme.com/x")).toBeNull();
    expect(validateInput("domain", "")).toMatch(/required/);
    expect(normalizeDomain("https://www.Acme.com/about")).toBe("acme.com");
  });
});

describe("cascade", () => {
  const columns = [
    col("name", "text", {}),
    col("domain", "text", {}),
    col("find", "enrichment", { inputs: { fullName: "name", companyDomain: "domain" }, outputs: { email: "email" } }, ["name", "domain"]),
    col("email", "integration_output", { sourceColumnKey: "find" }, ["find"], false),
    col("verify", "enrichment", { inputs: { email: "email" } }, ["email"]),
    col("opener", "ai", { prompt: "Write about {{name}} at {{domain}}" }, ["name", "domain"]),
    col("manual", "enrichment", { inputs: { fullName: "name" } }, ["name"], false),
  ];

  it("queues auto-run columns whose inputs are ready", () => {
    expect(cascadeTargets(columns, { name: "Ada", domain: "acme.com" }, ["name"]).map((c) => c.key)).toEqual(["find", "opener"]);
  });
  it("waits until every enrichment input has a value, but an AI column needs only one", () => {
    expect(cascadeTargets(columns, { name: "Ada" }, ["name"]).map((c) => c.key)).toEqual(["opener"]);
    expect(inputsReady(columns[2], { name: "Ada", domain: " " })).toBe(false);
  });
  it("finds the roots of the run graph, treating an output column as its source", () => {
    // "verify" reads find's output column, so it follows find. "manual" has auto-run off but is still a root.
    expect(runRoots(columns).map((c) => c.key)).toEqual(["find", "opener", "manual"]);
  });
});
