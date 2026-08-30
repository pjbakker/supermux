//! Company logo: upload, serve, clear, and "grab the favicon from a URL".
//!
//! Storage is a BLOB on the `companies` row (small images; the upload path caps
//! the size), served back with its stored mime. Raster only — see
//! [`is_supported_image`] — and no image decoding happens server-side; the client
//! downscales an oversized photo before it uploads.
//!
//! `from_url` grabs a site's icon via KEYLESS favicon services — icon.horse
//! (which resolves the site's best icon, apple-touch preferred) with Google's
//! faviconV2 as the fallback. We only ever fetch from those two fixed, trusted
//! hosts — the user's URL is reduced to a bare domain and handed over as a path/
//! query param — so there is no arbitrary-host outbound fetch and no SSRF surface
//! to guard. No dark-variant (the keyless tradeoff); the client renders the mark
//! on a subtle tile so a dark glyph stays legible without a hard-white plate.

use std::time::Duration;

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::Json;
use reqwest::Url;
use serde::Deserialize;

use super::{ok, Envelope};
use crate::db::companies::{self, Company};
use crate::error::AppError;
use crate::state::AppState;

/// Hard ceiling on a stored logo (BLOB on the row + shipped to every client that
/// renders the mark). 512 KiB is generous for an icon and cheap to serve.
const MAX_LOGO_BYTES: usize = 512 * 1024;

/// The image content types we accept — an icon, not an arbitrary upload.
///
/// RASTER ONLY, deliberately: the stored bytes are served back same-origin from
/// a directly-navigable, `?_token=`-authenticated URL, and an `image/svg+xml`
/// document runs its own inline `<script>` under the app's CSP. This is the same
/// rule `files::upload_disposition` already keeps for uploads (svg/html are never
/// inline) — kept here by never storing an SVG at all, since icon.horse and
/// Google's faviconV2 return raster anyway.
fn is_supported_image(mime: &str) -> bool {
    matches!(
        mime.split(';').next().unwrap_or("").trim(),
        "image/png"
            | "image/jpeg"
            | "image/webp"
            | "image/gif"
            | "image/x-icon"
            | "image/vnd.microsoft.icon"
    )
}

/// `PUT /api/companies/{id}/logo` — the raw image bytes in the body, the mime in
/// `Content-Type`. Admin-only; caps the size and the type.
pub async fn put_handler(
    State(state): State<AppState>,
    ctx: crate::scope::OptCtx,
    Path(id): Path<i64>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<Envelope<Company>>, AppError> {
    crate::scope::require_admin(ctx.0.as_ref(), &format!("/api/companies/{id}/logo"))?;
    companies::get(&state.pool, id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("company id={id}")))?;

    let mime = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    store_logo(&state, id, &body, &mime).await
}

/// Shared store path for both the direct upload and the URL grab: validates the
/// mime + size, writes the BLOB, and returns the refreshed row.
async fn store_logo(
    state: &AppState,
    id: i64,
    bytes: &[u8],
    mime: &str,
) -> Result<Json<Envelope<Company>>, AppError> {
    // The strings here are USER-FACING copy — the settings sheet prints the
    // server's sentence verbatim — so they read as sentences, not as debug dumps.
    let mime = mime.split(';').next().unwrap_or("").trim();
    if !is_supported_image(mime) {
        return Err(AppError::BadRequest(
            "that file isn't an image we can use (PNG, JPEG, WebP, GIF or ICO)".into(),
        ));
    }
    if bytes.is_empty() {
        return Err(AppError::BadRequest("that image is empty".into()));
    }
    if bytes.len() > MAX_LOGO_BYTES {
        return Err(AppError::BadRequest(format!(
            "that image is too large — keep it under {} KB",
            MAX_LOGO_BYTES / 1024
        )));
    }
    companies::set_logo(&state.pool, id, bytes, mime).await?;
    let row = companies::get(&state.pool, id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("company id={id}")))?;
    Ok(ok(row))
}

/// `GET /api/companies/{id}/logo` — the stored bytes with their mime, or 404 when
/// the company has no logo (the client then renders the generated mark).
///
/// READ, not admin: a scoped member has to see their OWN company's mark (it is on
/// every companies surface). The scope check lives HERE — the same
/// `Scope::of` + `sees` shape the sibling company reads use — so the member
/// allowlist entry for this path can never become a cross-company logo read.
pub async fn get_handler(
    State(state): State<AppState>,
    ctx: crate::scope::OptCtx,
    Path(id): Path<i64>,
) -> Result<impl IntoResponse, AppError> {
    if !crate::scope::Scope::of(ctx.0.as_ref()).sees(Some(id)) {
        return Err(AppError::NotFound(format!("company id={id}")));
    }
    let (bytes, mime) = companies::get_logo(&state.pool, id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("no logo for company id={id}")))?;
    // Private + short cache: the logo can change from the settings sheet, and it
    // is owner data, so no shared/long caching.
    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, mime),
            (
                header::CACHE_CONTROL,
                "private, max-age=60, must-revalidate".to_string(),
            ),
        ],
        bytes,
    ))
}

/// `DELETE /api/companies/{id}/logo` — back to the generated mark.
pub async fn delete_handler(
    State(state): State<AppState>,
    ctx: crate::scope::OptCtx,
    Path(id): Path<i64>,
) -> Result<Json<Envelope<Company>>, AppError> {
    crate::scope::require_admin(ctx.0.as_ref(), &format!("/api/companies/{id}/logo"))?;
    companies::clear_logo(&state.pool, id).await?;
    let row = companies::get(&state.pool, id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("company id={id}")))?;
    Ok(ok(row))
}

#[derive(Deserialize)]
pub struct FromUrlInput {
    pub url: String,
}

/// `POST /api/companies/{id}/logo/from-url` — grab the site's icon via the two
/// keyless services below and store it. Admin-only.
pub async fn from_url_handler(
    State(state): State<AppState>,
    ctx: crate::scope::OptCtx,
    Path(id): Path<i64>,
    Json(input): Json<FromUrlInput>,
) -> Result<Json<Envelope<Company>>, AppError> {
    crate::scope::require_admin(ctx.0.as_ref(), &format!("/api/companies/{id}/logo/from-url"))?;
    companies::get(&state.pool, id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("company id={id}")))?;

    // `domain_of` already rejects whitespace and requires a dot, so the host is a
    // clean URL-safe token — safe to interpolate into a query directly.
    let domain = domain_of(input.url.trim())?;

    // KEYLESS, FIXED TRUSTED HOSTS (no arbitrary-host fetch → no SSRF surface):
    //  1. icon.horse resolves the site's BEST icon for us — it prefers the
    //     apple-touch-icon (a full app icon, up to 256px), which reads far better
    //     as a tile than a 16px favicon.
    //  2. Google's faviconV2 is the fallback when icon.horse is down / has nothing.
    // Both return the site's DEFAULT icon (no dark-variant — that is the deliberate
    // keyless tradeoff; the mark renders on a subtle tile so a dark glyph stays
    // legible instead of forcing a hard-white plate).
    let sources = [
        format!("https://icon.horse/icon/{domain}"),
        format!("https://www.google.com/s2/favicons?sz=128&domain={domain}"),
    ];
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .user_agent("Mozilla/5.0 (compatible; supermux-favicon/1.0)")
        .build()
        .map_err(|e| AppError::Internal(anyhow::anyhow!(e)))?;

    for src in sources {
        let Ok(url) = Url::parse(&src) else { continue };
        let Ok(resp) = client.get(url).send().await else { continue };
        if !resp.status().is_success() {
            continue;
        }
        let mime = resp
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("image/png")
            .to_string();
        let Ok(bytes) = resp.bytes().await else { continue };
        // Only accept a real, non-empty image within the cap; otherwise try the
        // next source.
        if is_supported_image(&mime) && !bytes.is_empty() && bytes.len() <= MAX_LOGO_BYTES {
            return store_logo(&state, id, &bytes, &mime).await;
        }
    }
    Err(AppError::BadRequest(format!(
        "we couldn't find an icon for {domain}"
    )))
}

/// Reduce whatever the user pasted — a full URL or a bare domain — to a clean
/// host for Google's favicon service. Accepts `acme.com`, `https://acme.com/x`,
/// `www.acme.com`; rejects empty / spaced / hostless input.
fn domain_of(raw: &str) -> Result<String, AppError> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err(AppError::BadRequest("empty URL".into()));
    }
    // If it already carries a scheme, parse it; otherwise parse it AS a host by
    // giving it one.
    let parsed = if raw.contains("://") {
        Url::parse(raw)
    } else {
        Url::parse(&format!("https://{raw}"))
    };
    let host = parsed
        .ok()
        .and_then(|u| u.host_str().map(str::to_string))
        .ok_or_else(|| AppError::BadRequest("that doesn't look like a website address".into()))?;
    // A real domain has a dot and no whitespace; reject obvious junk.
    if !host.contains('.') || host.contains(char::is_whitespace) {
        return Err(AppError::BadRequest(format!(
            "{host} doesn't look like a website address"
        )));
    }
    Ok(host)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scriptable_types_are_never_stored() {
        // The stored bytes come back same-origin from a navigable URL, so an SVG
        // (or an HTML file wearing an image mime) would be active content on the
        // app origin. Same rule `files::upload_disposition` keeps for uploads.
        assert!(!is_supported_image("image/svg+xml"));
        assert!(!is_supported_image("image/svg+xml; charset=utf-8"));
        assert!(!is_supported_image("text/html"));
        assert!(is_supported_image("image/png"));
        assert!(is_supported_image("image/jpeg; charset=binary"));
        assert!(is_supported_image("image/x-icon"));
    }

    #[test]
    fn domain_of_handles_urls_and_bare_domains() {
        assert_eq!(domain_of("acme.com").unwrap(), "acme.com");
        assert_eq!(domain_of("https://acme.com/pricing").unwrap(), "acme.com");
        assert_eq!(domain_of("http://www.acme.co.uk").unwrap(), "www.acme.co.uk");
        assert_eq!(domain_of("  example.org  ").unwrap(), "example.org");
    }

    #[test]
    fn domain_of_rejects_junk() {
        assert!(domain_of("").is_err());
        assert!(domain_of("not a domain").is_err());
        assert!(domain_of("localhost").is_err()); // no dot → not a public domain
    }

    #[test]
    fn supported_image_types() {
        assert!(is_supported_image("image/png"));
        assert!(is_supported_image("image/x-icon; charset=binary"));
        assert!(!is_supported_image("text/html"));
        assert!(!is_supported_image("application/json"));
    }
}
