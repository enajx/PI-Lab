// Stand-in for a Jupyter or marimo server, used by tests in place of the real tools.
// It reads the port and token from the same arguments PI Lab passes to the real
// tools, serves a small page on 127.0.0.1, and prints its URL the way the real tool
// does. Like JupyterLab, the page asks before it is unloaded. With PI_LAB_TEST_NOTEBOOK_MARKER set it appends "launch:<pid>" (on start),
// "start:<pid>" (once listening), "args:<json>" and "stop:<pid>" lines to that file.
const { appendFileSync } = require("node:fs")
const { createServer } = require("node:http")

const args = process.argv.slice(2)
const markerPath = process.env.PI_LAB_TEST_NOTEBOOK_MARKER

function mark(line) {
  if (markerPath) appendFileSync(markerPath, `${line}\n`)
}

function option(name) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === name) return args[index + 1]
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1)
  }
  return undefined
}

mark(`launch:${process.pid}`)

if (process.env.PI_LAB_TEST_NOTEBOOK_FAIL) {
  process.stderr.write(`${process.env.PI_LAB_TEST_NOTEBOOK_FAIL}\n`)
  process.exit(1)
}

const marimo = args.includes("marimo")
const port = Number(option("--ServerApp.port") ?? option("--port"))
const token = option("--ServerApp.token") ?? option("--token-password") ?? ""

const server = createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
  response.end(
    `<!doctype html><h1 id="notebook-stand-in">Stand-in notebook server</h1><p id="notebook-path">${request.url}</p><button id="notebook-edit">Edit</button><script>addEventListener("beforeunload", (event) => { event.preventDefault(); event.returnValue = "" })</script>`,
  )
})

function printUrl() {
  if (marimo) {
    process.stdout.write(
      `\n        Edit notebook in your browser 📝\n\n        ➜  URL: http://127.0.0.1:${port}?access_token=${token}\n\n`,
    )
  } else {
    process.stderr.write(
      `[I ServerApp] Jupyter Server is running at:\n[I ServerApp] http://127.0.0.1:${port}/lab?token=${token}\n`,
    )
  }
}

// With PI_LAB_TEST_NOTEBOOK_LISTEN_DELAY_MS the URL is printed first and the server
// listens later, as marimo's sandbox mode does.
const listenDelay = Number(process.env.PI_LAB_TEST_NOTEBOOK_LISTEN_DELAY_MS ?? "0")
if (listenDelay > 0) printUrl()
setTimeout(() => {
  server.listen(port, "127.0.0.1", () => {
    mark(`start:${process.pid}`)
    mark(`args:${JSON.stringify(args)}`)
    if (listenDelay === 0) printUrl()
  })
}, listenDelay)

function stop() {
  mark(`stop:${process.pid}`)
  server.close(() => process.exit(0))
}

process.on("SIGTERM", stop)
process.on("SIGINT", stop)
