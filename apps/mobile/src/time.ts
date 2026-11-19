/** "now", "5m", "3h", "2d": how long ago `at` (epoch ms) was. */
export function ago(at: number): string {
  const seconds = Math.max(0, (Date.now() - at) / 1000)
  if (seconds < 60) return "now"
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86_400)}d`
}
