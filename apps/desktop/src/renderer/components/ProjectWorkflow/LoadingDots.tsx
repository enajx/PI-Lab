/**
 * A small animated ellipsis for inline pending labels (e.g. "Working…"). Three
 * dots fade in sequence via the `.pi-lab-loading-dots` keyframes in globals.css;
 * the animation is decorative, so the group is `aria-hidden` and a caller's
 * surrounding text carries the accessible meaning. Under reduced motion the dots
 * simply hold visible.
 */
export function LoadingDots() {
  return (
    <span className="pi-lab-loading-dots" data-testid="loading-dots" aria-hidden>
      <span>.</span>
      <span>.</span>
      <span>.</span>
    </span>
  )
}
