/** Hash history may append the page's outer query to the last hash query value. */
export function stripOuterQuery(value: string): string {
  if (typeof window === "undefined") return value
  const outer = window.location.search
  return outer && value.endsWith(outer) ? value.slice(0, -outer.length) : value
}
