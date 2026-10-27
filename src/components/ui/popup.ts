/**
 * Every popup on the menu surface (Select, DropdownMenu, Popover, Combobox) opens under its trigger with the left edges
 * lined up, 4px below it, and keeps 8px from the viewport edge, the inset of the sidebar's own triggers. Each primitive
 * spreads `popupPositioner(...)` onto its Base UI positioner and takes nothing else.
 *
 * A call site moves a popup in two ways only, and the types refuse anything else: `align="end"` for a trigger at the
 * right edge, so the popup grows to the left, and `side="top"` for a trigger at the bottom edge (a selection bar, the
 * sidebar footer). `src/architecture/popup-placement.test.ts` checks the primitives.
 */
export interface PopupPlacement {
  side?: "bottom" | "top"
  align?: "start" | "end"
}

const OFFSETS = { sideOffset: 4, alignOffset: 0, collisionPadding: 8 } as const

export function popupPositioner({ side = "bottom", align = "start" }: PopupPlacement = {}) {
  return { side, align, ...OFFSETS }
}

/** A tooltip, and `TouchTip`'s popover on a tap, open above the trigger and centered. */
export const TIP_POSITIONER = { side: "top", align: "center", ...OFFSETS } as const

/** The tooltip of an icon in the collapsed sidebar opens beside it, toward the page. */
export const BESIDE_TIP_POSITIONER = { side: "right", align: "center", ...OFFSETS } as const

/** A submenu opens to the right of its item; the -3 lines its first item up with that item. */
export const SUBMENU_POSITIONER = { side: "right", align: "start", sideOffset: 0, alignOffset: -3, collisionPadding: 8 } as const

/** The menu surface and its motion: a 95% scale and a fade from the trigger's side, over `--duration-menu`. */
export const POPUP_SURFACE =
  "max-h-(--available-height) origin-(--transform-origin) rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none transition-[opacity,scale] duration-(--duration-menu) ease-out data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0"
