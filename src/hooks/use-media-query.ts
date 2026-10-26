import { useSyncExternalStore } from "react"

/** Whether `query` matches the viewport. Server render and first paint read `serverValue`. */
export function useMediaQuery(query: string, serverValue: boolean): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(query)
      mql.addEventListener("change", onChange)
      return () => mql.removeEventListener("change", onChange)
    },
    () => window.matchMedia(query).matches,
    () => serverValue,
  )
}
