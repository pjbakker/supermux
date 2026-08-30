/**
 * `<CompanySettingsSheet>` — per-company branding + identity, opened from the
 * company switcher (a safe action, above the delete danger zone). Stage 1:
 *   · Logo — upload an image OR grab a site's favicon by URL (icon.horse /
 *     Google's favicon service, server-side). A picked photo is downscaled to the
 *     icon box first, so the camera-roll gesture works instead of bouncing off
 *     the server's size cap.
 *   · Name — the mutable `display_name`. The `#slug` is immutable (it is the
 *     folder + URL key) so it is shown read-only.
 *
 * The company's COLOUR is not a setting: `<CompanyMark>` derives it from the
 * immutable slug (the hue firewall), so there is nothing here to pick. An earlier
 * pass shipped a colour swatch that wrote an `accent` nothing ever read — a
 * control with no effect — and it is gone rather than decorative.
 *
 * Uses the canonical `<ResponsiveSheet>` (Vaul bottom sheet on coarse pointers,
 * `side="right"` on desktop) so it feels like one system with the create/delete
 * flows. Mobile-first: full-width controls, safe-area, no overflow at 390px.
 */
import * as React from 'react'
import { Globe, Loader2, Trash2, Upload } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ResponsiveSheet } from '@/components/ui/responsive-sheet'
import { CompanyMark } from '@/components/roster/company-mark'
import { useCompanyLogo, useUpdateCompany } from '@/hooks/use-companies'
import { type Company } from '@/lib/companies'
import { downscaleLogo } from '@/lib/logo-image'
import { SessionError } from '@/lib/api'

/** The server's sentence, without the typed-error prefix its envelope carries
 *  (`bad request: …`) — that prefix is wire shape, not copy — and punctuated like
 *  the sheet's own copy. Falls back to the caller's sentence for a transport
 *  failure that carries no message of its own. */
function serverSentence(e: unknown, fallback: string): string {
  if (!(e instanceof SessionError)) return fallback
  const msg = e.message
    .replace(/^(bad request|conflict|not found|forbidden|too many):\s*/i, '')
    .trim()
  if (!msg) return fallback
  const sentence = msg.charAt(0).toUpperCase() + msg.slice(1)
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`
}

export interface CompanySettingsSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  company: Company
}

export function CompanySettingsSheet({ open, onOpenChange, company }: CompanySettingsSheetProps) {
  const update = useUpdateCompany()
  const { upload, fromUrl, remove } = useCompanyLogo()
  const fileInput = React.useRef<HTMLInputElement | null>(null)

  const [name, setName] = React.useState(company.display_name)
  const [url, setUrl] = React.useState('')
  const [err, setErr] = React.useState<string | null>(null)
  const busy = upload.isPending || fromUrl.isPending || remove.isPending || update.isPending

  // Keep the name field in sync if the row refetches under us (another edit).
  React.useEffect(() => setName(company.display_name), [company.display_name])

  const hasLogo = !!company.has_logo

  async function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-picking the same file
    if (!file) return
    setErr(null)
    try {
      // A phone photo is megabytes; the logo box is 256px. Downscale first so the
      // camera-roll pick succeeds instead of tripping the server's size cap.
      await upload.mutateAsync({ id: company.id, file: await downscaleLogo(file) })
    } catch (e) {
      setErr(serverSentence(e, 'Upload failed.'))
    }
  }

  async function onFetchUrl() {
    const trimmed = url.trim()
    if (!trimmed) return
    setErr(null)
    try {
      await fromUrl.mutateAsync({ id: company.id, url: trimmed })
      setUrl('')
    } catch (e) {
      setErr(serverSentence(e, 'Could not fetch that favicon.'))
    }
  }

  async function onRemove() {
    setErr(null)
    try {
      await remove.mutateAsync(company.id)
    } catch (e) {
      setErr(serverSentence(e, 'Could not remove the logo.'))
    }
  }

  async function saveName() {
    const trimmed = name.trim()
    if (!trimmed || trimmed === company.display_name) return
    setErr(null)
    try {
      await update.mutateAsync({ id: company.id, fields: { display_name: trimmed } })
    } catch (e) {
      setErr(serverSentence(e, 'Could not rename.'))
    }
  }

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      title="Company settings"
      description={`#${company.slug}`}
    >
      <div className="flex flex-col gap-6 p-4">
        {/* ── Logo ─────────────────────────────────────────────────────────── */}
        <section className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <CompanyMark
              slug={company.slug}
              name={company.display_name}
              size={56}
              logo={company}
            />
            <div className="min-w-0">
              <div className="text-[13px] font-medium text-ink">Logo</div>
              <div className="text-[12px] leading-snug text-ink-2">
                Upload an image (PNG or JPEG — big ones are scaled down), or pull
                the favicon from a website.
              </div>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif,image/x-icon"
              className="hidden"
              onChange={onPickFile}
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => fileInput.current?.click()}
            >
              {upload.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Upload className="size-4" />
              )}
              Upload image
            </Button>
            {hasLogo && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-destructive hover:bg-destructive/10"
                disabled={busy}
                onClick={onRemove}
              >
                {remove.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Trash2 className="size-4" />
                )}
                Remove
              </Button>
            )}
          </div>

          {/* Favicon by URL */}
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Globe className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-3" />
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && onFetchUrl()}
                placeholder="example.com"
                inputMode="url"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                className="pl-8"
                disabled={busy}
              />
            </div>
            <Button type="button" size="sm" disabled={busy || !url.trim()} onClick={onFetchUrl}>
              {fromUrl.isPending ? <Loader2 className="size-4 animate-spin" /> : 'Get favicon'}
            </Button>
          </div>
        </section>

        {/* ── Name ─────────────────────────────────────────────────────────── */}
        <section className="flex flex-col gap-2">
          <label className="text-[13px] font-medium text-ink" htmlFor="company-name">
            Name
          </label>
          <div className="flex gap-2">
            <Input
              id="company-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={saveName}
              onKeyDown={(e) => e.key === 'Enter' && saveName()}
              disabled={busy}
              maxLength={80}
            />
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={busy || !name.trim() || name.trim() === company.display_name}
              onClick={saveName}
            >
              Save
            </Button>
          </div>
          <div className="text-[12px] text-ink-3">
            <code className="rounded bg-fill-soft px-1 py-0.5">#{company.slug}</code> is fixed — it
            is the folder and URL key.
          </div>
        </section>

        {err && <p className="text-[12px] text-destructive">{err}</p>}
      </div>
    </ResponsiveSheet>
  )
}
