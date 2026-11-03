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
 * Every popup opens from `src/components/ui/popup.ts` ("Popups" in DESIGN.md). Call sites are where placement drifts, so
 * the props accept `side` "bottom" or "top" and `align` "start" or "end", and no offset or padding. `pnpm typecheck`
 * fails on the `@ts-expect-error` lines below once a primitive accepts more. Inside the UI kit, each Base UI positioner
 * spreads its placement from popup.ts and sets none of its own. ESLint keeps Base UI imports inside the UI kit.
 */

const ROOT = path.resolve(__dirname, "../..");
const UI = path.join(ROOT, "src/components/ui");
const PLACEMENT_PROPS = new Set(["side", "align", "sideOffset", "alignOffset", "collisionPadding", "collisionAvoidance", "alignItemWithTrigger"]);
const FROM_POPUP_TS = /popupPositioner\(|\b[A-Z_]+_POSITIONER\b/;

describe("popup placement", () => {
  it("the primitives' types accept only the two moves", () => {
    // tsc does the checking: the lines exist for `satisfies`, and nothing runs.
    void [
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
      { align: "end" } satisfies ComponentProps<typeof DropdownMenuContent>,
      { side: "top" } satisfies ComponentProps<typeof DropdownMenuContent>,
      { tip: true } satisfies ComponentProps<typeof PopoverContent>,
      { beside: true } satisfies ComponentProps<typeof TooltipContent>,
    ];
  });

  it("every positioner in the UI kit takes its placement from popup.ts", () => {
    const findings: string[] = [];
    let positioners = 0;
    for (const file of sourceFiles(UI)) {
      const sf = parseSource(file);
      walk(sf, (n) => {
        if (!ts.isJsxOpeningElement(n) && !ts.isJsxSelfClosingElement(n)) return;
        if (!n.tagName.getText(sf).endsWith(".Positioner")) return;
        positioners += 1;
        const where = path.relative(ROOT, file);
        const spreads = n.attributes.properties.filter(ts.isJsxSpreadAttribute);
        if (spreads.length !== 1 || !FROM_POPUP_TS.test(spreads[0].expression.getText(sf))) findings.push(`${where}: needs one spread from popup.ts`);
        for (const attr of n.attributes.properties) {
          if (!ts.isJsxAttribute(attr) || !PLACEMENT_PROPS.has(attr.name.getText(sf))) continue;
          // Only the Select sets this, to keep its list off the trigger.
          if (attr.getText(sf) !== "alignItemWithTrigger={false}") findings.push(`${where}: ${attr.getText(sf)}`);
        }
      });
    }
    expect(positioners).toBeGreaterThan(0);
    expect(findings).toEqual([]);
  });
});
