import { expect, test, vi } from "vitest"
import { createUserQuitAction } from "./userQuit"

test("each explicit quit offers all choices, background and cancel leave work running", async () => {
  const choose = vi
    .fn()
    .mockResolvedValueOnce("cancel")
    .mockResolvedValueOnce("background")
    .mockResolvedValueOnce("quit")
  const quit = vi.fn()
  const background = vi.fn()
  const request = createUserQuitAction({
    pending: () => false,
    count: async () => 2,
    choose,
    confirmRunning: async () => "quit",
    quit,
    background,
    error: vi.fn(),
  })
  await request()
  expect(quit).not.toHaveBeenCalled()
  await request()
  expect(background).toHaveBeenCalledOnce()
  expect(quit).not.toHaveBeenCalled()
  await request()
  expect(quit).toHaveBeenCalledOnce()
  expect(choose).toHaveBeenCalledTimes(3)
  expect(choose).toHaveBeenCalledWith(2)
})

test("concurrent Cmd+Q does not open duplicate dialogs", async () => {
  let finish!: (value: "cancel") => void
  const choose = vi.fn(
    () =>
      new Promise<"cancel">((resolve) => {
        finish = resolve
      }),
  )
  const request = createUserQuitAction({
    pending: () => false,
    count: async () => 0,
    choose,
    confirmRunning: async () => "quit",
    quit: vi.fn(),
    background: vi.fn(),
    error: vi.fn(),
  })
  const first = request()
  await vi.waitFor(() => expect(choose).toHaveBeenCalledOnce())
  await request()
  expect(choose).toHaveBeenCalledOnce()
  finish("cancel")
  await first
})

test("choosing Quit rechecks running work and offers a separate background or cancel choice", async () => {
  const quit = vi.fn()
  const background = vi.fn()
  const count = vi.fn().mockResolvedValue(2)
  const confirmRunning = vi
    .fn()
    .mockResolvedValueOnce("background")
    .mockResolvedValueOnce("cancel")
    .mockResolvedValueOnce("quit")
  const request = createUserQuitAction({
    pending: () => false,
    count,
    choose: async () => "quit",
    confirmRunning,
    quit,
    background,
    error: vi.fn(),
  })
  await request()
  expect(confirmRunning).toHaveBeenCalledWith(2)
  expect(background).toHaveBeenCalledOnce()
  expect(quit).not.toHaveBeenCalled()
  await request()
  expect(quit).not.toHaveBeenCalled()
  await request()
  expect(quit).toHaveBeenCalledOnce()
})

test("no running work requires only the initial choice", async () => {
  const confirmRunning = vi.fn()
  const quit = vi.fn()
  const request = createUserQuitAction({
    pending: () => false,
    count: async () => 0,
    choose: async () => "quit",
    confirmRunning,
    quit,
    background: vi.fn(),
    error: vi.fn(),
  })
  await request()
  expect(confirmRunning).not.toHaveBeenCalled()
  expect(quit).toHaveBeenCalledOnce()
})

test("Quit label uses the initial count but newly started work still gets its second confirmation", async () => {
  const choose = vi.fn(async () => "quit" as const)
  const confirmRunning = vi.fn(async () => "cancel" as const)
  const quit = vi.fn()
  const request = createUserQuitAction({
    pending: () => false,
    count: vi.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(1),
    choose,
    confirmRunning,
    quit,
    background: vi.fn(),
    error: vi.fn(),
  })
  await request()
  expect(choose).toHaveBeenCalledWith(0)
  expect(confirmRunning).toHaveBeenCalledWith(1)
  expect(quit).not.toHaveBeenCalled()
})
