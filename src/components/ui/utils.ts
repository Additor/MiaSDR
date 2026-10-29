import { createCn } from "cn/config"

/**
 * The app's `cn`, taught the spacing scale in globals.css (`gutter`, `section`, `group`, `field`, `inset`), so a class a
 * caller passes replaces the part's own: `cn("gap-group", "gap-field")` keeps `gap-field`. The default from "cn" keeps
 * both, and the stylesheet's order then keeps `gap-group`.
 */
export const cn = createCn({ extend: { theme: { spacing: ["gutter", "section", "group", "field", "inset"] } } })
