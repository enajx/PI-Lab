import { useQuery } from "@tanstack/react-query"
import { useTRPC } from "./react"

function trimTrailingSeparators(path: string): string {
  return path.replace(/[\\/]+$/, "")
}

/**
 * Display-only form of an absolute path: `~/…` inside the home folder, `~` for the
 * home folder itself, otherwise the path unchanged. Never use the result for logic.
 */
export function displayPath(path: string, home: string | undefined): string {
  if (!home) return path
  const homeDir = trimTrailingSeparators(home)
  if (homeDir === "") return path
  const target = trimTrailingSeparators(path)
  if (target === homeDir) return "~"
  const next = target.charAt(homeDir.length)
  if (target.startsWith(homeDir) && (next === "/" || next === "\\")) {
    return `~${target.slice(homeDir.length)}`
  }
  return path
}

/** Returns a `(path) => displayPath(path, home)` using the home folder from main. */
export function useDisplayPath(): (path: string) => string {
  const trpc = useTRPC()
  const home = useQuery({ ...trpc.system.homeDir.queryOptions(), staleTime: Infinity }).data
  return (path) => displayPath(path, home)
}
