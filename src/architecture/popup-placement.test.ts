import path from "node:path";
import type { ComponentProps } from "react";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import type { ComboboxContent } from "@/components/ui/combobox";
import type { DropdownMenuContent, DropdownMenuSubContent } from "@/components/ui/dropdown-menu";
import type { PopoverContent } from "@/components/ui/popover";
import type { SelectContent } from "@/components/ui/select";
import type { TooltipContent } from "@/components/ui/tooltip";
import { sourceFiles } from "./context-layers";
import { parseSource, walk } from "./source-ast";

/**
 * Every popup opens from `src/components/ui/popup.ts` ("Popups" in DESIGN.md).
 * - Call sites: the props of the popup primitives accept `side` "bottom" or "top" and `align` "start" or "end", and
 *   no offset or padding, so tsc refuses anything else, through a spread or an alias too. The `@ts-expect-error`
 *   lines below fail `pnpm typecheck` once a primitive accepts more.
 * - Primitives: every Base UI positioner in `src/components/ui` takes its placement from one spread of
 *   `popupPositioner(...)` or a named positioner of popup.ts, and sets no placement prop of its own, apart from
 *   the Select's `alignItemWithTrigger={false}`.
 * - Only the UI kit imports Base UI, through an import, an export, `import()` or `require()`.
 */

const ROOT = path.resolve(__dirname, "../..");
const UI = "src/components/ui";
const PLACEMENT_PROPS = new Set(["side", "align", "sideOffset", "alignOffset", "collisionPadding", "collisionAvoidance", "alignItemWithTrigger"]);
const NAMED_POSITIONERS = new Set(["TIP_POSITIONER", "BESIDE_TIP_POSITIONER", "SUBMENU_POSITIONER"]);
/** The function that renders each positioner, so a primitive that stops rendering one fails here. */
const PRIMITIVES = ["ComboboxContent", "DropdownMenuContent", "DropdownMenuSubContent", "PopoverContent", "SelectContent", "TooltipContent"];

const rel = (file: string) => path.relative(ROOT, file).split(path.sep).join("/");
const line = (sf: ts.SourceFile, node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

/** `popupPositioner(...)`, a named positioner, or a conditional between them. */
function fromPopupTs(e: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(e)) return fromPopupTs(e.expression);
  if (ts.isConditionalExpression(e)) return fromPopupTs(e.whenTrue) && fromPopupTs(e.whenFalse);
  if (ts.isCallExpression(e)) return ts.isIdentifier(e.expression) && e.expression.text === "popupPositioner";
  return ts.isIdentifier(e) && NAMED_POSITIONERS.has(e.text);
}

function moduleSpecifier(node: ts.Node): string | null {
  if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
    return node.moduleSpecifier.text;
  }
  if (ts.isCallExpression(node) && node.arguments.length > 0 && ts.isStringLiteralLike(node.arguments[0])) {
    const dynamic = node.expression.kind === ts.SyntaxKind.ImportKeyword;
    const required = ts.isIdentifier(node.expression) && node.expression.text === "require";
    if (dynamic || required) return node.arguments[0].text;
  }
  return null;
}

describe("popup placement", () => {
  const files = sourceFiles(path.join(ROOT, "src"));

  it("the primitives' types accept only the two moves", () => {
    const refused = [
      // @ts-expect-error A popup opens under its trigger or, at the bottom edge, above it.
      { side: "left" } satisfies ComponentProps<typeof SelectContent>,
      // @ts-expect-error A popup lines up with the start or the end of its trigger.
      { align: "center" } satisfies ComponentProps<typeof DropdownMenuContent>,
      // @ts-expect-error The offsets and the edge padding come from popup.ts.
      { sideOffset: 12 } satisfies ComponentProps<typeof PopoverContent>,
      // @ts-expect-error The offsets and the edge padding come from popup.ts.
      { collisionPadding: 0 } satisfies ComponentProps<typeof ComboboxContent>,
      // @ts-expect-error A Select list never lays itself over its trigger.
      { alignItemWithTrigger: true } satisfies ComponentProps<typeof SelectContent>,
      // @ts-expect-error A submenu opens to the right of its item.
      { side: "left" } satisfies ComponentProps<typeof DropdownMenuSubContent>,
      // @ts-expect-error A tooltip opens above its trigger, or beside it in the collapsed sidebar.
      { side: "bottom" } satisfies ComponentProps<typeof TooltipContent>,
    ];
    const accepted = [
      { align: "end" } satisfies ComponentProps<typeof DropdownMenuContent>,
      { side: "top" } satisfies ComponentProps<typeof DropdownMenuContent>,
      { tip: true } satisfies ComponentProps<typeof PopoverContent>,
      { beside: true } satisfies ComponentProps<typeof TooltipContent>,
    ];
    expect(refused.length + accepted.length).toBe(11);
  });

  it("every positioner in the UI kit takes its placement from popup.ts", () => {
    const findings: string[] = [];
    const rendering = new Set<string>();
    for (const file of files.filter((f) => rel(f).startsWith(`${UI}/`))) {
      const sf = parseSource(file);
      walk(sf, (n) => {
        if (!ts.isJsxOpeningElement(n) && !ts.isJsxSelfClosingElement(n)) return;
        if (!n.tagName.getText(sf).endsWith(".Positioner")) return;
        const fn = ts.findAncestor(n, ts.isFunctionDeclaration)?.name?.text ?? "?";
        rendering.add(fn);
        const where = `${rel(file)}:${line(sf, n)} ${fn}`;
        const spreads = n.attributes.properties.filter(ts.isJsxSpreadAttribute);
        if (spreads.length !== 1 || !fromPopupTs(spreads[0].expression)) findings.push(`${where}: needs one spread from popup.ts`);
        for (const attr of n.attributes.properties) {
          if (!ts.isJsxAttribute(attr) || !PLACEMENT_PROPS.has(attr.name.getText(sf))) continue;
          const keepsSelectOffTrigger = fn === "SelectContent" && attr.getText(sf) === "alignItemWithTrigger={false}";
          if (!keepsSelectOffTrigger) findings.push(`${where}: ${attr.getText(sf)}`);
        }
      });
    }
    expect([...rendering].sort()).toEqual(PRIMITIVES);
    expect(findings).toEqual([]);
  });

  it("only the UI kit imports Base UI", () => {
    const findings: string[] = [];
    for (const file of files.filter((f) => !rel(f).startsWith(`${UI}/`))) {
      const sf = parseSource(file);
      walk(sf, (n) => {
        if (moduleSpecifier(n)?.startsWith("@base-ui/")) findings.push(`${rel(file)}:${line(sf, n)}`);
      });
    }
    expect(findings).toEqual([]);
  });
});
