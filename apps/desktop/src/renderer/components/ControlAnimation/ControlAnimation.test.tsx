import { render } from "@testing-library/react"
import { describe, expect, test } from "vitest"
import {
  CONTROL_ANIMATION_TREATMENTS,
  ControlAnimation,
  type ControlAnimationTreatment,
} from "./ControlAnimation"

function renderTreatment(treatment: ControlAnimationTreatment, active: boolean) {
  const view = render(
    <ControlAnimation active={active} treatment={treatment} testId="treatment">
      <span>icon</span>
    </ControlAnimation>,
  )
  const root = view.container.querySelector<HTMLElement>('[data-testid="treatment"]')
  if (!root) throw new Error("expected the rendered treatment")
  return root
}

describe("ControlAnimation", () => {
  test("defines and renders three structurally distinct shared treatments", () => {
    expect(CONTROL_ANIMATION_TREATMENTS).toEqual(["steam", "halo", "shimmer"])

    const expectedClass = {
      steam: ".control-animation-steam",
      halo: ".control-animation-halo",
      shimmer: ".control-animation-shimmer",
    } as const

    for (const treatment of CONTROL_ANIMATION_TREATMENTS) {
      const root = renderTreatment(treatment, true)
      expect(root.getAttribute("data-treatment")).toBe(treatment)
      expect(root.querySelector(expectedClass[treatment])).not.toBeNull()
    }
  })

  test("exposes the caller-owned activity state without changing its accessible content", () => {
    const root = renderTreatment("steam", false)
    expect(root.getAttribute("data-active")).toBe("false")
    expect(root.getAttribute("aria-hidden")).toBe("true")
    expect(root.textContent).toBe("icon")
  })
})
