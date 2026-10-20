import { describe, expect, it } from "vitest";
import { ALWAYS_DOCUMENT_CHARS, ALWAYS_TOTAL_CHARS, KNOWLEDGE_BUDGET_CHARS, MAX_TAGS, MAX_TAG_LENGTH, normalizeTags, parseTags, selectKnowledge, splitTagInput, type KnowledgeCandidate } from "./knowledge";

const doc = (id: string, over: Partial<KnowledgeCandidate> = {}): KnowledgeCandidate => ({
  documentVersionId: id,
  title: id,
  content: `text of ${id}`,
  alwaysInclude: false,
  tags: [],
  ...over,
});

describe("normalizeTags", () => {
  it("lowercases, trims, collapses spaces, drops empties and repeats", () => {
    expect(normalizeTags([" Pricing ", "PRICING", "", "  ", "On  Boarding", "faq"])).toEqual(["pricing", "on boarding", "faq"]);
  });
  it("splits a comma field", () => {
    expect(normalizeTags(splitTagInput("Pricing, onboarding,,FAQ "))).toEqual(["pricing", "onboarding", "faq"]);
  });
});

describe("parseTags", () => {
  it("accepts 50 tags of 80 characters", () => {
    const raw = Array.from({ length: MAX_TAGS }, (_, i) => `${i}`.padEnd(MAX_TAG_LENGTH, "x"));
    expect(parseTags(raw).problem).toBeNull();
  });
  it("refuses a 51st distinct tag but not a repeat of one", () => {
    const raw = Array.from({ length: MAX_TAGS + 1 }, (_, i) => `t${i}`);
    expect(parseTags(raw).problem).toMatch(/at most 50/);
    expect(parseTags([...raw.slice(0, MAX_TAGS), "T0"]).problem).toBeNull();
  });
  it("refuses a tag over 80 characters", () => {
    expect(parseTags(["x".repeat(MAX_TAG_LENGTH + 1)]).problem).toMatch(/80/);
  });
});

describe("selectKnowledge", () => {
  it("ranks by the number of shared step tags, then title", () => {
    const picked = selectKnowledge(
      [
        doc("b-one", { tags: ["pricing"] }),
        doc("a-none", { tags: ["other"] }),
        doc("c-two", { tags: ["pricing", "Onboarding"] }),
        doc("a-one", { tags: ["onboarding"] }),
      ],
      { stepTags: ["Pricing", "onboarding"], includeUnmatched: false },
    );
    expect(picked.map((p) => p.documentVersionId)).toEqual(["c-two", "a-one", "b-one"]);
  });

  it("puts always-included documents first and appends unmatched documents only when asked", () => {
    const docs = [doc("z-always", { alwaysInclude: true }), doc("m-tagged", { tags: ["x"] }), doc("a-plain")];
    expect(selectKnowledge(docs, { stepTags: ["x"], includeUnmatched: false }).map((p) => p.documentVersionId)).toEqual(["z-always", "m-tagged"]);
    expect(selectKnowledge(docs, { stepTags: ["x"], includeUnmatched: true }).map((p) => p.documentVersionId)).toEqual(["z-always", "m-tagged", "a-plain"]);
  });

  it("keeps one oversized always-included document from starving the rest", () => {
    const picked = selectKnowledge(
      [doc("a-huge", { alwaysInclude: true, content: "x".repeat(50_000) }), doc("b-tagged", { tags: ["pricing"], content: "y".repeat(2000) }), doc("c-tagged", { tags: ["pricing"], content: "z".repeat(2000) })],
      { stepTags: ["pricing"], includeUnmatched: false },
    );
    expect(picked.map((p) => p.documentVersionId)).toEqual(["a-huge", "b-tagged", "c-tagged"]);
    expect(picked[0].content.length).toBeLessThanOrEqual(ALWAYS_DOCUMENT_CHARS + "\n[truncated]".length);
    expect(picked[0].content.endsWith("[truncated]")).toBe(true);
    expect(picked[1].content).toHaveLength(2000);
  });

  it("limits all always-included documents together while others compete", () => {
    const always = ["a", "b", "c", "d"].map((id) => doc(id, { alwaysInclude: true, content: "x".repeat(2500) }));
    const picked = selectKnowledge([...always, doc("e-tagged", { tags: ["t"], content: "y".repeat(2000) })], { stepTags: ["t"], includeUnmatched: false });
    const alwaysChars = picked.filter((p) => p.documentVersionId !== "e-tagged").reduce((n, p) => n + p.content.length, 0);
    expect(alwaysChars).toBeLessThanOrEqual(ALWAYS_TOTAL_CHARS + 12);
    expect(picked.at(-1)?.documentVersionId).toBe("e-tagged");
  });

  it("stays inside the budget and drops documents when under 200 characters remain", () => {
    const docs = Array.from({ length: 6 }, (_, i) => doc(`d${i}`, { tags: ["t"], content: "w".repeat(3000) }));
    const picked = selectKnowledge(docs, { stepTags: ["t"], includeUnmatched: false });
    const total = picked.reduce((n, p) => n + p.content.replace("\n[truncated]", "").length, 0);
    expect(total).toBe(KNOWLEDGE_BUDGET_CHARS);
    expect(picked.map((p) => p.documentVersionId)).toEqual(["d0", "d1", "d2"]);
    expect(picked[2].content).toBe(`${"w".repeat(2000)}\n[truncated]`);
  });

  it("classification mode uses only always-included documents and may use the whole budget", () => {
    const picked = selectKnowledge([doc("a", { alwaysInclude: true, content: "x".repeat(2900) }), doc("b", { alwaysInclude: true, content: "x".repeat(2900) }), doc("c", { alwaysInclude: true, content: "x".repeat(2900) }), doc("d")], {
      alwaysOnly: true,
      includeUnmatched: true,
    });
    expect(picked.map((p) => p.documentVersionId)).toEqual(["a", "b", "c"]);
  });

  it("without step tags and with unmatched allowed, keeps the earlier title order", () => {
    expect(selectKnowledge([doc("b"), doc("a"), doc("c", { alwaysInclude: true })], { includeUnmatched: true }).map((p) => p.documentVersionId)).toEqual(["c", "a", "b"]);
  });
});
