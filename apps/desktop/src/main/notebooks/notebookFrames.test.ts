import { describe, expect, test } from "vitest"
import { headersAllowingNotebookFrame } from "./notebookFrames"

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
