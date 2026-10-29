import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { sourceFiles } from "./context-layers";
import { parseSource, walk } from "./source-ast";

/**
 * The composition rules of DESIGN.md ("Enforcement"), checked on the JSX of every page and shell part. The UI kit in
 * `src/components/ui` is shadcn's and stays out of these checks. Each allowance names its file and why it is one.
 *
 * - Choices go through the app's `Checkbox` and `RadioGroup`, never a native checkbox or radio.
 * - Information a person needs never sits in a native `title`: it fails on touch and on keyboard focus.
 * - Every timestamp is `Time`, never a raw `time` element.
 * - Lavender (`text-sidebar-count`, `bg-sidebar-primary`) marks only work that waits on a person.
 * - A feature folder never defines a component with a primitive's name (a forked `Field`).
 * - Headings take a heading role (`heading-record`, `heading-section`, `heading-subsection`, `heading-item`), never a size or
 *   a weight picked on the spot.
 * - z-index stays on the scale (10 raised, 20 sticky, 30 bars, 50 overlays): no arbitrary `z-[n]`.
 */

const ROOT = path.resolve(__dirname, "../..");
const UI = "src/components/ui/";

const rel = (file: string) => path.relative(ROOT, file).split(path.sep).join("/");
const line = (sf: ts.SourceFile, node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

/** Files allowed a native checkbox or radio, with the reason. */
const NATIVE_CHOICE: Record<string, string> = {
  "src/components/shell/filter-fields.tsx": "TristateField: sr-only native radios under a drawn segmented control, so a GET form posts them.",
};

/** Files allowed a native `title`, with the reason. */
const NATIVE_TITLE: Record<string, string> = {
  "src/components/shell/time.tsx": "The UTC original of a timestamp: an extra a person rarely needs, and a tab stop on every time would cost more.",
};

/** Files allowed a raw `time` element, with the reason. */
const RAW_TIME: Record<string, string> = {
  "src/components/shell/time.tsx": "Time itself.",
};

/** Files allowed the lavender tokens, with the reason. */
const LAVENDER: Record<string, string> = {
  "src/components/shell/app-sidebar.tsx": "The sidebar counts and the rail dot.",
  "src/components/shell/section.tsx": "Count tone=\"waiting\".",
  "src/app/(app)/settings/settings-nav-list.tsx": "The dot on a Settings area an admin must look at.",
};

/** Names of UI kit components a feature folder must not define again. */
const PRIMITIVE_NAMES = new Set(["Badge", "Button", "Card", "Checkbox", "Dialog", "Field", "FieldLabel", "FieldError", "Input", "Label", "Popover", "RadioGroup", "Select", "Skeleton", "Table", "Textarea", "Tooltip"]);

const HEADING = /^h[1-6]$/;
/** A size or a weight on a heading: the role carries both. Color and layout classes stay free. */
const HAND_TYPED = /(?:^|\s)(?:text-(?:xs|sm|base|lg|xl|[2-9]xl)|font-(?:normal|medium|semibold|bold))(?=\s|$)/;
const LAVENDER_CLASS = /\b(?:text-sidebar-count|bg-sidebar-primary)\b/;
const ARBITRARY_Z = /(?:^|[\s:])-?z-\[/;

interface Hit {
  file: string;
  line: number;
  text: string;
}

function tagName(node: ts.JsxOpeningLikeElement): string {
  return node.tagName.getText();
}

function attribute(node: ts.JsxOpeningLikeElement, name: string): ts.JsxAttribute | undefined {
  return node.attributes.properties.find((p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === name);
}

/** The string literals inside a className value: a plain string, a template, or the arguments of `cn(...)`. */
function classStrings(attr: ts.JsxAttribute | undefined): string[] {
  if (!attr?.initializer) return [];
  const out: string[] = [];
  walk(attr.initializer, (n) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.push(n.text);
    else if (ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) out.push(n.text);
  });
  return out;
}

/** Every string literal in the file that sits in a className, a `cn(...)` call or a constant ending in classes. */
function allClassLiterals(sf: ts.SourceFile): Array<{ text: string; node: ts.Node }> {
  const out: Array<{ text: string; node: ts.Node }> = [];
  walk(sf, (n) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      if (ts.isImportDeclaration(n.parent) || ts.isExportDeclaration(n.parent)) return;
      out.push({ text: n.text, node: n });
    }
  });
  return out;
}

describe("design system composition", () => {
  const files = sourceFiles(path.join(ROOT, "src"))
    .filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"))
    .filter((f) => !rel(f).startsWith(UI) && !/\.test\.tsx?$/.test(f) && !rel(f).startsWith("src/architecture/"));
  const parsed = files.map((f) => ({ file: rel(f), sf: parseSource(f) }));

  function jsxHits(check: (node: ts.JsxOpeningLikeElement, sf: ts.SourceFile) => string | null, allowed: Record<string, string>): Hit[] {
    const hits: Hit[] = [];
    for (const { file, sf } of parsed) {
      if (file in allowed) continue;
      walk(sf, (n) => {
        if (!ts.isJsxOpeningElement(n) && !ts.isJsxSelfClosingElement(n)) return;
        const text = check(n, sf);
        if (text) hits.push({ file, line: line(sf, n), text });
      });
    }
    return hits;
  }

  it("uses the app's Checkbox and RadioGroup, never a native checkbox or radio", () => {
    const hits = jsxHits((n) => {
      if (tagName(n) !== "input") return null;
      const type = attribute(n, "type")?.initializer;
      const value = type && ts.isStringLiteral(type) ? type.text : null;
      return value === "checkbox" || value === "radio" ? `<input type="${value}">` : null;
    }, NATIVE_CHOICE);
    expect(hits).toEqual([]);
  });

  it("puts no information in a native title", () => {
    const hits = jsxHits((n) => {
      const name = tagName(n);
      if (!/^[a-z]/.test(name) || name === "svg" || name === "iframe") return null;
      return attribute(n, "title") ? `<${name} title>` : null;
    }, NATIVE_TITLE);
    expect(hits).toEqual([]);
  });

  it("prints every timestamp through Time", () => {
    const hits = jsxHits((n) => (tagName(n) === "time" ? "<time>" : null), RAW_TIME);
    expect(hits).toEqual([]);
  });

  it("gives every heading a heading role", () => {
    const hits = jsxHits((n) => {
      if (!HEADING.test(tagName(n))) return null;
      const found = classStrings(attribute(n, "className")).find((c) => HAND_TYPED.test(c));
      return found ? `<${tagName(n)} className="${found}">` : null;
    }, {});
    expect(hits).toEqual([]);
  });

  it("keeps lavender for work that waits on a person", () => {
    const hits: Hit[] = [];
    for (const { file, sf } of parsed) {
      if (file in LAVENDER) continue;
      for (const { text, node } of allClassLiterals(sf)) if (LAVENDER_CLASS.test(text)) hits.push({ file, line: line(sf, node), text });
    }
    expect(hits).toEqual([]);
  });

  it("keeps z-index on the scale", () => {
    const hits: Hit[] = [];
    for (const { file, sf } of parsed) {
      for (const { text, node } of allClassLiterals(sf)) if (ARBITRARY_Z.test(text)) hits.push({ file, line: line(sf, node), text });
    }
    expect(hits).toEqual([]);
  });

  it("never forks a UI kit component into a feature folder", () => {
    const hits: Hit[] = [];
    for (const { file, sf } of parsed) {
      walk(sf, (n) => {
        const name = ts.isFunctionDeclaration(n) ? n.name?.text : ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) ? n.name.text : undefined;
        if (name && PRIMITIVE_NAMES.has(name)) hits.push({ file, line: line(sf, n), text: name });
      });
    }
    expect(hits).toEqual([]);
  });
});
