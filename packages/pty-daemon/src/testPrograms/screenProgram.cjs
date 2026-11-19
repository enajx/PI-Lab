// Test program for the resume tests. It runs in a real PTY, puts stdin in raw
// mode, prints "R" when ready, and then reacts to single keys:
//   g  start the scenario named in argv[2]
//   1  next step (partial, osc)
//   q  stop streaming, print a final frame with FINAL, then stay silent
//   n  print one more frame ending in NEXT (tui)
//   b  print a burst of updates, then FINAL (status, redraw)
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

/** An agent's status line, rewritten in place below some history. */
function statusUpdate() {
  frame += 1
  return `\r\x1b[K\x1b[2m${"⠋⠙⠹⠸"[frame % 4]} Working (${frame}s) · ${frame * 37} tokens\x1b[0m`
}

/** A full-screen app redrawing every row. */
function redrawFrame(rows) {
  frame += 1
  let text = "\x1b[H"
  for (let row = 1; row <= rows; row++)
    text += `\x1b[${row};1H\x1b[3${(row + frame) % 8}m${`row ${row} frame ${frame} `.padEnd(40, ".")}\x1b[0m\x1b[K`
  return text
}

const steps = {
  tui: {
    g: () => {
      // The full-screen modes plus origin mode, so positions are relative to the region.
      out(`${enterFullscreen}\x1b[?6h`)
      timer = setInterval(() => out(fullscreenFrame(false)), 2)
    },
    q: () => {
      clearInterval(timer)
      // End with DEC graphics in G1 shifted in.
      // Under origin mode the frame's label scrolls off; FINAL goes at the cursor.
      out(`${fullscreenFrame(true)}FINAL\x1b)0\x0e`)
    },
    n: () => out(`\x0f${fullscreenFrame(false)}NEXT\x1b)0\x0e`),
  },
  status: {
    g: () => {
      let text = ""
      for (let index = 0; index < 500; index++)
        text += `history ${index} ${"h".repeat(index % 60)}\n`
      out(text)
    },
    b: () => {
      let text = ""
      for (let index = 0; index < 600; index++) text += statusUpdate()
      out(`${text}\r\x1b[KFINAL`)
    },
  },
  redraw: {
    g: () => {
      let text = ""
      for (let index = 0; index < 500; index++)
        text += `history ${index} ${"h".repeat(index % 60)}\n`
      out(`${text}\x1b[?1049h`)
    },
    b: () => {
      const rows = process.stdout.rows
      let text = ""
      for (let index = 0; index < 120; index++) text += redrawFrame(rows)
      out(`${text}\x1b[1;1HFINAL`)
    },
  },
  stream: {
    g: () => {
      timer = setInterval(() => out(streamLine()), 2)
    },
    q: () => {
      clearInterval(timer)
      out("FINAL\n")
    },
    b: () => {
      let text = ""
      for (let index = 0; index < 2000; index++) text += streamLine()
      out(`${text}FINAL\n`)
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
