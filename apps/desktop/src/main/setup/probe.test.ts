import { EventEmitter } from "node:events"
import { describe, expect, test, vi } from "vitest"
import { createSetupProbe } from "./probe"

describe("setup status probe", () => {
  test("executes an exact argv without a shell and returns bounded output", async () => {
    const exec = vi.fn(
      (
        command: string,
        args: string[],
        options: Record<string, unknown>,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        expect(command).toBe("/opt/bin/codex")
        expect(args).toEqual(["login", "status", "$(touch nope)"])
        expect(options).toMatchObject({
          env: { PATH: "/opt/bin" },
          timeout: 123,
          maxBuffer: 32 * 1024,
          windowsHide: true,
        })
        expect(options).not.toHaveProperty("shell")
        callback(null, `x${"y".repeat(40 * 1024)}`, "")
        return new EventEmitter()
      },
    )
    const probe = createSetupProbe(exec as never, 123)

    const result = await probe({
      command: "/opt/bin/codex",
      args: ["login", "status", "$(touch nope)"],
      env: { PATH: "/opt/bin" },
    })

    expect(exec).toHaveBeenCalledTimes(1)
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(32 * 1024)
    expect(result).toMatchObject({ code: 0, stderr: "", timedOut: false })
  })

  test("maps timeout without throwing or returning unbounded stderr", async () => {
    const error = Object.assign(new Error("timed out"), { code: "ETIMEDOUT", killed: true })
    const exec = vi.fn(
      (
        _command: string,
        _args: string[],
        _options: Record<string, unknown>,
        callback: (error: Error, stdout: string, stderr: string) => void,
      ) => {
        callback(error, "", "private detail")
        return new EventEmitter()
      },
    )
    const probe = createSetupProbe(exec as never, 10)

    await expect(probe({ command: "claude", args: ["auth", "status"], env: {} })).resolves.toEqual({
      code: null,
      stdout: "",
      stderr: "private detail",
      timedOut: true,
    })
  })
})
