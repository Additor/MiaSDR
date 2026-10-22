import * as React from "react"
import { cn } from "cn"

/**
 * Buttons that act as one control: a main action and the chevron that opens its menu. The inner corners square off
 * and the borders merge, so the pair reads as one button. The button sizes already round their outer corners for it.
 */
function ButtonGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      role="group"
      data-slot="button-group"
      className={cn(
        "flex w-fit items-stretch *:focus-visible:relative *:focus-visible:z-10 [&>*:not(:first-child)]:rounded-l-none [&>*:not(:first-child)]:border-l-0 [&>*:not(:last-child)]:rounded-r-none",
        className
      )}
      {...props}
    />
  )
}

export { ButtonGroup }
