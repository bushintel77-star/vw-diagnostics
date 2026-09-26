import { cn } from "@/utils"

/** Loading placeholder with a travelling shimmer (static under reduced motion). */
function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden
      className={cn(
        "relative overflow-hidden rounded-md bg-muted before:absolute before:inset-0 before:-translate-x-full before:animate-shimmer before:bg-gradient-to-r before:from-transparent before:via-chart-1/[0.14] before:to-transparent motion-reduce:before:hidden",
        className
      )}
      {...props}
    />
  )
}

export { Skeleton }
