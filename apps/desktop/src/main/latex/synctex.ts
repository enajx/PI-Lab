/*
 * SyncTeX record parsing adapted from LaTeX Workshop's synctexjs.ts:
 * https://github.com/James-Yu/LaTeX-Workshop/blob/master/src/locate/synctex/synctexjs.ts
 * https://github.com/tdurieux/synctex-js
 *
 * MIT License
 * Copyright (c) 2018 Thomas Durieux
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { createReadStream } from "node:fs"
import { stat } from "node:fs/promises"
import path from "node:path"
import { gunzipSync } from "node:zlib"

const MAX_FILE_BYTES = 16 * 1024 * 1024
const MAX_TEXT_BYTES = 32 * 1024 * 1024
const MAX_NODES = 200_000
const SCALED_POINTS_PER_PDF_POINT = 65_781.76

type Node = {
  source: string
  line: number
  page: number
  x: number
  y: number
  width: number
  height: number
  depth: number
}
type Mapping = { nodes: Node[] }
type CacheEntry = { fingerprint: string; mapping: Mapping }
const cache = new Map<string, CacheEntry>()

/** Reads only the mapping itself. Source files are never opened. */
async function readMapping(mappingPath: string): Promise<Mapping> {
  const filename = path.resolve(mappingPath)
  const info = await stat(filename)
  if (!info.isFile() || info.size > MAX_FILE_BYTES)
    throw new Error("SyncTeX file exceeds the supported size")
  const fingerprint = `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`
  const cached = cache.get(filename)
  if (cached?.fingerprint === fingerprint) return cached.mapping
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of createReadStream(filename)) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_FILE_BYTES) throw new Error("SyncTeX file exceeds the supported size")
    chunks.push(buffer)
  }
  const bytes = Buffer.concat(chunks)
  const text = (
    bytes[0] === 0x1f && bytes[1] === 0x8b
      ? gunzipSync(bytes, { maxOutputLength: MAX_TEXT_BYTES })
      : bytes
  ).toString("utf8")
  const mapping = parseMapping(text, path.dirname(filename))
  if (cache.size >= 2) cache.delete(cache.keys().next().value as string)
  cache.set(filename, { fingerprint, mapping })
  return mapping
}

/** Parses version-one PDF records, with coordinates measured from the page's top left. */
function parseMapping(text: string, directory: string): Mapping {
  if (
    !text.startsWith("SyncTeX Version:1\n") ||
    !text.includes("\nContent:\n") ||
    !text.includes("\nPostamble:\n")
  ) {
    throw new Error("Invalid SyncTeX mapping")
  }
  const files = new Map<number, string>()
  const nodes: Node[] = []
  const parents: Node[] = []
  let page = 0
  let unit = 1
  let magnification = 1000
  let xOffset = 0
  let yOffset = 0
  for (const record of text.split("\n")) {
    const input = /^Input:(\d+):(.*)$/.exec(record)
    if (input) {
      if (input[2]) files.set(Number(input[1]), path.resolve(directory, input[2]))
      continue
    }
    const setting = /^(Unit|Magnification|X Offset|Y Offset):(-?\d+(?:\.\d+)?)$/.exec(record)
    if (setting) {
      const value = Number(setting[2])
      if (!Number.isFinite(value)) throw new Error("Invalid SyncTeX scale")
      if (setting[1] === "Unit") unit = value
      if (setting[1] === "Magnification") magnification = value
      if (setting[1] === "X Offset") xOffset = value
      if (setting[1] === "Y Offset") yOffset = value
      continue
    }
    const sheet = /^\{(\d+)$/.exec(record)
    if (sheet) {
      page = Number(sheet[1])
      parents.length = 0
      continue
    }
    if (record.startsWith("}")) {
      page = 0
      parents.length = 0
      continue
    }
    if (record === "]" || record === ")") {
      parents.pop()
      continue
    }
    // Boxes contain dimensions; leaf records can omit them. Columns, when present,
    // follow the source line. Most engines only record source lines.
    const match =
      /^([[(hvkxg$])(\d+),(\d+)(?:,(-?\d+))?:(-?\d+),(-?\d+)(?::(-?\d+)(?:,(-?\d+),(-?\d+))?)?$/.exec(
        record,
      )
    if (!match || page === 0) continue
    const numbers = match
      .slice(2)
      .filter((value) => value !== undefined)
      .map(Number)
    if (
      !numbers.every(Number.isSafeInteger) ||
      !Number.isSafeInteger(page) ||
      unit <= 0 ||
      magnification <= 0
    ) {
      throw new Error("Invalid SyncTeX coordinates")
    }
    const scale = (unit * magnification) / (1000 * SCALED_POINTS_PER_PDF_POINT)
    const parent = parents[parents.length - 1]
    const box = match[1] === "[" || match[1] === "("
    const node: Node = {
      source: files.get(Number(match[2])) ?? "",
      line: Number(match[3]),
      page,
      x: Number(match[5]) * scale + xOffset / SCALED_POINTS_PER_PDF_POINT,
      y: Number(match[6]) * scale + yOffset / SCALED_POINTS_PER_PDF_POINT,
      width: Number(match[7] ?? 0) * scale,
      height: box ? Number(match[8] ?? 0) * scale : (parent?.height ?? 0),
      depth: box ? Number(match[9] ?? 0) * scale : (parent?.depth ?? 0),
    }
    if (![node.x, node.y, node.width, node.height, node.depth].every(Number.isFinite))
      throw new Error("Invalid SyncTeX coordinates")
    if (box) {
      parents.push(node)
      if (parents.length > 1024)
        throw new Error("SyncTeX mapping exceeds the supported nesting depth")
    } else if (node.source && node.line > 0) {
      nodes.push(node)
      if (nodes.length > MAX_NODES)
        throw new Error("SyncTeX mapping exceeds the supported node count")
    }
  }
  if (!nodes.length) throw new Error("Invalid SyncTeX mapping: no source positions")
  return { nodes }
}

/** Finds the nearest recorded source line. SyncTeX usually has no column information. */
export async function forwardSync(
  mappingPath: string,
  sourceAbsolutePath: string,
  line: number,
  column: number,
): Promise<{ page: number; x: number; y: number }> {
  if (
    !path.isAbsolute(sourceAbsolutePath) ||
    !Number.isSafeInteger(line) ||
    line < 1 ||
    !Number.isSafeInteger(column) ||
    column < 0
  ) {
    throw new Error("Invalid SyncTeX source position")
  }
  const { nodes } = await readMapping(mappingPath)
  const source = path.normalize(sourceAbsolutePath)
  let best: Node | undefined
  for (const node of nodes) {
    if (node.source !== source) continue
    if (!best || Math.abs(node.line - line) < Math.abs(best.line - line)) best = node
  }
  if (!best) throw new Error("No SyncTeX mapping for the source")
  return { page: best.page, x: best.x, y: best.y - best.height / 2 }
}

/** Finds the nearest PDF position and returns a source path without opening that file. */
export async function reverseSync(
  mappingPath: string,
  page: number,
  x: number,
  y: number,
): Promise<{ sourceAbsolutePath: string; line: number; column: number }> {
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isFinite(x) || !Number.isFinite(y))
    throw new Error("Invalid SyncTeX PDF position")
  const { nodes } = await readMapping(mappingPath)
  let best: Node | undefined
  let bestDistance = Number.POSITIVE_INFINITY
  for (const node of nodes) {
    if (node.page !== page) continue
    const left = Math.min(node.x, node.x + node.width)
    const right = Math.max(node.x, node.x + node.width)
    const dx = Math.max(left - x, 0, x - right)
    const dy = Math.max(node.y - node.height - y, 0, y - node.y - node.depth)
    const distance = dx * dx + dy * dy
    if (distance < bestDistance) {
      best = node
      bestDistance = distance
    }
  }
  if (!best) throw new Error("No SyncTeX mapping for the page")
  return { sourceAbsolutePath: best.source, line: best.line, column: 1 }
}
