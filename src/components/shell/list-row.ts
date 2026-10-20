/**
 * The frame of one row in a list of conversations or work (Inbox, Actions): a single grid column that may shrink to the
 * screen (an implicit `auto` column is as wide as the longest line), room for a 44px touch on a phone, and the keyboard
 * highlight that `list-keys.tsx` switches on with `data-active`. Put it next to `rowLinkClasses` on the `<li>`.
 */
export const LIST_ROW_FRAME = "grid grid-cols-1 gap-1 px-3 py-3 sm:py-2.5 data-[active=true]:bg-muted data-[active=true]:outline-2 data-[active=true]:-outline-offset-2 data-[active=true]:outline-ring";
