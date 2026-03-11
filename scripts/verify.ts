#!/usr/bin/env bun
/**
 * Skipper smoke harness — the autonomous build → launch → assert gate (AGENTS.md §14).
 *
 * It grows phase by phase. At P0 it only proves the toolchain is wired and exits 0.
 * From P3 it will: build the app, launch it headless via Playwright `_electron`, then
 * assert the golden path — boot (`app-ready`) → DB migrated → open a temp git project →
 * spawn a terminal running the fake-agent stub → assert its output → reload the app →
 * assert the session reattached (pty-daemon survival contract) → exit nonzero on failure.
 */

type Step = { name: string; run: () => Promise<void> | void }

const steps: Step[] = [
  { name: "toolchain wired", run: () => {} },
  // P3+: { name: "app boots headless", run: launchAndAssertReady },
  // P3+: { name: "db migrated", run: assertDbAtLatest },
  // P5+: { name: "fake agent runs in terminal", run: assertAgentOutput },
  // P5+: { name: "session reattaches after reload", run: assertReattach },
]

async function main() {
  for (const step of steps) {
    process.stdout.write(`• ${step.name} ... `)
    await step.run()
    process.stdout.write("ok\n")
  }
  console.log("verify: P0 skeleton passed")
}

main().catch((err) => {
  console.error("verify failed:", err)
  process.exit(1)
})
