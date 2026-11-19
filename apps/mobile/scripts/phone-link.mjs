#!/usr/bin/env node
// Print the phone app's one-line connect link from the JSON line that
// `enroll` prints (`{ machineId, deviceId, token }`, apps/desktop/src/server/enroll.ts).
// Run on the Mac whose PI Lab the phone should reach, for example with the
// installed app and `tailscale serve` in front of its server:
//
//   ELECTRON_RUN_AS_NODE=1 "/Applications/PI Lab.app/Contents/MacOS/PI Lab" \
//     "/Applications/PI Lab.app/Contents/Resources/app.asar/out/main/enroll.js" --name "Phone" \
//     | node apps/mobile/scripts/phone-link.mjs --address https://your-mac.your-tailnet.ts.net
//
// The link holds the device token: copy it to the phone only (for example
// through the clipboard of a password manager), and revoke the device from
// the desktop if it leaks.

import { readFileSync } from "node:fs"
import { parseArgs } from "node:util"

const { values } = parseArgs({ options: { address: { type: "string" } }, strict: true })
if (!values.address)
  throw new Error("Usage: <enroll command> | phone-link.mjs --address <https://host>")
const { token } = JSON.parse(readFileSync(0, "utf8"))
if (typeof token !== "string") throw new Error("the input has no token")
console.log(
  `pilab://connect?address=${encodeURIComponent(values.address)}&token=${encodeURIComponent(token)}`,
)
