// Prepare a picked image for the company-logo upload, client-side.
//
// The natural mobile gesture — "set our logo" from the camera roll — hands us a
// multi-megabyte photo, while the server caps a stored logo at 512 KB. Failing
// that with a size error is a dead end on the most likely path, so we do what
// the picture is FOR instead: a logo is an app icon, so anything bigger than the
// icon box is downscaled to it before it goes over the wire. Best-effort by
// design — a blob the browser cannot decode is uploaded untouched and the
// server's own cap answers, with its own sentence.

/** The server's `MAX_LOGO_BYTES` (`server/src/companies/logo.rs`). Mirrored here
 *  only to decide whether a decodable image is worth re-encoding. */
export const MAX_LOGO_BYTES = 512 * 1024

/** Longest edge we ever upload. An app icon, not a photo — the same ceiling
 *  icon.horse's apple-touch icons sit at. */
export const LOGO_MAX_EDGE = 256

/** Fit `w × h` inside a `max × max` box, preserving aspect ratio and NEVER
 *  upscaling (a 32px favicon stays 32px — blowing it up would only blur it).
 *  Pure so the arithmetic is unit-tested without a DOM. */
export function fitWithin(
  w: number,
  h: number,
  max: number,
): { width: number; height: number } {
  if (w <= 0 || h <= 0) return { width: 0, height: 0 }
  const scale = Math.min(1, max / Math.max(w, h))
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) }
}

/** Downscale `file` to the icon box when it is bigger than one, or return it
 *  unchanged. PNG out, so a logo's transparency survives the re-encode. */
export async function downscaleLogo(file: Blob): Promise<Blob> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    return file // not decodable here (or no `createImageBitmap`) — let the server judge
  }
  const { width, height } = fitWithin(bitmap.width, bitmap.height, LOGO_MAX_EDGE)
  // Already an icon AND already small: upload the original bytes rather than
  // re-encoding crisp artwork for nothing.
  if (width === bitmap.width && height === bitmap.height && file.size <= MAX_LOGO_BYTES) {
    bitmap.close()
    return file
  }
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    bitmap.close()
    return file
  }
  ctx.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()
  const out = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  return out ?? file
}
