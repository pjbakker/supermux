-- 0040_company_settings.sql
-- Company Settings: per-company branding (logo + derived accent) and, staged for
-- the bot-provisioning work, a shared brief and a default-connector set.
--
-- Every column is a PLAIN NULLABLE add with NO default: SQLite's ADD-COLUMN
-- FK/rewrite trap is a NON-NULL DEFAULT (see 0032's header), never a nullable
-- add, so these are safe on a live table with data.
--
--   logo               the raw image bytes (small — the upload path caps it),
--                      served by GET /api/companies/{id}/logo. NULL = fall back
--                      to the generated CompanyMark (initials + slug hue).
--   logo_mime          the stored image's content type (e.g. image/png), so the
--                      GET can set Content-Type without sniffing.
--   accent             a #rrggbb the client sampled from the logo (dominant
--                      color) — colours the nav ring / chips / group-chat accent
--                      so the surrounding UI matches the mark. NULL = slug hue.
--   brief              (Stage 2) a short mission/handbook injected into every
--                      company bot's CLAUDE.md so they share one goal.
--   default_connectors (Stage 2) JSON array of connector ids a NEW bot in this
--                      company inherits at creation. NULL = none.

ALTER TABLE companies ADD COLUMN logo               BLOB;
ALTER TABLE companies ADD COLUMN logo_mime          TEXT;
ALTER TABLE companies ADD COLUMN accent             TEXT;
ALTER TABLE companies ADD COLUMN brief              TEXT;
ALTER TABLE companies ADD COLUMN default_connectors TEXT;
