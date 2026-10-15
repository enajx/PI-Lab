import { afterEach, expect, test, vi } from "vitest"
import { FullBootScheduler } from "./fullBootScheduler"

afterEach(() => vi.useRealTimers())

test("background boot waits for the quick editor, while Open PI Lab starts it immediately once", async () => {
  vi.useFakeTimers()
  const start = vi.fn(async () => undefined)
  const scheduler = new FullBootScheduler(start, 200)

  scheduler.schedule()
  scheduler.schedule()
  await vi.advanceTimersByTimeAsync(199)
  expect(start).not.toHaveBeenCalled()

  await scheduler.startNow()
  await vi.advanceTimersByTimeAsync(500)
  expect(start).toHaveBeenCalledTimes(1)
})

test("canceling quick edit prevents a scheduled background boot", async () => {
  vi.useFakeTimers()
  const start = vi.fn(async () => undefined)
  const scheduler = new FullBootScheduler(start, 200)

  scheduler.schedule()
  scheduler.cancel()
  await vi.advanceTimersByTimeAsync(500)
  expect(start).not.toHaveBeenCalled()
})
