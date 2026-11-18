// Flood program for the flood harness (tests/flood/run-flood.mjs). It runs in
// a real PTY, puts stdin in raw mode, prints "R" when ready, and reacts to keys:
//   g  start writing output at the given rate
//   q  stop, print a line with FINAL, then stay silent
// Usage: node floodProgram.cjs <lines|fullscreen|echo> <bytes per second> <counter file>
//   lines       numbered coloured lines (a build log or `yes`)
//   fullscreen  full-screen redraws in the alternate screen (a TUI)
//   echo        no flood: echo every key back (the quiet interactive terminal)
// While flooding it writes the number of PTY bytes it has produced so far to
// the counter file every 50 ms. The PTY turns each "\n" into "\r\n", so a
// written "\n" counts as two bytes. It never exits on its own.

const { writeFileSync } = require("node:fs")

const [mode, rateText, counterFile] = process.argv.slice(2)
const rate = Number(rateText)
const TICK_MS = 10
let produced = 1 // the "R" printed at start
let seq = 0
let timer = null
let counterTimer = null
let waitingDrain = false

/** PTY bytes for this text: UTF-8 length plus one CR per LF. */
function ptyBytes(text) {
  let newlines = 0
  for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) === 10) newlines++
  return Buffer.byteLength(text) + newlines
}

function line() {
  seq += 1
  return `\x1b[3${seq % 8}mL ${seq} ${Date.now()} 中文 ✓ ${"x".repeat(seq % 60)}\x1b[0m\n`
}

function frame() {
  seq += 1
  let text = `\x1b[H\x1b[1;33mframe ${seq} ${Date.now()}\x1b[0m\x1b[K`
  for (let row = 2; row <= 23; row++) {
    text += `\x1b[${row};1H\x1b[3${(seq + row) % 8}m${String(row).padStart(2)} ${"#".repeat((seq + row * 7) % 70)}\x1b[0m\x1b[K`
  }
  return `${text}\x1b[24;1H\x1b[7mstatus ${seq}\x1b[0m\x1b[K`
}

function tick() {
  if (waitingDrain) return
  const budget = (rate * TICK_MS) / 1000
  let text = ""
  let bytes = 0
  while (bytes < budget) {
    const piece = mode === "fullscreen" ? frame() : line()
    text += piece
    bytes += ptyBytes(piece)
  }
  produced += bytes
  if (!process.stdout.write(text)) {
    waitingDrain = true
    process.stdout.once("drain", () => {
      waitingDrain = false
    })
  }
}

function start() {
  if (timer !== null || mode === "echo") return
  if (mode === "fullscreen") {
    const enter = "\x1b[?1049h\x1b[?25l"
    produced += ptyBytes(enter)
    process.stdout.write(enter)
  }
  timer = setInterval(tick, TICK_MS)
  counterTimer = setInterval(() => writeFileSync(counterFile, String(produced)), 50)
}

function stop() {
  clearInterval(timer)
  clearInterval(counterTimer)
  timer = null
  const end = "FINAL\n"
  produced += ptyBytes(end)
  process.stdout.write(end)
  writeFileSync(counterFile, String(produced))
}

process.stdin.setRawMode(true)
process.stdin.on("data", (data) => {
  if (mode === "echo") {
    process.stdout.write(data)
    return
  }
  const key = data.toString()
  if (key === "g") start()
  if (key === "q") stop()
})
setInterval(() => {}, 1000)
process.stdout.write("R")
