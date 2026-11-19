import { describe, expect, it } from "vitest"
import { endpointFor, parseConnectLink } from "./address"

describe("server address", () => {
  it("turns an http address into ws and health URLs", () => {
    expect(endpointFor("http://10.0.2.2:4567", "tok/en")).toEqual({
      trpcUrl: "ws://10.0.2.2:4567/trpc?token=tok%2Fen",
      healthUrl: "http://10.0.2.2:4567/health",
      httpUrl: "http://10.0.2.2:4567",
    })
  })

  it("uses wss for https, and https when no scheme is given", () => {
    expect(endpointFor("https://mac.example.ts.net/", "t").trpcUrl).toBe(
      "wss://mac.example.ts.net/trpc?token=t",
    )
    expect(endpointFor("mac.example.ts.net", "t").healthUrl).toBe(
      "https://mac.example.ts.net/health",
    )
  })

  it("refuses an address with a path or another scheme", () => {
    expect(() => endpointFor("ftp://x", "t")).toThrow()
    expect(() => endpointFor("https://x/a", "t")).toThrow()
  })

  it("reads a pasted connect link", () => {
    expect(
      parseConnectLink("  pilab://connect?address=https%3A%2F%2Fmac.example.ts.net&token=abc_-1 "),
    ).toEqual({ address: "https://mac.example.ts.net", token: "abc_-1" })
    expect(parseConnectLink("https://mac.example.ts.net")).toBeNull()
  })

  it("does not throw on a link that is only partly typed", () => {
    expect(parseConnectLink("pilab://connect?address=http%3A%2F%2F10.0.2.2%3")).toBeNull()
  })
})
