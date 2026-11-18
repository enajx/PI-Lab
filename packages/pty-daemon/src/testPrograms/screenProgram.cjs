// Test program for the resume tests. It runs in a real PTY, puts stdin in raw
// mode, prints "R" when ready, and then reacts to single keys:
//   g  start the scenario named in argv[2]
//   1  next step (partial, osc)
//   q  stop streaming, print a final frame with FINAL, then stay silent
// It never exits on its own, so the screen stays put while tests compare.

const scenario = process.argv[2]
const out = (data) => process.stdout.write(data)
let frame = 0
let timer = null

/** One full-screen frame: header, a scrolled line in the region, status, cursor. */
function fullscreenFrame(final) {
  frame += 1
  const label = final ? "FINAL" : `frame ${frame}`
  return (
    `\x1b[1;1H\x1b[1;33m${label} 😀中文 ✓\x1b[0m\x1b[K\x1b[1;${40 + (frame % 9)}H\x1b7` +
    `\x1b[2;1H\x1b(0lqqqqk\x1b(B \x1b[36m${frame % 97}\x1b[0m\x1b[K` +
    `\x1b[20;1H\x1b[3${frame % 8}mline ${frame} 日本語 éß\x1b[0m\n` +
    `\x1b[24;1H\x1b[7mstatus ${frame}\x1b[0m\x1b[K` +
    `\x1b[${3 + (frame % 15)};${1 + (frame % 30)}H\x1b[32m`
  )
}

/** Enter the alternate screen and turn on the input modes a TUI uses. */
const enterFullscreen =
  "\x1b[?1049h\x1b[?1h\x1b=\x1b[?2004h\x1b[?1002h\x1b[?1006h\x1b[?1004h\x1b[?25l\x1b[3;20r"

function streamLine() {
  frame += 1
  return `\x1b[3${frame % 8}mline ${frame} 😀 中文 ✓ ${"x".repeat(frame % 40)}\x1b[0m\n`
}

const steps = {
  stream: {
    g: () => {
      timer = setInterval(() => out(streamLine()), 2)
    },
    q: () => {
      clearInterval(timer)
      out("FINAL\n")
    },
  },
  fullscreen: {
    g: () => {
      out(enterFullscreen)
      timer = setInterval(() => out(fullscreenFrame(false)), 2)
    },
    q: () => {
      clearInterval(timer)
      out(fullscreenFrame(true))
    },
  },
  burst: {
    g: () => {
      out(enterFullscreen)
      let text = ""
      for (let index = 0; index < 400; index++) text += fullscreenFrame(false)
      // End with a saved cursor, DEC graphics in G1 shifted in, and the cursor elsewhere.
      out(`${text}${fullscreenFrame(true)}\x1b[5;7H\x1b7\x1b)0\x0e\x1b[9;3H`)
    },
  },
  static: {
    g: () => {
      let text = ""
      for (let index = 0; index < 30; index++) text += `row ${index} ${"abcdefghij".repeat(5)}\n`
      out(`${text}FINAL`)
    },
  },
  cjk: {
    g: () => {
      let text = ""
      for (let index = 0; index < 200; index++) text += "😀中\n"
      out(text)
    },
  },
  partial: {
    g: () => out("hello \x1b[3"),
    1: () => out(Buffer.concat([Buffer.from("1mred "), Buffer.from([0xe4])])),
    2: () => out(Buffer.concat([Buffer.from([0xb8, 0xad]), Buffer.from(" done\x1b[0m FINAL")])),
  },
  osc: {
    g: () => out(`before \x1b]0;${"x".repeat(20_000)}`),
    1: () => out("\x07after FINAL"),
  },
}

const actions = steps[scenario]
if (!actions) throw new Error(`unknown scenario ${scenario}`)
process.stdin.setRawMode(true)
process.stdin.on("data", (data) => {
  for (const key of data.toString()) actions[key]?.()
})
setInterval(() => {}, 1000)
out("R")
