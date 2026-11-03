import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SINGLE_TOKEN, TOKEN, toColumnKey, uniqueColumnKey } from "./keys";
import { render, renderValue, tokensIn } from "../enrichment/domain/enrichment-templates";
import { suggestMapping } from "./import-plan";

interface Golden {
  taken: string[];
  cases: Array<{ label: string; key: string; unique: string }>;
}
const golden = JSON.parse(readFileSync(new URL("./__fixtures__/column-keys.golden.json", import.meta.url), "utf8")) as Golden;

describe("column key golden file", () => {
  it("produces the keys the ASCII-only implementation produced", () => {
    const taken = new Set(golden.taken);
    for (const c of golden.cases) {
      expect({ label: c.label, key: toColumnKey(c.label) }).toEqual({ label: c.label, key: c.key });
      expect({ label: c.label, unique: uniqueColumnKey(c.label, taken) }).toEqual({ label: c.label, unique: c.unique });
    }
  });
});

describe("toColumnKey with other scripts", () => {
  const table: Array<[string, string, string]> = [
    ["Korean", "업종", "업종"],
    ["Korean with space", "회사 이름", "회사이름"],
    ["mixed Korean and English", "Company 회사 Name", "company회사Name"],
    ["Chinese", "公司 名称", "公司名称"],
    ["Arabic", "اسم الشركة", "اسمالشركة"],
    ["Hindi with vowel signs", "कंपनी नाम", "कंपनीनाम"],
    ["accented Latin", "Café Name", "caféName"],
    ["leading digit", "2024 매출", "c2024매출"],
    ["non-ASCII digit first", "٣ أشهر", "c٣أشهر"],
    ["underscore and symbols separate words", "회사_이름 (KR)", "회사이름Kr"],
  ];
  it.each(table)("%s", (_name, label, key) => {
    expect(toColumnKey(label)).toBe(key);
  });

  it("normalizes decomposed Hangul to the composed form", () => {
    const nfd = "업종".normalize("NFD");
    expect(nfd).not.toBe("업종");
    expect(toColumnKey(nfd)).toBe("업종");
    expect(toColumnKey(nfd)).toBe(toColumnKey("업종"));
  });

  it("returns an empty key for emoji-only and symbol-only labels", () => {
    expect(toColumnKey("🔥🔥")).toBe("");
    expect(toColumnKey("$$$ !!!")).toBe("");
    expect(toColumnKey("⃣")).toBe("");
  });
});

describe("uniqueColumnKey with other scripts", () => {
  it("falls back to column when nothing usable remains", () => {
    expect(uniqueColumnKey("🔥", new Set())).toBe("column");
    expect(uniqueColumnKey("$$$", new Set(["column"]))).toBe("column2");
  });

  it("caps a long label at 60 code points without splitting a character", () => {
    const key = uniqueColumnKey("가".repeat(70), new Set());
    expect(Array.from(key)).toHaveLength(60);
    const astral = uniqueColumnKey("𠀀".repeat(70), new Set());
    expect(Array.from(astral)).toHaveLength(60);
    expect(astral).not.toMatch(/[\ud800-\udbff]$/);
    expect(Array.from(uniqueColumnKey("word ".repeat(30), new Set())).length).toBeLessThanOrEqual(60);
  });

  it("adds a numeric suffix on collision, including for NFD input", () => {
    const taken = new Set(["업종"]);
    expect(uniqueColumnKey("업종", taken)).toBe("업종2");
    expect(uniqueColumnKey("업종".normalize("NFD"), taken)).toBe("업종2");
    taken.add("업종2");
    expect(uniqueColumnKey("업 종", taken)).toBe("업종3");
  });
});

describe("one shared key definition", () => {
  it("is used by both template modules", () => {
    // Each consumer must read a Korean token.
    expect([...("{{업종}} {{ b }}").matchAll(TOKEN)].map((m) => m[1])).toEqual(["업종", "b"]);
    expect(SINGLE_TOKEN.exec("{{업종}}")?.[1]).toBe("업종");
    expect(tokensIn("hi {{업종}}")).toEqual(["업종"]);
    expect(render("hi {{업종}}", { 업종: "SaaS" })).toBe("hi SaaS");
    expect(renderValue("{{업종}}", { 업종: 3 })).toBe(3);
  });

  it("matches a Korean header to an existing column by key", () => {
    const m = suggestMapping(["업종"], [], [{ key: "업종", name: "Industry" }, { key: "x", name: "X" }]);
    expect(m[0]).toMatchObject({ action: "map", columnKey: "업종" });
  });
});

describe("NFD tokens resolve NFC column keys", () => {
  const nfc = "업종".normalize("NFC");
  const nfd = "업종".normalize("NFD");
  const row = { [nfc]: "SaaS" };

  it("resolves in an AI prompt template through render, renderValue and tokensIn", () => {
    expect(render(`Industry: {{${nfd}}}`, row)).toBe("Industry: SaaS");
    expect(renderValue(`{{${nfd}}}`, row)).toBe("SaaS");
    expect(tokensIn(`{{${nfd}}} {{${nfc}}}`)).toEqual([nfc]);
  });
});
