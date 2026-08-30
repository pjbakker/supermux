// Sample a company logo's dominant colour, client-side, so the server never
// decodes images. The result is PATCHed as the company `accent` (nav ring /
// chips / group-chat accent), so the surrounding UI matches the mark.
//
// Heuristic: downscale to a tiny grid, then average the COLOURFUL pixels
// (skipping transparent, near-white, near-black and near-grey), which pulls the
// brand hue out of an icon that sits on a white or transparent field. If nothing
// colourful survives (a black/white glyph), fall back to the plain average so we
// always return something usable.

/** A colour as `#rrggbb`. */
export type Hex = string

function toHex(r: number, g: number, b: number): Hex {
  const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')
  return `#${h(r)}${h(g)}${h(b)}`
}

/** Load a File or URL into an HTMLImageElement (CORS-anon so a same-origin logo
 *  GET taints nothing). */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('image load failed'))
    img.src = src
  })
}

/** Sample the dominant colour of an image `src` (a File object-URL or a same-origin
 *  logo URL). Returns `#rrggbb`, or `null` when the canvas can't be read. */
export async function dominantColor(src: string): Promise<Hex | null> {
  let img: HTMLImageElement
  try {
    img = await loadImage(src)
  } catch {
    return null
  }
  const N = 24
  const canvas = document.createElement('canvas')
  canvas.width = N
  canvas.height = N
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.drawImage(img, 0, 0, N, N)
  let data: Uint8ClampedArray
  try {
    data = ctx.getImageData(0, 0, N, N).data
  } catch {
    return null // tainted canvas
  }

  let cr = 0,
    cg = 0,
    cb = 0,
    cn = 0 // colourful accumulator
  let ar = 0,
    ag = 0,
    ab = 0,
    an = 0 // all-opaque accumulator
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i],
      g = data[i + 1],
      b = data[i + 2],
      a = data[i + 3]
    if (a < 128) continue
    ar += r
    ag += g
    ab += b
    an++
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const sat = max === 0 ? 0 : (max - min) / max
    // Skip near-white, near-black, and washed-out greys — they're background,
    // not brand.
    if (max > 245 && sat < 0.12) continue
    if (max < 24) continue
    if (sat < 0.18) continue
    // Weight by saturation so a vivid pixel counts more than a muted one.
    const w = 0.4 + sat
    cr += r * w
    cg += g * w
    cb += b * w
    cn += w
  }
  const [r, g, b] =
    cn > 0 ? [cr / cn, cg / cn, cb / cn] : an > 0 ? [ar / an, ag / an, ab / an] : [NaN, NaN, NaN]
  if (Number.isNaN(r)) return null
  // Reject an UNUSABLE accent: a black or white line-art favicon (e.g. a mono
  // glyph) samples to near-black / near-white / flat grey, which is invisible as
  // a ring or chip. Returning null leaves the pleasant generated slug hue in
  // place — the accent only overrides when the logo actually carries a colour.
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const sat = max === 0 ? 0 : (max - min) / max
  if (max < 48) return null // near-black
  if (min > 216) return null // near-white
  if (sat < 0.15) return null // flat grey — no brand hue to lift
  return toHex(r, g, b)
}

/** Convenience: sample straight from a File (object-URL created + revoked). */
export async function dominantColorOfFile(file: Blob): Promise<Hex | null> {
  const url = URL.createObjectURL(file)
  try {
    return await dominantColor(url)
  } finally {
    URL.revokeObjectURL(url)
  }
}
