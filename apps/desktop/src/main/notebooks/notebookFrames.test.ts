import { describe, expect, test } from "vitest"
import {
  headersAllowingNotebookFrame,
  notebookRequestAccess,
  type RequestFrame,
} from "./notebookFrames"

const APP: RequestFrame = {
  url: "file:///Applications/PI%20Lab.app/index.html#/science",
  parent: null,
}
const isAppPage = (url: string) => url.startsWith("file:")
const isNotebookPort = (port: number) => port === 42_700 || port === 42_701
const notebookFrame: RequestFrame = { url: "http://127.0.0.1:42700/lab/tree/a.ipynb", parent: APP }
const reportFrame: RequestFrame = { url: "pi-lab-report://report/abc/index.html", parent: APP }

function access(url: string, resourceType: string, frame: RequestFrame | null) {
  return notebookRequestAccess({ url, resourceType }, frame, isNotebookPort, isAppPage)
}

describe("notebookRequestAccess", () => {
  test("the notebook tab's own frame, its first load and its inner frames reach its server", () => {
    expect(access("http://127.0.0.1:42700/api/contents", "xhr", notebookFrame)).toBe("allowed")
    expect(access("ws://127.0.0.1:42700/api/kernels/k/channels", "webSocket", notebookFrame)).toBe(
      "allowed",
    )
    expect(
      access("http://127.0.0.1:42700/lab", "subFrame", { url: "about:blank", parent: APP }),
    ).toBe("allowed")
    expect(access("http://127.0.0.1:42700/lab", "subFrame", { url: "", parent: APP })).toBe(
      "allowed",
    )
    const inner: RequestFrame = { url: "about:srcdoc", parent: notebookFrame }
    expect(access("http://127.0.0.1:42700/files/plot.png", "image", inner)).toBe("allowed")
  })

  test("an HTML report or rendered page in the same window cannot reach a notebook server", () => {
    expect(access("http://127.0.0.1:42700/api/kernels", "xhr", reportFrame)).toBe("blocked")
    expect(access("ws://127.0.0.1:42700/api/kernels/k/channels", "webSocket", reportFrame)).toBe(
      "blocked",
    )
    // The report frame navigating itself, or a frame it made.
    expect(access("http://127.0.0.1:42700/lab", "subFrame", reportFrame)).toBe("blocked")
    const nested: RequestFrame = { url: "about:blank", parent: reportFrame }
    expect(access("http://127.0.0.1:42700/lab", "subFrame", nested)).toBe("blocked")
    // One notebook's page cannot reach another notebook's server.
    expect(access("http://127.0.0.1:42701/api/contents", "xhr", notebookFrame)).toBe("blocked")
    // The app page itself, a request without a frame, a frame outside PI Lab's page.
    expect(access("http://127.0.0.1:42700/api", "xhr", APP)).toBe("blocked")
    expect(access("http://127.0.0.1:42700/api", "xhr", null)).toBe("blocked")
    const foreign: RequestFrame = {
      url: "http://127.0.0.1:42700/lab",
      parent: { url: "https://example.com/", parent: null },
    }
    expect(access("http://127.0.0.1:42700/api", "xhr", foreign)).toBe("blocked")
  })

  test("requests to anything other than a running notebook server are left alone", () => {
    expect(access("http://127.0.0.1:8000/", "xhr", reportFrame)).toBe("not-notebook")
    expect(access("http://localhost:42700/", "xhr", reportFrame)).toBe("not-notebook")
    expect(access("https://example.com/", "xhr", reportFrame)).toBe("not-notebook")
  })
})

describe("headersAllowingNotebookFrame", () => {
  test("drops X-Frame-Options from a running notebook server's responses (marimo sends DENY)", () => {
    expect(
      headersAllowingNotebookFrame(
        "http://127.0.0.1:42700/?access_token=t",
        { "X-Frame-Options": ["DENY"], "Content-Type": ["text/html"] },
        (port) => port === 42_700,
      ),
    ).toEqual({ "Content-Type": ["text/html"] })
  })

  test("lets a notebook server's login cookie work inside the PI Lab frame (marimo's access token)", () => {
    expect(
      headersAllowingNotebookFrame(
        "http://127.0.0.1:42700/auth/login",
        { "set-cookie": ["session=abc; Path=/; HttpOnly; SameSite=Lax", "theme=x"] },
        () => true,
      ),
    ).toEqual({
      "set-cookie": [
        "session=abc; Path=/; HttpOnly; SameSite=None; Secure",
        "theme=x; SameSite=None; Secure",
      ],
    })
  })

  test("leaves other servers' responses unchanged", () => {
    const headers = { "x-frame-options": ["DENY"] }
    expect(
      headersAllowingNotebookFrame("http://127.0.0.1:8000/", headers, (port) => port === 42_700),
    ).toBeNull()
    expect(headersAllowingNotebookFrame("https://example.com/", headers, () => true)).toBeNull()
  })
})
