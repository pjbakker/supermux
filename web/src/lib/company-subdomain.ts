// The invite wizard's "Choose your domain" subdomain decisions — the pure half,
// kept out of the JSX so they are testable without a DOM (same shape as
// `quick-tunnel.ts`).
//
// WHY this file exists: the wizard SUGGESTED `<company-slug>.<zone>` and then
// hard-coded it — the label was a `${company.slug}.${chosen}` template literal
// with no input in front of it, so an owner whose company is called "Enverder"
// could only ever publish `enverder.iwd.nl`. The suggestion was right; the
// immutability was the bug. The label is now the owner's to type, which means the
// SAME rule has to hold on both sides of the wire: the server's `is_dns_label`
// (`server/src/config.rs`) and `subdomainError` below must agree, or the wizard
// happily submits something the API refuses.

/** One label under the base domain, e.g. the `team` in `team.example.com`. */
export const MAX_LABEL_LEN = 63

/** Why `label` is not a usable subdomain, or `null` when it is fine.
 *
 *  Mirrors the server's `is_dns_label`: 1..63 characters of `a-z`, `0-9` and `-`,
 *  never starting or ending with `-`. Deliberately narrower than a hostname in
 *  general (no dots): Cloudflare's Universal SSL certificate covers one level
 *  (`<label>.<zone>`), so `eu.team` would resolve and then fail its TLS
 *  handshake.
 *
 *  Callers pass the RAW input — trimming + lower-casing is what the server does
 *  too (`Team ` is accepted and stored as `team`), so the field never scolds
 *  someone for typing a capital. */
export function subdomainError(label: string): string | null {
  const v = label.trim().toLowerCase()
  if (v.length === 0) return 'Pick a name for the address'
  if (v.length > MAX_LABEL_LEN) return `Keep it to ${MAX_LABEL_LEN} characters or fewer`
  if (v.startsWith('-') || v.endsWith('-')) return 'Cannot start or end with a hyphen'
  if (!/^[a-z0-9-]+$/.test(v)) return 'Use only letters, numbers and hyphens'
  return null
}

/** The address a label + zone produce — what the preview line shows. Never a
 *  half-built host: with nothing chosen yet it says so in words instead of
 *  rendering a fake domain. */
export function previewHost(label: string, zone: string | null): string {
  const v = label.trim().toLowerCase()
  return `${v || '<name>'}.${zone ?? '<your-domain>'}`
}

/** The `POST /api/companies/{id}/host` body. `subdomain` is omitted when the
 *  caller has no opinion — the server then KEEPS the label this company already
 *  publishes (and only falls back to the slug when there is no entry yet), so a
 *  bodyless re-assert can never rename an owner-chosen address back. */
export function hostPayload(subdomain?: string): { subdomain?: string } {
  const v = subdomain?.trim().toLowerCase()
  return v ? { subdomain: v } : {}
}

/** The label the wizard SUGGESTS for a company: its slug, made legal (lower-cased,
 *  anything outside `a-z0-9-` folded to a hyphen, runs collapsed, ends trimmed,
 *  63 max). A suggestion only — the owner types over it — but it must be a label
 *  the server will accept, so the common case is one confirm and never a company
 *  whose name happens to contain a dot or an underscore staring at a red error. */
export function suggestLabel(slug: string): string {
  const v = slug
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, MAX_LABEL_LEN)
    .replace(/-$/, '')
  return v || 'team'
}

/** The label part of `host` under `zone` (`team.example.com` + `example.com` →
 *  `team`), or `''` when the host does not sit directly under that zone — which is
 *  exactly when there is nothing to pre-fill an edit field with. */
export function labelOf(host: string, zone: string): string {
  const h = host.trim().toLowerCase()
  const suffix = `.${zone.trim().toLowerCase()}`
  if (!h.endsWith(suffix)) return ''
  const label = h.slice(0, -suffix.length)
  return subdomainError(label) ? '' : label
}

/** The promise the wizard makes BEFORE the click: exactly what supermux will add
 *  to the operator's Cloudflare zone. One record, named in full — never a vague
 *  "we'll set up DNS", and never a wildcard (`*.<zone>`), which is what this
 *  product used to write and what made the footprint indefensible: it pointed
 *  every undefined name on someone's real domain at one box. */
export function dnsPlanLine(label: string, zone: string | null): string {
  return `Creates one DNS record: ${previewHost(label, zone)}`
}
