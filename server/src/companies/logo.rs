//! Company logo: upload, serve, clear, and "grab the favicon from a URL".
//!
//! Storage is a BLOB on the `companies` row (small images; the upload path caps
//! the size), served back with its stored mime. The client samples the dominant
//! colour from the image and PATCHes it as the company `accent`, so no image
//! decoding happens server-side.
//!
//! `from_url` grabs a site's favicon via GOOGLE's free favicon service
//! (`www.google.com/s2/favicons`). We only ever fetch from that one fixed,
//! trusted host — the user's URL is reduced to a bare domain and handed to
//! Google as a query param — so there is no arbitrary-host outbound fetch and no
//! SSRF surface to guard.

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
fn is_supported_image(mime: &str) -> bool {
    matches!(
        mime.split(';').next().unwrap_or("").trim(),
        "image/png" | "image/jpeg" | "image/webp" | "image/gif" | "image/svg+xml" | "image/x-icon"
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
    let mime = mime.split(';').next().unwrap_or("").trim();
    if !is_supported_image(mime) {
        return Err(AppError::BadRequest(format!(
            "unsupported image type {mime:?} (png/jpeg/webp/gif/svg/ico only)"
        )));
    }
    if bytes.is_empty() {
        return Err(AppError::BadRequest("empty image".into()));
    }
    if bytes.len() > MAX_LOGO_BYTES {
        return Err(AppError::BadRequest(format!(
            "image too large ({} bytes; max {MAX_LOGO_BYTES})",
            bytes.len()
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
pub async fn get_handler(
    State(state): State<AppState>,
    Path(id): Path<i64>,
) -> Result<impl IntoResponse, AppError> {
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

/// `DELETE /api/companies/{id}/logo` — back to the generated mark. Also clears
/// the derived accent, since it was sampled from the logo we just removed.
pub async fn delete_handler(
    State(state): State<AppState>,
    ctx: crate::scope::OptCtx,
    Path(id): Path<i64>,
) -> Result<Json<Envelope<Company>>, AppError> {
    crate::scope::require_admin(ctx.0.as_ref(), &format!("/api/companies/{id}/logo"))?;
    companies::clear_logo(&state.pool, id).await?;
    companies::set_accent(&state.pool, id, None).await?;
    let row = companies::get(&state.pool, id)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("company id={id}")))?;
    Ok(ok(row))
}

#[derive(Deserialize)]
pub struct FromUrlInput {
    pub url: String,
}

/// `POST /api/companies/{id}/logo/from-url` — grab the site's favicon via
/// Google's free favicon service and store it. Admin-only.
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
    // clean URL-safe token — safe to interpolate into the query directly.
    let domain = domain_of(input.url.trim())?;
    // Google's favicon service — one fixed trusted host, `sz=128` for a crisp
    // mark. The domain is a query param, so this never fetches the user's host.
    let fav = format!("https://www.google.com/s2/favicons?sz=128&domain={domain}");
    let url = Url::parse(&fav).map_err(|e| AppError::Internal(anyhow::anyhow!(e)))?;

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .user_agent("supermux-favicon/1.0")
        .build()
        .map_err(|e| AppError::Internal(anyhow::anyhow!(e)))?;
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| AppError::BadRequest(format!("favicon fetch failed: {e}")))?;
    if !resp.status().is_success() {
        return Err(AppError::BadRequest(format!(
            "favicon service returned {}",
            resp.status()
        )));
    }
    let mime = resp
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/png")
        .to_string();
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| AppError::BadRequest(format!("favicon read failed: {e}")))?;
    if bytes.len() > MAX_LOGO_BYTES {
        return Err(AppError::BadRequest("favicon too large".into()));
    }
    store_logo(&state, id, &bytes, &mime).await
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
        .ok_or_else(|| AppError::BadRequest(format!("could not read a domain from {raw:?}")))?;
    // A real domain has a dot and no whitespace; reject obvious junk.
    if !host.contains('.') || host.contains(char::is_whitespace) {
        return Err(AppError::BadRequest(format!("{host:?} is not a domain")));
    }
    Ok(host)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn domain_of_handles_urls_and_bare_domains() {
        assert_eq!(domain_of("acme.com").unwrap(), "acme.com");
        assert_eq!(domain_of("https://acme.com/pricing").unwrap(), "acme.com");
        assert_eq!(domain_of("http://www.acme.co.uk").unwrap(), "www.acme.co.uk");
        assert_eq!(domain_of("  reisposter.nl  ").unwrap(), "reisposter.nl");
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
