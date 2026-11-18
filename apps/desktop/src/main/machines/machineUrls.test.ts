import { expect, test } from "vitest"
import { loopbackPort, machineGrantUrl, splitGrantHost, withPort } from "../../shared/machineUrls"

const token = "0b6f5d0e-3c1a-4e0f-9a51-1d2b3c4d5e6f"
const machineId = "7f1e2d3c-4b5a-4968-8776-655443322110"

test("a remote grant URL names its machine in the host; the token and path come back out", () => {
  const url = machineGrantUrl(`pi-lab-report://${token}/site/index.html?x=1`, machineId)
  expect(url).toBe(`pi-lab-report://${token}.${machineId}/site/index.html?x=1`)
  const parsed = new URL(url)
  expect(splitGrantHost(parsed.host)).toEqual({ token, machineId })
  expect(splitGrantHost(token)).toEqual({ token, machineId: null })
  expect(machineGrantUrl("https://example.com/a", machineId)).toBe("https://example.com/a")
})

test("a loopback page URL moves to the forwarded port", () => {
  const url = "http://127.0.0.1:42700/lab/tree/a.ipynb?token=abc"
  expect(loopbackPort(url)).toBe(42700)
  expect(withPort(url, 50123)).toBe("http://127.0.0.1:50123/lab/tree/a.ipynb?token=abc")
  expect(loopbackPort("pi-lab-report://x/y")).toBeNull()
})
