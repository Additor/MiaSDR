"use client"

import * as React from "react"
import { Popover as PopoverPrimitive } from "@base-ui/react/popover"
import { cn } from "cn"
import { popupPositioner, POPUP_SURFACE, TIP_POSITIONER, type PopupPlacement } from "./popup"

function Popover({ ...props }: PopoverPrimitive.Root.Props) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

function PopoverTrigger({ ...props }: PopoverPrimitive.Trigger.Props) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

/**
 * The popup on the menu surface. `container` and `keepMounted` keep the popup inside a given node while it is closed,
 * so a form around that node still submits its fields. `anchor` places it against an element other than the trigger,
 * for a popover without one (the calendar under a grid cell's date editor). `tip` places it where a tooltip opens, for
 * `TouchTip`'s popover on a tap.
 */
function PopoverContent({
  side,
  align,
  tip = false,
  positionMethod,
  anchor,
  positionerClassName,
  container,
  keepMounted,
  className,
  ...props
}: PopoverPrimitive.Popup.Props &
  PopupPlacement &
  Pick<PopoverPrimitive.Positioner.Props, "positionMethod" | "anchor"> &
  Pick<PopoverPrimitive.Portal.Props, "container" | "keepMounted"> & {
    positionerClassName?: string
    tip?: boolean
  }) {
  return (
    <PopoverPrimitive.Portal container={container} keepMounted={keepMounted}>
      <PopoverPrimitive.Positioner
        className={cn("isolate z-50 outline-none", positionerClassName)}
        {...(tip ? TIP_POSITIONER : popupPositioner({ side, align }))}
        positionMethod={positionMethod}
        anchor={anchor}
      >
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          className={cn("z-50 overflow-hidden text-sm", POPUP_SURFACE, className)}
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  )
}

export { Popover, PopoverTrigger, PopoverContent }
