import type { SetupProbe } from "./probe"

/** Credential-free deterministic status output for built Electron E2E runs. */
export const testSetupProbe: SetupProbe = async ({ command }) => {
  if (command.includes("claude")) {
    return {
      code: 0,
      stdout: JSON.stringify({
        loggedIn: true,
        authMethod: "test subscription",
        subscriptionType: "Test",
      }),
      stderr: "",
      timedOut: false,
    }
  }
  if (command.includes("codex")) {
    return {
      code: 0,
      stdout: "Logged in using ChatGPT",
      stderr: "",
      timedOut: false,
    }
  }
  return {
    code: 0,
    stdout: JSON.stringify({
      hosts: {
        "github.com": [{ active: true, state: "success", login: "pi-lab-test" }],
      },
    }),
    stderr: "",
    timedOut: false,
  }
}
