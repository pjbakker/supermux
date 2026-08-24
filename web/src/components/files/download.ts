// One definition of "download this path".
//
// Lifted out of `file-list.tsx` when the bulk bar arrived: the row menu and the
// bulk fan-out must agree on exactly how a file leaves the app, and two copies
// of a blob-URL dance is two places to leak an object URL.
//
// It fetches through `filesApi.rawUrl` (which carries the `?_token=` fallback,
// because an anchor cannot set an Authorization header) and drives a synthetic
// `<a download>`. It REJECTS on a non-2xx so a caller can report the failure —
// the bulk summary's honesty depends on this throwing rather than silently
// downloading an error page.

import { filesApi } from '@/lib/api'

export async function downloadEntry(path: string, name: string): Promise<void> {
  const res = await fetch(filesApi.rawUrl(path))
  if (!res.ok) throw new Error(`download failed (${res.status})`)
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Defer revoke so the browser has time to start the download stream.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
