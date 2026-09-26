import { cn } from "@/utils"

/** Static loading placeholder: no motion, so live numbers stay the only
 *  thing moving on screen. */
function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden
      className={cn("rounded-md bg-muted/70", className)}
      {...props}
    />
  )
}

export { Skeleton }
