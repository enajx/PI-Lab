import { X } from "lucide-react"
import { useEffect, useState } from "react"

/** A small, dismissible update notice that disappears after three seconds. */
export function UpdateNotice({ message }: { message: string }) {
  const [visible, setVisible] = useState(true)
  useEffect(() => {
    setVisible(message.length > 0)
    const timer = setTimeout(() => setVisible(false), 3000)
    return () => clearTimeout(timer)
  }, [message])
  if (!visible) return null
  return (
    <div
      role="status"
      data-testid="update-notice"
      className="fixed right-6 bottom-6 z-[100] flex max-w-md items-start gap-5 rounded-2xl border border-border bg-muted px-6 py-5 text-foreground shadow-lg"
    >
      <p className="text-sm">{message}</p>
      <button
        type="button"
        aria-label="Dismiss update notification"
        className="shrink-0 text-muted-foreground hover:text-foreground"
        onClick={() => setVisible(false)}
      >
        <X className="size-4" />
      </button>
    </div>
  )
}
