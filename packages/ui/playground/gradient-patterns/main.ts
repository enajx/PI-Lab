/**
 * Live playground for the gradient-patterns generator. Bun serves this HTML with
 * on-the-fly TS bundling (`bun run playground:gradients`), importing the exact
 * core the dashboard cards use — so tuning here reflects the real look. Dial in
 * blur / base-frequency / octaves / noise, then hand the values back to freeze
 * them as `GRADIENT_PATTERN_DEFAULTS` in `gradientPatterns.ts`.
 */

import { buildSVG, generateConfig } from "../../src/lib/gradientPatterns/gradientPatterns"

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const stage = $("stage")
const cfgEl = $("cfg")
const seedEl = $<HTMLInputElement>("seed")
const noiseEl = $<HTMLInputElement>("noise")
const freqEl = $<HTMLInputElement>("freq")
const octEl = $<HTMLInputElement>("oct")
const blurEl = $<HTMLInputElement>("blur")

function render(): void {
  const seed = Number(seedEl.value) | 0
  const cfg = generateConfig({ seed })
  // Let the sliders override the config's noise params for live tuning.
  cfg.noiseConfig.isNoise = noiseEl.checked
  cfg.noiseConfig.baseFrequency = Number.parseFloat(freqEl.value)
  cfg.noiseConfig.numOctaves = Number.parseInt(octEl.value, 10)
  stage.innerHTML = buildSVG(cfg, { blur: Number.parseInt(blurEl.value, 10) })
  cfgEl.textContent = JSON.stringify(
    { seed, blur: Number(blurEl.value), noise: cfg.noiseConfig },
    null,
    2,
  )
}

$("gen").addEventListener("click", () => {
  // A fresh seed. Kept off Math.random so a shown seed always reproduces.
  seedEl.value = String((Number(seedEl.value) | 0) + 1)
  render()
})

for (const el of [seedEl, noiseEl, freqEl, octEl, blurEl]) {
  el.addEventListener("input", render)
}

window.addEventListener("keydown", (event) => {
  if (event.code === "Space") {
    event.preventDefault()
    seedEl.value = String((Number(seedEl.value) | 0) + 1)
    render()
  }
})

render()
