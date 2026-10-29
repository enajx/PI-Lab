import { describe, expect, it } from "vitest"
import { leftoverE2eProcesses, type ProcessEntry } from "./leftoverProcesses"

const repo = "/Users/me/code/PI-Lab"
const tmp = "/var/folders/ab/xyz/T"
const tmpRoots = [tmp, `/private${tmp}`]
const electron = `${repo}/node_modules/.bun/electron@40.10.4+759ce506b1ed1a42/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron`
const helper = `${repo}/node_modules/.bun/electron@40.10.4+759ce506b1ed1a42/node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Helper (Renderer).app/Contents/MacOS/Electron Helper (Renderer)`
const daemonEntry = `${repo}/apps/desktop/out/pty-daemon/index.js`

/** Runner pid of the run doing the cleanup; absent from most tables. */
const ownRun = 5
const worker = `/opt/homebrew/bin/node ${repo}/node_modules/.bun/playwright@1.61.0/node_modules/playwright/lib/worker/workerProcessEntry.js`

function pids(list: ProcessEntry[]): number[] {
  return leftoverE2eProcesses(list, repo, tmpRoots, ownRun).map((entry) => entry.pid)
}

describe("leftoverE2eProcesses", () => {
  it("matches the test Electron when its command line names an e2e temp dir", () => {
    expect(
      pids([
        {
          pid: 11,
          ppid: 10,
          command: `${helper} --type=renderer --user-data-dir=${tmp}/pi-lab-e2e-term-AqlPb0 --app-path=${repo}/apps/desktop/out/main`,
        },
        {
          pid: 12,
          ppid: 1,
          command: `${electron} ${repo}/apps/desktop/out/main/index.js --user-data-dir=/private${tmp}/pi-lab-quick-edit-x1`,
        },
      ]),
    ).toEqual([11, 12])
  })

  it("matches the test Electron main through a child that names an e2e temp dir", () => {
    expect(
      pids([
        {
          pid: 10,
          ppid: 1,
          command: `${electron} --inspect=0 --remote-debugging-port=0 ${repo}/apps/desktop/out/main/index.js`,
        },
        {
          pid: 11,
          ppid: 10,
          command: `${helper} --type=renderer --user-data-dir=${tmp}/pi-update-feedback-Zz9`,
        },
      ]),
    ).toEqual([10, 11])
  })

  it("matches a test pty-daemon when no other Playwright run of this checkout is live", () => {
    expect(
      pids([
        {
          pid: 20,
          ppid: 1,
          command: `${electron} ${daemonEntry} ${tmp}/pi-lab-e2e-quit-a1/daemon.sock`,
        },
      ]),
    ).toEqual([20])
  })

  it("does not stop a live run's app, helpers, or daemon", () => {
    expect(
      pids([
        { pid: 70, ppid: 69, command: `node node_modules/@playwright/test/cli.js test` },
        { pid: 71, ppid: 70, command: worker },
        {
          pid: 72,
          ppid: 71,
          command: `${electron} --inspect=0 --remote-debugging-port=0 ${repo}/apps/desktop/out/main/index.js`,
        },
        {
          pid: 73,
          ppid: 72,
          command: `${helper} --type=renderer --user-data-dir=${tmp}/pi-lab-e2e-term-Live1`,
        },
        {
          pid: 74,
          ppid: 1,
          command: `${electron} ${daemonEntry} ${tmp}/pi-lab-e2e-term-Live1/daemon.sock`,
        },
      ]),
    ).toEqual([])
  })

  it("stops an app whose parent is not a Playwright process", () => {
    expect(
      pids([
        { pid: 80, ppid: 79, command: "/bin/zsh -l" },
        { pid: 81, ppid: 80, command: `${electron} ${repo}/apps/desktop/out/main/index.js` },
        {
          pid: 82,
          ppid: 81,
          command: `${helper} --type=renderer --user-data-dir=${tmp}/pi-lab-e2e-x-Orph`,
        },
      ]),
    ).toEqual([81, 82])
  })

  it("keeps every test daemon while another run of this checkout is live, still stops orphaned apps", () => {
    expect(
      pids([
        { pid: 90, ppid: 1, command: `${electron} ${repo}/apps/desktop/out/main/index.js` },
        { pid: 91, ppid: 90, command: `${helper} --user-data-dir=${tmp}/pi-lab-e2e-a-Dead` },
        {
          pid: 92,
          ppid: 1,
          command: `${electron} ${daemonEntry} ${tmp}/pi-lab-e2e-a-Dead/daemon.sock`,
        },
        { pid: 93, ppid: 1, command: worker },
        { pid: 94, ppid: 93, command: `${electron} ${repo}/apps/desktop/out/main/index.js` },
        {
          pid: 95,
          ppid: 94,
          command: `${helper} --user-data-dir=/private${tmp}/pi-lab-e2e-b-Live`,
        },
        {
          pid: 96,
          ppid: 1,
          command: `${electron} ${daemonEntry} ${tmp}/pi-lab-e2e-b-Live/pty-daemon.sock`,
        },
      ]),
    ).toEqual([90, 91])
  })

  it("stops a test daemon when only the current run and other checkouts' runs are live", () => {
    expect(
      pids([
        { pid: ownRun, ppid: 4, command: "node node_modules/@playwright/test/cli.js test" },
        { pid: 6, ppid: ownRun, command: worker },
        {
          pid: 7,
          ppid: 1,
          command:
            "/opt/homebrew/bin/node /Users/me/code/PI-Lab/.worktrees/x/node_modules/.bun/playwright@1.61.0/node_modules/playwright/lib/worker/workerProcessEntry.js",
        },
        {
          pid: 8,
          ppid: 1,
          command: `${electron} ${daemonEntry} ${tmp}/pi-lab-e2e-term-Old1/daemon.sock`,
        },
      ]),
    ).toEqual([8])
  })

  it("rejects an installed app even with an e2e temp dir", () => {
    expect(
      pids([
        {
          pid: 30,
          ppid: 1,
          command: `/Applications/PI Lab.app/Contents/MacOS/PI Lab --user-data-dir=${tmp}/pi-lab-e2e-term-x`,
        },
      ]),
    ).toEqual([])
  })

  it("rejects a release build under apps/desktop/release", () => {
    const release = `${repo}/apps/desktop/release/alpha/builds/1/mac-arm64/PI Lab Alpha.app/Contents`
    expect(
      pids([
        { pid: 40, ppid: 1, command: `${release}/MacOS/PI Lab Alpha` },
        {
          pid: 41,
          ppid: 40,
          command: `${release}/Frameworks/PI Lab Alpha Helper.app/Contents/MacOS/PI Lab Alpha Helper --user-data-dir=${tmp}/pi-lab-channels-q`,
        },
        {
          pid: 42,
          ppid: 40,
          command: `${release}/MacOS/PI Lab Alpha ${release}/Resources/app.asar/out/pty-daemon/index.js ${tmp}/pi-lab-channels-q/pty-daemon.sock`,
        },
      ]),
    ).toEqual([])
  })

  it("rejects the repo Electron when no e2e temp dir is involved", () => {
    expect(
      pids([
        { pid: 50, ppid: 1, command: `${electron} ${repo}/apps/desktop/out/main/index.js` },
        { pid: 51, ppid: 50, command: `${helper} --user-data-dir=/Users/me/.pi-lab-dev` },
        {
          pid: 52,
          ppid: 1,
          command: `${electron} ${daemonEntry} /Users/me/.pi-lab-dev/pty-daemon.sock`,
        },
      ]),
    ).toEqual([])
  })

  it("rejects an unrelated node process", () => {
    expect(
      pids([
        {
          pid: 60,
          ppid: 1,
          command: `node ${repo}/node_modules/@playwright/test/cli.js test --output=${tmp}/pi-lab-e2e-x`,
        },
        {
          pid: 61,
          ppid: 1,
          command: `/usr/local/bin/node /srv/other/index.js ${tmp}/pi-lab-e2e-y`,
        },
      ]),
    ).toEqual([])
  })
})
