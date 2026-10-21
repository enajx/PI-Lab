import { act, renderHook } from "@testing-library/react"
import { expect, test } from "vitest"
import { useDefaultAgentId } from "./preferences"

test("a default-agent change reaches other mounted consumers", () => {
  window.localStorage.removeItem("pi-lab.defaultAgentId")
  const first = renderHook(() => useDefaultAgentId())
  const second = renderHook(() => useDefaultAgentId())
  act(() => first.result.current[1]("codex"))
  expect(second.result.current[0]).toBe("codex")
  expect(window.localStorage.getItem("pi-lab.defaultAgentId")).toBe("codex")
  act(() => first.result.current[1](" "))
  expect(second.result.current[0]).toBe(first.result.current[0])
  expect(second.result.current[0]).not.toBe(" ")
  window.localStorage.removeItem("pi-lab.defaultAgentId")
})
