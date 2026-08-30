// iOS PWA splash-screen generator.
//
// iOS Safari does not read the manifest `background_color` for the launch
// screen of a home-screen PWA — it needs a per-device <link rel="apple-touch-
// startup-image"> PNG matched by a media query. This script renders one PNG per
// supported iPhone size: a #0a0a0a field (identical to globals.css --background
// and the manifest background_color, so there is NO flash of a wrong color)
// with the app icon centered.
//
// SINGLE SOURCE OF TRUTH: the mark is lifted straight out of public/icon.svg, so
// the splash logo can never drift from the home-screen icon again. (It did: the
// brand moved to the blue supermux chevrons while this script still hand-drew the
// OLD amber terminal glyph, so every iOS launch screen showed a stale amber mark
// under a blue icon.)
//
// Run: `node scripts/build-splash.mjs` (needs `rsvg-convert` on PATH). `splashSvg`
// + `DEVICES` are exported so a headless browser can rasterize the identical SVGs
// where rsvg-convert is unavailable. Output: web/public/splash/apple-splash-<w>-<h>.png.
// Re-run after the icon changes; the generated files are committed (the build
// does not regenerate).
//
// The device list + media queries are mirrored in src/lib/ios-splash.ts so the
// runtime <link> tags and the rendered files never drift.

import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const publicDir = join(here, '..', 'public')
const outDir = join(publicDir, 'splash')

// Portrait device pixel sizes (width × height) covering iPhone SE → 16 Pro Max,
// including the notch (12/13/14) and Dynamic Island (14 Pro/15/16) families.
// Both orientations are emitted so a landscape launch is also covered.
const DEVICES = [
  [1290, 2796], // iPhone 16 Pro Max / 15 Pro Max / 14 Pro Max
  [1179, 2556], // iPhone 16 Pro / 16 / 15 Pro / 15 / 14 Pro
  [1170, 2532], // iPhone 14 / 13 / 13 Pro / 12 / 12 Pro
  [1284, 2778], // iPhone 14 Plus / 13 Pro Max / 12 Pro Max
  [1080, 2340], // iPhone 13 mini / 12 mini
  [828, 1792], // iPhone 11 / XR
  [750, 1334], // iPhone SE (2nd/3rd gen) / 8
]

const BG = '#0a0a0a'

// The icon mark = public/icon.svg with its own dark background rect removed, so
// only the logo paths sit over our splash field. `viewBox="0 0 1024 1024"` is
// preserved, so nesting it in a `mark`×`mark` box scales it cleanly.
export const ICON_INNER = (() => {
  const svg = readFileSync(join(publicDir, 'icon.svg'), 'utf8')
  const inner = svg
    .replace(/^[\s\S]*?<svg[^>]*>/, '') // drop the outer <svg …>
    .replace(/<\/svg>\s*$/, '') // drop the closing </svg>
    .replace(/<rect\b[^>]*fill="#0a0a0a"[^>]*\/>/, '') // drop the opaque bg rect
    .replace(/<title>[\s\S]*?<\/title>/, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim()
  return inner
})()

// One splash SVG: dark field + centered icon mark, sized to ~22% of the shorter
// edge so it reads on every device.
export function splashSvg(w, h) {
  const mark = Math.round(Math.min(w, h) * 0.22)
  const x = Math.round(w / 2 - mark / 2)
  const y = Math.round(h / 2 - mark / 2)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <rect width="${w}" height="${h}" fill="${BG}"/>
  <svg x="${x}" y="${y}" width="${mark}" height="${mark}" viewBox="0 0 1024 1024">
    ${ICON_INNER}
  </svg>
</svg>`
}

export { DEVICES, outDir }

// When run directly, rasterize with rsvg-convert (the sibling chromium script is
// the fallback when it is not installed).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  for (const [w, h] of DEVICES) {
    for (const [pw, ph] of [
      [w, h],
      [h, w],
    ]) {
      const name = `apple-splash-${pw}-${ph}.png`
      const tmp = join(outDir, `.${name}.svg`)
      writeFileSync(tmp, splashSvg(pw, ph))
      execFileSync('rsvg-convert', ['-w', String(pw), '-h', String(ph), '-o', join(outDir, name), tmp])
      rmSync(tmp)
      console.log(`splash → ${name}`)
    }
  }
  console.log(`done — ${DEVICES.length * 2} splash images in public/splash/`)
}
