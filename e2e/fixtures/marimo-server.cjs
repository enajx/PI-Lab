const { appendFileSync } = require("node:fs")
const { createServer } = require("node:http")

const port = Number(process.argv[2])
const markerPath = process.argv[3]

function mark(event) {
  if (markerPath) appendFileSync(markerPath, `${event}:${process.pid}\n`)
}

const server = createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
  response.end(`<!doctype html>
    <button id="marimo-counter">0</button>
    <script>
      const marimoCounter = document.getElementById("marimo-counter")
      marimoCounter.onclick = () => {
        marimoCounter.textContent = String(Number(marimoCounter.textContent) + 1)
      }
    </script>`)
})

server.listen(port, "127.0.0.1", () => mark("start"))

function stop() {
  mark("stop")
  server.close(() => process.exit(0))
}

process.on("SIGTERM", stop)
process.on("SIGINT", stop)
