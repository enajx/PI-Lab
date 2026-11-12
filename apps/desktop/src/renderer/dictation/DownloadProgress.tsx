import "./dictation.css"

/**
 * A thin rounded progress bar in the theme accent color, used for speech model downloads
 * in the pill, in Settings > Dictation and in the setup wizard.
 */
export function DownloadProgress({ label, percent }: { label: string; percent: number }) {
  const value = Math.max(0, Math.min(100, percent))
  return (
    <div
      className="dictation-progress"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value)}
    >
      <div className="dictation-progress-fill" style={{ width: `${value}%` }} />
    </div>
  )
}
