// Test program for input tests: puts stdin in raw mode, prints "R" when
// ready, and appends every chunk it reads to the log file (argv[2]) as one
// JSON string per line. With "paste" in argv[3] it first turns on bracketed
// paste (mode 2004). With "echo" in argv[3] it also echoes what it reads.
// It never exits on its own.
const { appendFileSync, writeFileSync } = require("node:fs")

const [logFile, mode] = process.argv.slice(2)
writeFileSync(logFile, "")
process.stdin.setRawMode(true)
process.stdin.on("data", (data) => {
  appendFileSync(logFile, `${JSON.stringify(data.toString("utf8"))}\n`)
  if (mode === "echo") process.stdout.write(data)
})
setInterval(() => {}, 1000)
process.stdout.write(mode === "paste" ? "\x1b[?2004hR" : "R")
