import { Worker } from "node:worker_threads"
import { expect, test } from "vitest"
import { markdownLinkMatches } from "./markdownEditing"

interface LinkTiming {
  prefix: string
  smallMs: number
  largeMs: number
  matches: number
}

test("malformed link matching stays well below quadratic growth for ten times the input", async () => {
  // Run the production matcher outside React. A regressed expression must be interruptible.
  const worker = new Worker(
    `
    const { parentPort } = require("node:worker_threads");
    const matchLinks = (${markdownLinkMatches.toString()});
    function measure(text) {
      const start = performance.now();
      let matches = 0;
      for (const match of matchLinks(text)) matches += 1;
      return { ms: performance.now() - start, matches };
    }
    function median(values) { return values.sort((a, b) => a - b)[3]; }
    const results = ["[", "[x]("].map((prefix) => {
      for (let index = 0; index < 10; index += 1) measure(prefix.repeat(1000));
      const small = prefix.repeat(100000 / prefix.length);
      const large = prefix.repeat(1000000 / prefix.length);
      const smallSamples = Array.from({ length: 7 }, () => measure(small));
      const largeSamples = Array.from({ length: 7 }, () => measure(large));
      return {
        prefix,
        smallMs: median(smallSamples.map((sample) => sample.ms)),
        largeMs: median(largeSamples.map((sample) => sample.ms)),
        matches: largeSamples[0].matches,
      };
    });
    parentPort.postMessage(results);
  `,
    { eval: true },
  )
  const timeout = setTimeout(() => void worker.terminate(), 10_000)
  const timings = await new Promise<LinkTiming[]>((resolve, reject) => {
    worker.once("message", resolve)
    worker.once("error", reject)
    worker.once("exit", (code) =>
      reject(new Error(`Link matcher exited before reporting (${code}); 10-second limit`)),
    )
  }).finally(() => {
    clearTimeout(timeout)
    void worker.terminate()
  })
  for (const timing of timings) {
    expect(timing.matches).toBe(0)
    expect(timing.largeMs / Math.max(timing.smallMs, 0.1), timing.prefix).toBeLessThan(40)
  }
  console.info("Markdown link growth:", timings)
}, 15_000)
