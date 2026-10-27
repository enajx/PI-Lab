import { execFile } from "node:child_process"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { expect, test } from "vitest"
import { forwardSync, reverseSync } from "./synctex"

const execute = promisify(execFile)
const engines = [
  {
    name: "Tectonic",
    executable: process.env.PI_LAB_SYNCTEX_TECTONIC,
    arguments: ["--only-cached", "--synctex", "--keep-intermediates", "main.tex"],
  },
  {
    name: "latexmk",
    executable: process.env.PI_LAB_SYNCTEX_LATEXMK,
    arguments: ["-pdf", "-synctex=1", "-interaction=nonstopmode", "main.tex"],
  },
]

for (const engine of engines) {
  test.skipIf(!engine.executable)(
    `${engine.name}: live PDF lookup for nested included files`,
    async () => {
      const directory = await realpath(await mkdtemp(path.join(tmpdir(), "pi-lab-synctex-live-")))
      await mkdir(path.join(directory, "parts"))
      await writeFile(
        path.join(directory, "main.tex"),
        "\\documentclass{article}\n\\begin{document}\nFirst page text.\n\\newpage\n\\input{parts/chapter}\n\\end{document}\n",
      )
      await writeFile(
        path.join(directory, "parts/chapter.tex"),
        "Chapter opening.\\par\n\\input{parts/nested}\n",
      )
      const source = path.join(directory, "parts/nested.tex")
      await writeFile(
        source,
        "Nested first line.\\par\nNested second line, our target.\\par\nNested last line.\n",
      )
      await execute(engine.executable as string, engine.arguments, {
        cwd: directory,
        env: process.env,
      })
      const mapping = path.join(directory, "main.synctex.gz")
      const target = await forwardSync(mapping, source, 2, 1)
      expect(target.page).toBe(2)
      expect(await reverseSync(mapping, target.page, target.x + 25, target.y)).toEqual({
        sourceAbsolutePath: source,
        line: 2,
        column: 1,
      })
      const first = await forwardSync(mapping, path.join(directory, "main.tex"), 3, 1)
      expect(first.page).toBe(1)
      if (process.env.PI_LAB_SYNCTEX_CLI) {
        const { stdout } = await execute(
          process.env.PI_LAB_SYNCTEX_CLI,
          ["view", "-i", `2:1:${source}`, "-o", path.join(directory, "main.pdf")],
          { cwd: directory },
        )
        expect(Number(/^Page:(.*)$/m.exec(stdout)?.[1])).toBe(target.page)
        const cliX = Number(/^x:(.*)$/m.exec(stdout)?.[1])
        const cliY = Number(/^y:(.*)$/m.exec(stdout)?.[1])
        expect(Math.abs(target.x - cliX)).toBeLessThan(2)
        expect(Math.abs(target.y - cliY)).toBeLessThan(7)
        expect(await reverseSync(mapping, 2, cliX + 25, cliY)).toEqual({
          sourceAbsolutePath: source,
          line: 2,
          column: 1,
        })
      }
      await rm(directory, { recursive: true, force: true })
    },
    60_000,
  )
}
