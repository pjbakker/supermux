//! The Cloudflare API seam.
//!
//! Every Cloudflare call the wizard makes goes through [`CfApi`] so token
//! validation, tunnel provisioning and status polling are unit/integration
//! testable WITHOUT a live token — [`MockCfApi`] drives valid / invalid /
//! missing-scope / idempotent-reuse cases deterministically. [`RealCfApi`] is the
//! `reqwest` implementation hitting `api.cloudflare.com`.
//!
//! The operator's chosen zone (their `base_domain`, e.g. `example.com`) is
//! fronted by ONE remote-managed `cfd_tunnel` (`config_src:"cloudflare"`) per box
//! — and by exactly as much DNS as the box actually uses: ONE proxied CNAME per
//! company host (`team.example.com → <tunnel>.cfargotunnel.com`) plus one ingress
//! rule per host and the `http_status:404` catch-all.
//!
//! It used to be a WILDCARD — `*.<base_domain>` ingress + a `*.<base_domain>`
//! CNAME — which made every undefined name under the operator's real domain
//! resolve to this box. That is far too much footprint to take on someone's zone
//! for a product that needs one or two hostnames, so the wildcard is gone: DNS is
//! now created per company host, and never touched unless it points at OUR
//! tunnel ([`CfApi::find_dns_cname`] before every write and every delete).
//!
//! The zone is discovered from the token via [`CfApi::list_zones`] and picked in
//! the wizard — nothing is hardcoded.

use async_trait::async_trait;

/// The canonical Cloudflare API base. `RealCfApi` allows an override purely so a
/// wiremock-style integration test can point it at a local server.
pub const CF_API_BASE: &str = "https://api.cloudflare.com/client/v4";

/// A structured Cloudflare error the handlers translate into a human message.
#[derive(Debug, thiserror::Error)]
pub enum CfError {
    /// Cloudflare rejected the token itself — wrong/truncated paste, revoked, or
    /// expired. NOT "the token lacks a permission" (that is [`CfError::MissingScope`]).
    #[error("Cloudflare rejected this API token. Check you pasted the whole token, and that it has not been revoked or expired.")]
    TokenInactive,
    /// The token is real but is not allowed to do what the wizard needs. The
    /// payload names the permission to add, in the words the Cloudflare token
    /// editor uses, so the message can be acted on without a support round-trip.
    #[error("This Cloudflare token is missing a permission: {0}")]
    MissingScope(String),
    /// The chosen base-domain zone was not visible to this token.
    #[error("zone '{0}' not found for this token")]
    ZoneNotFound(String),
    /// Any transport / decode / non-2xx failure.
    #[error("cloudflare api error: {0}")]
    Api(String),
}

/// A minted (or re-fetched) tunnel: its id and its connector run token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tunnel {
    pub id: String,
    /// The `cloudflared tunnel run --token …` value. Secret — 0600 on disk,
    /// referenced by the user unit's `EnvironmentFile`, never echoed to a client.
    pub token: String,
}

/// The verification state of a Cloudflare Email-Routing **destination** address
/// (the real mailbox forwarding lands in). Cloudflare only forwards to a
/// destination the owner has verified by clicking the link CF emails — so a fresh
/// destination is `verified:false` until they do.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct DestinationStatus {
    pub email: String,
    pub verified: bool,
}

/// The zone's Email-Routing enablement (`GET /zones/{z}/email/routing`). `enabled`
/// is true once the MX+SPF records are provisioned and routing is on.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct EmailRoutingStatus {
    pub enabled: bool,
}

/// One DNS zone the token can read: its Cloudflare id + apex name. `zone_name`
/// (e.g. `example.com`) is what the operator picks as their `base_domain`;
/// `zone_id` is re-derived at provision time via [`CfApi::zone_id`] for the DNS
/// write (so the non-secret store never has to carry it).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ZoneInfo {
    pub zone_id: String,
    pub zone_name: String,
}

/// One DNS record as Cloudflare reports it. `content` is what makes the
/// only-if-ours guard possible: a record whose content is not
/// `<our-tunnel-id>.cfargotunnel.com` belongs to the OPERATOR, and supermux must
/// never overwrite or delete it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct DnsRecord {
    pub id: String,
    pub name: String,
    pub content: String,
    pub proxied: bool,
}

/// The mockable Cloudflare surface.
#[async_trait]
pub trait CfApi: Send + Sync {
    /// The first account id this token can reach — and, by succeeding at all, the
    /// proof that the token WORKS.
    ///
    /// There is deliberately no separate `verify_token`. Cloudflare's
    /// `GET /user/tokens/verify` only understands USER tokens: an account-owned
    /// token (`cfat_…`, created under Manage Account → API Tokens) comes back
    /// from it as `1000 Invalid API Token` even when it is valid and correctly
    /// scoped, and account-owned tokens verify at
    /// `GET /accounts/{account_id}/tokens/verify` — an account id we do not have
    /// until we have listed accounts. So the token is proven by the call the
    /// wizard actually needs instead of by a second, kind-specific door.
    async fn account_id(&self, token: &str) -> Result<String, CfError>;
    /// `GET /zones` (paginated) — every zone this token can read. Proves Zone:Read
    /// by construction; `FORBIDDEN ⇒ MissingScope("Zone:Read")`. An empty vec ⇒
    /// the token controls no zones (surfaced to the wizard as "no domains found").
    /// The wizard maps `zone_name`s to the operator's base-domain choice.
    async fn list_zones(&self, token: &str) -> Result<Vec<ZoneInfo>, CfError>;
    /// `GET /zones?name=<zone>` — the zone id for `zone` (proves Zone:Read reach).
    async fn zone_id(&self, token: &str, zone: &str) -> Result<String, CfError>;
    /// `GET /accounts/{a}/cfd_tunnel?name=<name>&is_deleted=false` — an existing
    /// live tunnel with this name, if any (idempotency probe).
    async fn find_tunnel(
        &self,
        token: &str,
        account_id: &str,
        name: &str,
    ) -> Result<Option<Tunnel>, CfError>;
    /// `POST /accounts/{a}/cfd_tunnel {name,config_src:"cloudflare"}` — create the
    /// remote-managed tunnel; returns id + connector token.
    async fn create_tunnel(
        &self,
        token: &str,
        account_id: &str,
        name: &str,
    ) -> Result<Tunnel, CfError>;
    /// `GET /accounts/{a}/cfd_tunnel/{id}/token` — re-fetch the connector token for
    /// an already-existing tunnel (idempotent re-run).
    async fn tunnel_token(
        &self,
        token: &str,
        account_id: &str,
        tunnel_id: &str,
    ) -> Result<String, CfError>;
    /// `PUT /accounts/{a}/cfd_tunnel/{id}/configurations` — ONE ingress rule per
    /// hostname (in order) plus the `http_status:404` catch-all. The full set is
    /// always sent: cloudflared's remote config is a whole-document PUT, so
    /// "add a hostname" and "drop a hostname" are both this call with a different
    /// list. An EMPTY list is legal and means "this tunnel serves nothing yet".
    async fn put_tunnel_config(
        &self,
        token: &str,
        account_id: &str,
        tunnel_id: &str,
        ingress_hostnames: &[String],
        service: &str,
    ) -> Result<(), CfError>;
    /// `GET /zones/{z}/dns_records?type=CNAME&name=<name>` — the existing record
    /// for exactly this name, if any. Every write and every delete goes through
    /// here first: it is what tells "our tunnel's record" apart from a record the
    /// operator made themselves.
    async fn find_dns_cname(
        &self,
        token: &str,
        zone_id: &str,
        name: &str,
    ) -> Result<Option<DnsRecord>, CfError>;
    /// `POST /zones/{z}/dns_records` — ONE proxied CNAME
    /// `<host> → {tunnel_id}.cfargotunnel.com`. Idempotent (Cloudflare's
    /// "record already exists" is success); callers still probe with
    /// [`CfApi::find_dns_cname`] first so a FOREIGN record is refused rather than
    /// raced into.
    async fn create_dns_cname(
        &self,
        token: &str,
        zone_id: &str,
        name: &str,
        content: &str,
    ) -> Result<(), CfError>;
    /// `DELETE /zones/{z}/dns_records/{record_id}` — remove one record by id. The
    /// only-if-ours decision belongs to the CALLER (which is why this takes an id
    /// that could only have come from [`CfApi::find_dns_cname`]).
    async fn delete_dns_record(
        &self,
        token: &str,
        zone_id: &str,
        record_id: &str,
    ) -> Result<(), CfError>;
    /// `GET /accounts/{a}/cfd_tunnel/{id}` `status` — `inactive|degraded|healthy`
    /// (mapped by the caller to none/connecting/healthy).
    async fn tunnel_status(
        &self,
        token: &str,
        account_id: &str,
        tunnel_id: &str,
    ) -> Result<String, CfError>;

    // ── Email Routing (the agent-inbox surface) ────────────────────────────────
    //
    // These three writes need the token's **Email Routing Rules: Edit** scope (the
    // MX/SPF records enable writes reuse the existing DNS:Edit). A `FORBIDDEN` from
    // any of them surfaces as `MissingScope("Email Routing Rules:Edit")` so the
    // wizard can tell the operator to re-mint the token with that scope. Idempotent
    // by construction — re-running a provision is a no-op that returns live state.

    /// `POST /zones/{z}/email/routing/enable` — provision MX+SPF and turn routing
    /// on. Idempotent: an already-enabled zone is treated as success.
    async fn enable_email_routing(&self, token: &str, zone_id: &str) -> Result<(), CfError>;

    /// `POST /accounts/{a}/email/routing/addresses` — register a destination
    /// mailbox (Cloudflare emails it a verification link). Idempotent: an
    /// already-registered address returns its current verified state rather than
    /// erroring. Returns whether Cloudflare has seen the owner verify it.
    async fn add_destination_address(
        &self,
        token: &str,
        account_id: &str,
        email: &str,
    ) -> Result<DestinationStatus, CfError>;

    /// `POST /zones/{z}/email/routing/rules` — a `to:<agent@domain> → forward
    /// <destination>` rule. Idempotent by matcher: an existing rule for the same
    /// `to` address is reused (its `tag` returned) rather than duplicated.
    async fn create_routing_rule(
        &self,
        token: &str,
        zone_id: &str,
        name: &str,
        to_address: &str,
        forward_to: &str,
    ) -> Result<String, CfError>;

    /// `DELETE /zones/{z}/email/routing/rules/{tag}` — remove a rule by its tag.
    async fn delete_routing_rule(
        &self,
        token: &str,
        zone_id: &str,
        rule_tag: &str,
    ) -> Result<(), CfError>;

    /// `GET /zones/{z}/email/routing` — the zone's routing enablement, to reflect
    /// enabled/pending in status.
    async fn email_routing_status(
        &self,
        token: &str,
        zone_id: &str,
    ) -> Result<EmailRoutingStatus, CfError>;
}

/// Prove the token and reach an account (the account-scoped Tunnel:Edit reach).
/// Zone-FREE: the zone is not known at token-paste time — the operator picks
/// their `base_domain` from [`CfApi::list_zones`] afterwards, and provision
/// re-derives the DNS `zone_id` via [`CfApi::zone_id`]. Reused by `cf-token`
/// (save) and `status` (live re-verify).
pub async fn discover_account(api: &dyn CfApi, token: &str) -> Result<String, CfError> {
    api.account_id(token).await
}

// ── real reqwest implementation ──────────────────────────────────────────────

/// The live Cloudflare implementation. Each call is a bearer-authenticated JSON
/// request; a non-`success` envelope is surfaced as [`CfError::Api`].
pub struct RealCfApi {
    http: reqwest::Client,
    base: String,
}

impl Default for RealCfApi {
    fn default() -> Self {
        Self::new()
    }
}

impl RealCfApi {
    pub fn new() -> Self {
        Self {
            http: reqwest::Client::new(),
            base: CF_API_BASE.to_string(),
        }
    }

    /// Point at an alternate base (integration tests against a local mock server).
    pub fn with_base(base: impl Into<String>) -> Self {
        Self {
            http: reqwest::Client::new(),
            base: base.into(),
        }
    }

    fn req(&self, method: reqwest::Method, token: &str, path: &str) -> reqwest::RequestBuilder {
        self.http
            .request(method, format!("{}{}", self.base, path))
            .bearer_auth(token)
    }

    /// Ask Cloudflare the question we actually need answered — "which account can
    /// this token reach?" — and read the token's health off that answer.
    ///
    /// This replaced a `GET /user/tokens/verify` gate that rejected VALID tokens:
    /// that endpoint only understands USER tokens, so an account-owned token
    /// (`cfat_…`) came back `1000 Invalid API Token` and the wizard told the
    /// operator their working token "is not active". Account-owned tokens verify
    /// at `GET /accounts/{account_id}/tokens/verify`, which needs an account id we
    /// do not have yet — so the honest move is to stop asking a kind-specific
    /// question and let the call we need speak for itself.
    ///
    /// Two probes, because either permission alone is enough to name the account:
    ///   1. `GET /accounts` — the account list.
    ///   2. `GET /zones` — a zone payload carries its own `account.id`, so a token
    ///      scoped to zones still yields the account the tunnel calls need.
    /// A token Cloudflare itself refused short-circuits at step 1: retrying a
    /// refused token against another endpoint can only produce the same refusal.
    async fn probe_account(&self, token: &str) -> Result<String, CfError> {
        let first_err = match self.accounts_first_id(token).await {
            Ok(Some(id)) => return Ok(id),
            Ok(None) => CfError::MissingScope(ACCOUNT_SCOPE_HINT.to_string()),
            Err(CfError::TokenInactive) => return Err(CfError::TokenInactive),
            Err(e) => e,
        };
        match self.zones_first_account_id(token).await {
            Ok(Some(id)) => Ok(id),
            Ok(None) | Err(_) => Err(first_err),
        }
    }

    /// `GET /accounts?per_page=1` — the first account this token can see.
    /// `Ok(None)` = the call worked and the token can see NO account.
    async fn accounts_first_id(&self, token: &str) -> Result<Option<String>, CfError> {
        #[derive(serde::Deserialize)]
        struct Account {
            id: String,
        }
        let resp = self
            .req(reqwest::Method::GET, token, "/accounts?per_page=1")
            .send()
            .await
            .map_err(|e| CfError::Api(e.to_string()))?;
        let accounts: Vec<Account> = decode(resp, "accounts", ACCOUNT_SCOPE_HINT).await?;
        Ok(accounts.into_iter().next().map(|a| a.id))
    }

    /// `GET /zones?per_page=1` — the account that owns the first visible zone.
    async fn zones_first_account_id(&self, token: &str) -> Result<Option<String>, CfError> {
        #[derive(serde::Deserialize)]
        struct Owner {
            id: String,
        }
        #[derive(serde::Deserialize)]
        struct Zone {
            account: Owner,
        }
        let resp = self
            .req(reqwest::Method::GET, token, "/zones?per_page=1")
            .send()
            .await
            .map_err(|e| CfError::Api(e.to_string()))?;
        let zones: Vec<Zone> = decode(resp, "zones", ZONE_SCOPE_HINT).await?;
        Ok(zones.into_iter().next().map(|z| z.account.id))
    }
}

/// Minimal decode of the Cloudflare `{success, result, errors}` envelope.
///
/// The explicit `bound` keeps serde from adding a spurious `T: Default` bound
/// (which the field-level `#[serde(default)]` on `result` would otherwise
/// generate); `Option::<T>::default()` is `None` for any `T`, so no such bound is
/// actually needed at runtime.
#[derive(serde::Deserialize)]
#[serde(bound(deserialize = "T: serde::Deserialize<'de>"))]
struct CfEnvelope<T> {
    #[serde(default)]
    success: bool,
    #[serde(default)]
    result: Option<T>,
    #[serde(default)]
    errors: Vec<CfApiError>,
}

/// One `{code, message}` entry from a Cloudflare error envelope. Typed rather
/// than raw JSON because the CODE is what tells "this token is not a token we
/// can use" apart from "this token may not do that" — see [`is_bad_token_code`].
#[derive(serde::Deserialize, Debug)]
struct CfApiError {
    #[serde(default)]
    code: i64,
    #[serde(default)]
    message: String,
}

/// Cloudflare codes that mean THE TOKEN ITSELF was refused, as opposed to a real
/// token being told it may not do something:
///   * `1000` "Invalid API Token" — what `/user/tokens/verify` answers, including
///     for a perfectly valid ACCOUNT-OWNED (`cfat_…`) token.
///   * `9109` "Invalid access token" — what the account/zone endpoints answer for
///     a wrong, truncated, revoked or expired token (measured against the live
///     API with a junk token: `GET /accounts` → 403 + 9109).
fn is_bad_token_code(code: i64) -> bool {
    matches!(code, 1000 | 9109)
}

/// Render CF's error list into one human line ("Invalid access token (9109)").
fn render_errors(errors: &[CfApiError]) -> String {
    if errors.is_empty() {
        return "no error detail".to_string();
    }
    errors
        .iter()
        .map(|e| format!("{} ({})", e.message, e.code))
        .collect::<Vec<_>>()
        .join("; ")
}

impl<T> CfEnvelope<T> {
    fn into_result(self, ctx: &str) -> Result<T, CfError> {
        if self.success {
            self.result
                .ok_or_else(|| CfError::Api(format!("{ctx}: success with no result")))
        } else {
            Err(CfError::Api(format!(
                "{ctx}: {}",
                render_errors(&self.errors)
            )))
        }
    }
}

/// The permission each probe needs, spelled the way Cloudflare's token editor
/// spells it — these strings are shown to the operator verbatim.
const ACCOUNT_SCOPE_HINT: &str =
    "Account · Cloudflare Tunnel: Edit — this token cannot see any Cloudflare account";
const ZONE_SCOPE_HINT: &str = "Zone · Zone: Read — this token cannot see any of your domains";

/// Decode one Cloudflare response, telling the three failures apart HONESTLY:
/// a refused token (`TokenInactive`), a real token that may not make this call
/// (`MissingScope`), and anything else (`Api`, carrying CF's own words).
async fn decode<T: serde::de::DeserializeOwned>(
    resp: reqwest::Response,
    ctx: &str,
    scope_hint: &str,
) -> Result<T, CfError> {
    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| CfError::Api(format!("{ctx}: {e}")))?;
    let env: CfEnvelope<T> = match serde_json::from_str(&body) {
        Ok(v) => v,
        // A non-JSON body (an edge error page, a proxy) — report the status, and
        // never the body, which could echo the token back into a log.
        Err(e) => return Err(CfError::Api(format!("{ctx}: http {status} ({e})"))),
    };
    if env.success {
        return env
            .result
            .ok_or_else(|| CfError::Api(format!("{ctx}: success with no result")));
    }
    if env.errors.iter().any(|e| is_bad_token_code(e.code)) {
        return Err(CfError::TokenInactive);
    }
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err(CfError::TokenInactive);
    }
    if status == reqwest::StatusCode::FORBIDDEN {
        return Err(CfError::MissingScope(scope_hint.to_string()));
    }
    Err(CfError::Api(format!("{ctx}: {}", render_errors(&env.errors))))
}

#[async_trait]
impl CfApi for RealCfApi {
    async fn account_id(&self, token: &str) -> Result<String, CfError> {
        self.probe_account(token).await
    }

    async fn list_zones(&self, token: &str) -> Result<Vec<ZoneInfo>, CfError> {
        #[derive(serde::Deserialize)]
        struct Zone {
            id: String,
            name: String,
        }
        const PER_PAGE: usize = 50;
        let mut out: Vec<ZoneInfo> = Vec::new();
        let mut page = 1usize;
        loop {
            let resp = self
                .req(
                    reqwest::Method::GET,
                    token,
                    &format!("/zones?per_page={PER_PAGE}&page={page}"),
                )
                .send()
                .await
                .map_err(|e| CfError::Api(e.to_string()))?;
            if resp.status() == reqwest::StatusCode::FORBIDDEN {
                return Err(CfError::MissingScope("Zone:Read".into()));
            }
            let env: CfEnvelope<Vec<Zone>> =
                resp.json().await.map_err(|e| CfError::Api(e.to_string()))?;
            let zones = env.into_result("list_zones")?;
            let n = zones.len();
            out.extend(zones.into_iter().map(|z| ZoneInfo {
                zone_id: z.id,
                zone_name: z.name,
            }));
            // Stop when the last page returned fewer than a full page (or none).
            if n < PER_PAGE {
                break;
            }
            page += 1;
        }
        Ok(out)
    }

    async fn zone_id(&self, token: &str, zone: &str) -> Result<String, CfError> {
        #[derive(serde::Deserialize)]
        struct Zone {
            id: String,
        }
        let resp = self
            .req(
                reqwest::Method::GET,
                token,
                &format!("/zones?name={zone}"),
            )
            .send()
            .await
            .map_err(|e| CfError::Api(e.to_string()))?;
        if resp.status() == reqwest::StatusCode::FORBIDDEN {
            return Err(CfError::MissingScope("Zone:Read".into()));
        }
        let env: CfEnvelope<Vec<Zone>> =
            resp.json().await.map_err(|e| CfError::Api(e.to_string()))?;
        let zones = env.into_result("zones")?;
        zones
            .into_iter()
            .next()
            .map(|z| z.id)
            .ok_or_else(|| CfError::ZoneNotFound(zone.to_string()))
    }

    async fn find_tunnel(
        &self,
        token: &str,
        account_id: &str,
        name: &str,
    ) -> Result<Option<Tunnel>, CfError> {
        #[derive(serde::Deserialize)]
        struct T {
            id: String,
        }
        let resp = self
            .req(
                reqwest::Method::GET,
                token,
                &format!("/accounts/{account_id}/cfd_tunnel?name={name}&is_deleted=false"),
            )
            .send()
            .await
            .map_err(|e| CfError::Api(e.to_string()))?;
        let env: CfEnvelope<Vec<T>> =
            resp.json().await.map_err(|e| CfError::Api(e.to_string()))?;
        let tunnels = env.into_result("find_tunnel")?;
        match tunnels.into_iter().next() {
            Some(t) => {
                let token_val = self.tunnel_token(token, account_id, &t.id).await?;
                Ok(Some(Tunnel {
                    id: t.id,
                    token: token_val,
                }))
            }
            None => Ok(None),
        }
    }

    async fn create_tunnel(
        &self,
        token: &str,
        account_id: &str,
        name: &str,
    ) -> Result<Tunnel, CfError> {
        #[derive(serde::Deserialize)]
        struct Created {
            id: String,
            token: String,
        }
        let resp = self
            .req(
                reqwest::Method::POST,
                token,
                &format!("/accounts/{account_id}/cfd_tunnel"),
            )
            .json(&serde_json::json!({ "name": name, "config_src": "cloudflare" }))
            .send()
            .await
            .map_err(|e| CfError::Api(e.to_string()))?;
        let env: CfEnvelope<Created> =
            resp.json().await.map_err(|e| CfError::Api(e.to_string()))?;
        let c = env.into_result("create_tunnel")?;
        Ok(Tunnel {
            id: c.id,
            token: c.token,
        })
    }

    async fn tunnel_token(
        &self,
        token: &str,
        account_id: &str,
        tunnel_id: &str,
    ) -> Result<String, CfError> {
        let resp = self
            .req(
                reqwest::Method::GET,
                token,
                &format!("/accounts/{account_id}/cfd_tunnel/{tunnel_id}/token"),
            )
            .send()
            .await
            .map_err(|e| CfError::Api(e.to_string()))?;
        let env: CfEnvelope<String> =
            resp.json().await.map_err(|e| CfError::Api(e.to_string()))?;
        env.into_result("tunnel_token")
    }

    async fn put_tunnel_config(
        &self,
        token: &str,
        account_id: &str,
        tunnel_id: &str,
        ingress_hostnames: &[String],
        service: &str,
    ) -> Result<(), CfError> {
        // One rule per hostname, in the order given, then the catch-all — the
        // whole document, because that is the only shape this endpoint takes.
        let mut ingress: Vec<serde_json::Value> = ingress_hostnames
            .iter()
            .map(|h| serde_json::json!({ "hostname": h, "service": service }))
            .collect();
        ingress.push(serde_json::json!({ "service": "http_status:404" }));
        let body = serde_json::json!({ "config": { "ingress": ingress } });
        let resp = self
            .req(
                reqwest::Method::PUT,
                token,
                &format!("/accounts/{account_id}/cfd_tunnel/{tunnel_id}/configurations"),
            )
            .json(&body)
            .send()
            .await
            .map_err(|e| CfError::Api(e.to_string()))?;
        let env: CfEnvelope<serde_json::Value> =
            resp.json().await.map_err(|e| CfError::Api(e.to_string()))?;
        env.into_result("put_tunnel_config").map(|_| ())
    }

    async fn find_dns_cname(
        &self,
        token: &str,
        zone_id: &str,
        name: &str,
    ) -> Result<Option<DnsRecord>, CfError> {
        #[derive(serde::Deserialize)]
        struct R {
            #[serde(default)]
            id: String,
            #[serde(default)]
            name: String,
            #[serde(default)]
            content: String,
            #[serde(default)]
            proxied: bool,
        }
        let resp = self
            .req(
                reqwest::Method::GET,
                token,
                &format!("/zones/{zone_id}/dns_records?type=CNAME&name={name}"),
            )
            .send()
            .await
            .map_err(|e| CfError::Api(e.to_string()))?;
        if resp.status() == reqwest::StatusCode::FORBIDDEN {
            return Err(CfError::MissingScope("Zone:DNS:Edit".into()));
        }
        let env: CfEnvelope<Vec<R>> =
            resp.json().await.map_err(|e| CfError::Api(e.to_string()))?;
        let rows = env.into_result("find_dns_cname")?;
        Ok(rows.into_iter().next().map(|r| DnsRecord {
            id: r.id,
            name: r.name,
            content: r.content,
            proxied: r.proxied,
        }))
    }

    async fn delete_dns_record(
        &self,
        token: &str,
        zone_id: &str,
        record_id: &str,
    ) -> Result<(), CfError> {
        let resp = self
            .req(
                reqwest::Method::DELETE,
                token,
                &format!("/zones/{zone_id}/dns_records/{record_id}"),
            )
            .send()
            .await
            .map_err(|e| CfError::Api(e.to_string()))?;
        // An already-deleted record (404) is the state we wanted — success.
        if resp.status().is_success() || resp.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(());
        }
        let status = resp.status();
        let env: CfEnvelope<serde_json::Value> = resp
            .json()
            .await
            .map_err(|e| CfError::Api(format!("{status}: {e}")))?;
        env.into_result("delete_dns_record").map(|_| ())
    }

    async fn create_dns_cname(
        &self,
        token: &str,
        zone_id: &str,
        name: &str,
        content: &str,
    ) -> Result<(), CfError> {
        let body = serde_json::json!({
            "type": "CNAME",
            "name": name,
            "content": content,
            "proxied": true
        });
        let resp = self
            .req(
                reqwest::Method::POST,
                token,
                &format!("/zones/{zone_id}/dns_records"),
            )
            .json(&body)
            .send()
            .await
            .map_err(|e| CfError::Api(e.to_string()))?;
        // A pre-existing identical record returns 400/409; treat that as success
        // (idempotent). Anything else with a non-success envelope is a real error.
        if resp.status().is_success() {
            return Ok(());
        }
        let status = resp.status();
        let env: CfEnvelope<serde_json::Value> = resp
            .json()
            .await
            .map_err(|e| CfError::Api(format!("{status}: {e}")))?;
        // 81057 = "record already exists".
        let already = env
            .errors
            .iter()
            .any(|e| e.code == 81057);
        if already {
            Ok(())
        } else {
            env.into_result("create_dns_cname").map(|_| ())
        }
    }

    async fn tunnel_status(
        &self,
        token: &str,
        account_id: &str,
        tunnel_id: &str,
    ) -> Result<String, CfError> {
        #[derive(serde::Deserialize)]
        struct T {
            #[serde(default)]
            status: String,
        }
        let resp = self
            .req(
                reqwest::Method::GET,
                token,
                &format!("/accounts/{account_id}/cfd_tunnel/{tunnel_id}"),
            )
            .send()
            .await
            .map_err(|e| CfError::Api(e.to_string()))?;
        let env: CfEnvelope<T> = resp.json().await.map_err(|e| CfError::Api(e.to_string()))?;
        Ok(env.into_result("tunnel_status")?.status)
    }

    async fn enable_email_routing(&self, token: &str, zone_id: &str) -> Result<(), CfError> {
        let resp = self
            .req(
                reqwest::Method::POST,
                token,
                &format!("/zones/{zone_id}/email/routing/enable"),
            )
            .json(&serde_json::json!({}))
            .send()
            .await
            .map_err(|e| CfError::Api(e.to_string()))?;
        if resp.status() == reqwest::StatusCode::FORBIDDEN {
            return Err(CfError::MissingScope("Email Routing Rules:Edit".into()));
        }
        if resp.status().is_success() {
            return Ok(());
        }
        // Non-2xx: routing is very likely already enabled (a re-provision). Confirm
        // idempotently rather than surfacing an error.
        let already = self
            .email_routing_status(token, zone_id)
            .await
            .map(|s| s.enabled)
            .unwrap_or(false);
        if already {
            Ok(())
        } else {
            let status = resp.status();
            let env: CfEnvelope<serde_json::Value> = resp
                .json()
                .await
                .map_err(|e| CfError::Api(format!("{status}: {e}")))?;
            env.into_result("enable_email_routing").map(|_| ())
        }
    }

    async fn add_destination_address(
        &self,
        token: &str,
        account_id: &str,
        email: &str,
    ) -> Result<DestinationStatus, CfError> {
        // A destination address carries a `verified` timestamp (null until the
        // owner clicks Cloudflare's verification link).
        #[derive(serde::Deserialize)]
        struct Addr {
            #[serde(default)]
            email: String,
            #[serde(default)]
            verified: Option<serde_json::Value>,
        }
        let resp = self
            .req(
                reqwest::Method::POST,
                token,
                &format!("/accounts/{account_id}/email/routing/addresses"),
            )
            .json(&serde_json::json!({ "email": email }))
            .send()
            .await
            .map_err(|e| CfError::Api(e.to_string()))?;
        if resp.status() == reqwest::StatusCode::FORBIDDEN {
            return Err(CfError::MissingScope("Email Routing Rules:Edit".into()));
        }
        if resp.status().is_success() {
            let env: CfEnvelope<Addr> =
                resp.json().await.map_err(|e| CfError::Api(e.to_string()))?;
            let a = env.into_result("add_destination_address")?;
            return Ok(DestinationStatus {
                email: if a.email.is_empty() { email.to_string() } else { a.email },
                verified: a.verified.map(|v| !v.is_null()).unwrap_or(false),
            });
        }
        // Already registered (idempotent): re-fetch the list and read its state.
        #[derive(serde::Deserialize)]
        struct AddrRow {
            #[serde(default)]
            email: String,
            #[serde(default)]
            verified: Option<serde_json::Value>,
        }
        let list = self
            .req(
                reqwest::Method::GET,
                token,
                &format!("/accounts/{account_id}/email/routing/addresses?per_page=50"),
            )
            .send()
            .await
            .map_err(|e| CfError::Api(e.to_string()))?;
        let env: CfEnvelope<Vec<AddrRow>> =
            list.json().await.map_err(|e| CfError::Api(e.to_string()))?;
        let rows = env.into_result("list_destination_addresses")?;
        let found = rows
            .into_iter()
            .find(|r| r.email.eq_ignore_ascii_case(email));
        Ok(DestinationStatus {
            email: email.to_string(),
            verified: found
                .and_then(|r| r.verified)
                .map(|v| !v.is_null())
                .unwrap_or(false),
        })
    }

    async fn create_routing_rule(
        &self,
        token: &str,
        zone_id: &str,
        name: &str,
        to_address: &str,
        forward_to: &str,
    ) -> Result<String, CfError> {
        #[derive(serde::Deserialize)]
        struct Rule {
            #[serde(default)]
            tag: String,
            #[serde(default)]
            matchers: Vec<Matcher>,
        }
        #[derive(serde::Deserialize)]
        struct Matcher {
            #[serde(default)]
            field: String,
            #[serde(default)]
            value: String,
        }
        // Idempotent by matcher: reuse an existing `to:<address>` rule if present.
        let list = self
            .req(
                reqwest::Method::GET,
                token,
                &format!("/zones/{zone_id}/email/routing/rules?per_page=50"),
            )
            .send()
            .await
            .map_err(|e| CfError::Api(e.to_string()))?;
        if list.status() == reqwest::StatusCode::FORBIDDEN {
            return Err(CfError::MissingScope("Email Routing Rules:Edit".into()));
        }
        if list.status().is_success() {
            let env: CfEnvelope<Vec<Rule>> =
                list.json().await.map_err(|e| CfError::Api(e.to_string()))?;
            if let Ok(rules) = env.into_result("list_routing_rules") {
                if let Some(existing) = rules.into_iter().find(|r| {
                    r.matchers.iter().any(|m| {
                        m.field == "to" && m.value.eq_ignore_ascii_case(to_address)
                    })
                }) {
                    if !existing.tag.is_empty() {
                        return Ok(existing.tag);
                    }
                }
            }
        }
        // None yet — create it.
        let body = serde_json::json!({
            "name": name,
            "enabled": true,
            "matchers": [{ "type": "literal", "field": "to", "value": to_address }],
            "actions": [{ "type": "forward", "value": [forward_to] }],
        });
        let resp = self
            .req(
                reqwest::Method::POST,
                token,
                &format!("/zones/{zone_id}/email/routing/rules"),
            )
            .json(&body)
            .send()
            .await
            .map_err(|e| CfError::Api(e.to_string()))?;
        if resp.status() == reqwest::StatusCode::FORBIDDEN {
            return Err(CfError::MissingScope("Email Routing Rules:Edit".into()));
        }
        let env: CfEnvelope<Rule> =
            resp.json().await.map_err(|e| CfError::Api(e.to_string()))?;
        Ok(env.into_result("create_routing_rule")?.tag)
    }

    async fn delete_routing_rule(
        &self,
        token: &str,
        zone_id: &str,
        rule_tag: &str,
    ) -> Result<(), CfError> {
        let resp = self
            .req(
                reqwest::Method::DELETE,
                token,
                &format!("/zones/{zone_id}/email/routing/rules/{rule_tag}"),
            )
            .send()
            .await
            .map_err(|e| CfError::Api(e.to_string()))?;
        // A 404 (rule already gone) is a benign no-op for a delete.
        if resp.status().is_success() || resp.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(());
        }
        let status = resp.status();
        let env: CfEnvelope<serde_json::Value> = resp
            .json()
            .await
            .map_err(|e| CfError::Api(format!("{status}: {e}")))?;
        env.into_result("delete_routing_rule").map(|_| ())
    }

    async fn email_routing_status(
        &self,
        token: &str,
        zone_id: &str,
    ) -> Result<EmailRoutingStatus, CfError> {
        #[derive(serde::Deserialize)]
        struct Routing {
            #[serde(default)]
            enabled: bool,
        }
        let resp = self
            .req(
                reqwest::Method::GET,
                token,
                &format!("/zones/{zone_id}/email/routing"),
            )
            .send()
            .await
            .map_err(|e| CfError::Api(e.to_string()))?;
        if resp.status() == reqwest::StatusCode::FORBIDDEN {
            return Err(CfError::MissingScope("Email Routing Rules:Edit".into()));
        }
        let env: CfEnvelope<Routing> =
            resp.json().await.map_err(|e| CfError::Api(e.to_string()))?;
        Ok(EmailRoutingStatus {
            enabled: env.into_result("email_routing_status")?.enabled,
        })
    }
}

// ── test double ──────────────────────────────────────────────────────────────

/// A deterministic mock driving every provisioning branch without a live token.
///
/// Configure the failure modes via the public flags; the create/find calls are
/// counted so an idempotency test can assert "created exactly once".
#[cfg(test)]
pub struct MockCfApi {
    pub valid_token: String,
    pub scopes_ok: bool,
    pub zone_present: bool,
    pub account_id: String,
    pub zone_id: String,
    /// The zones the token "controls". Default is a single `example.com` so the
    /// wizard's single-zone auto-select+confirm path is exercised; a multi-zone
    /// test sets two. `list_zones` returns `MissingScope` when `scopes_ok=false`.
    pub zones: Vec<ZoneInfo>,
    /// The tunnel state, shared so `provision-tunnel` re-runs observe the prior
    /// create (idempotency).
    pub existing_tunnel: std::sync::Mutex<Option<Tunnel>>,
    pub create_calls: std::sync::atomic::AtomicUsize,
    /// The status `tunnel_status` reports.
    pub status: std::sync::Mutex<String>,
    // ── Email Routing knobs (agent-inbox) ──
    /// When false, the routing writes return `MissingScope` (the token lacks the
    /// Email Routing Rules:Edit scope) — drives the missing-scope test.
    pub email_scope_ok: bool,
    /// The verified state `add_destination_address` reports (default false so the
    /// happy-path test sees the honest pending state a fresh destination has).
    pub destination_verified: bool,
    /// Zone routing enablement, shared so a re-provision observes the enable.
    pub routing_enabled: std::sync::Mutex<bool>,
    /// Counts `create_routing_rule` bodies actually POSTed (idempotency assert).
    pub rule_create_calls: std::sync::atomic::AtomicUsize,
    /// The single routing rule this mock "holds" (its tag), shared so a re-run
    /// reuses it and a delete clears it.
    pub existing_rule: std::sync::Mutex<Option<String>>,
    // ── DNS (the per-host records that replaced the wildcard) ──
    /// The zone's CNAME records, keyed by name. A test seeds a FOREIGN record
    /// (content pointing anywhere but our tunnel) to prove supermux refuses to
    /// clobber it, or a legacy `*.<base>` record to drive the tighten path.
    pub dns: std::sync::Mutex<Vec<DnsRecord>>,
    /// Every `create_dns_cname` name, in order — so a test can assert exactly
    /// which records provisioning did (and did not) create.
    pub dns_created: std::sync::Mutex<Vec<String>>,
    /// Every `delete_dns_record` id, in order.
    pub dns_deleted: std::sync::Mutex<Vec<String>>,
    /// The hostname list of the LAST `put_tunnel_config` — the ingress document
    /// as cloudflared would have received it.
    pub ingress: std::sync::Mutex<Vec<String>>,
}

#[cfg(test)]
impl Default for MockCfApi {
    fn default() -> Self {
        Self {
            valid_token: "valid-cf-token".to_string(),
            scopes_ok: true,
            zone_present: true,
            account_id: "acct-123".to_string(),
            zone_id: "zone-abc".to_string(),
            zones: vec![ZoneInfo {
                zone_id: "zone-abc".to_string(),
                zone_name: "example.com".to_string(),
            }],
            existing_tunnel: std::sync::Mutex::new(None),
            create_calls: std::sync::atomic::AtomicUsize::new(0),
            status: std::sync::Mutex::new("healthy".to_string()),
            email_scope_ok: true,
            destination_verified: false,
            routing_enabled: std::sync::Mutex::new(false),
            rule_create_calls: std::sync::atomic::AtomicUsize::new(0),
            existing_rule: std::sync::Mutex::new(None),
            dns: std::sync::Mutex::new(Vec::new()),
            dns_created: std::sync::Mutex::new(Vec::new()),
            dns_deleted: std::sync::Mutex::new(Vec::new()),
            ingress: std::sync::Mutex::new(Vec::new()),
        }
    }
}

#[cfg(test)]
impl MockCfApi {
    pub fn create_count(&self) -> usize {
        self.create_calls.load(std::sync::atomic::Ordering::SeqCst)
    }
    pub fn rule_create_count(&self) -> usize {
        self.rule_create_calls
            .load(std::sync::atomic::Ordering::SeqCst)
    }
    /// Seed a record the OPERATOR owns (or a legacy wildcard, by passing our own
    /// tunnel target as `content`).
    pub fn seed_dns(&self, name: &str, content: &str) {
        self.dns.lock().unwrap().push(DnsRecord {
            id: format!("rec-{}", name.replace(['.', '*'], "-")),
            name: name.to_string(),
            content: content.to_string(),
            proxied: true,
        });
    }
    /// The record names this zone currently holds.
    pub fn dns_names(&self) -> Vec<String> {
        self.dns.lock().unwrap().iter().map(|r| r.name.clone()).collect()
    }
    /// The hostnames of the last ingress document written.
    pub fn ingress_hosts(&self) -> Vec<String> {
        self.ingress.lock().unwrap().clone()
    }
    pub fn created_names(&self) -> Vec<String> {
        self.dns_created.lock().unwrap().clone()
    }
}

#[cfg(test)]
#[async_trait]
impl CfApi for MockCfApi {
    /// The single token gate, mirroring the real client: reaching an account IS
    /// the proof the token works, so a wrong token fails HERE and not at a
    /// separate verify door.
    async fn account_id(&self, token: &str) -> Result<String, CfError> {
        if token != self.valid_token {
            return Err(CfError::TokenInactive);
        }
        if !self.scopes_ok {
            return Err(CfError::MissingScope("Cloudflare Tunnel:Edit".into()));
        }
        Ok(self.account_id.clone())
    }

    async fn list_zones(&self, _token: &str) -> Result<Vec<ZoneInfo>, CfError> {
        if !self.scopes_ok {
            return Err(CfError::MissingScope("Zone:Read".into()));
        }
        Ok(self.zones.clone())
    }

    async fn zone_id(&self, _token: &str, zone: &str) -> Result<String, CfError> {
        if !self.scopes_ok {
            return Err(CfError::MissingScope("DNS:Edit / Zone:Read".into()));
        }
        if !self.zone_present {
            return Err(CfError::ZoneNotFound(zone.to_string()));
        }
        Ok(self.zone_id.clone())
    }

    async fn find_tunnel(
        &self,
        _token: &str,
        _account_id: &str,
        _name: &str,
    ) -> Result<Option<Tunnel>, CfError> {
        Ok(self.existing_tunnel.lock().unwrap().clone())
    }

    async fn create_tunnel(
        &self,
        _token: &str,
        _account_id: &str,
        _name: &str,
    ) -> Result<Tunnel, CfError> {
        self.create_calls
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let t = Tunnel {
            id: "tunnel-xyz".to_string(),
            token: "connector-token-secret".to_string(),
        };
        *self.existing_tunnel.lock().unwrap() = Some(t.clone());
        Ok(t)
    }

    async fn tunnel_token(
        &self,
        _token: &str,
        _account_id: &str,
        _tunnel_id: &str,
    ) -> Result<String, CfError> {
        Ok(self
            .existing_tunnel
            .lock()
            .unwrap()
            .as_ref()
            .map(|t| t.token.clone())
            .unwrap_or_else(|| "connector-token-secret".to_string()))
    }

    async fn put_tunnel_config(
        &self,
        _token: &str,
        _account_id: &str,
        _tunnel_id: &str,
        ingress_hostnames: &[String],
        _service: &str,
    ) -> Result<(), CfError> {
        *self.ingress.lock().unwrap() = ingress_hostnames.to_vec();
        Ok(())
    }

    async fn find_dns_cname(
        &self,
        _token: &str,
        _zone_id: &str,
        name: &str,
    ) -> Result<Option<DnsRecord>, CfError> {
        if !self.scopes_ok {
            return Err(CfError::MissingScope("Zone:DNS:Edit".into()));
        }
        Ok(self
            .dns
            .lock()
            .unwrap()
            .iter()
            .find(|r| r.name.eq_ignore_ascii_case(name))
            .cloned())
    }

    async fn create_dns_cname(
        &self,
        _token: &str,
        _zone_id: &str,
        name: &str,
        content: &str,
    ) -> Result<(), CfError> {
        if !self.scopes_ok {
            return Err(CfError::MissingScope("Zone:DNS:Edit".into()));
        }
        self.dns_created.lock().unwrap().push(name.to_string());
        let mut dns = self.dns.lock().unwrap();
        if !dns.iter().any(|r| r.name.eq_ignore_ascii_case(name)) {
            dns.push(DnsRecord {
                id: format!("rec-{}", name.replace(['.', '*'], "-")),
                name: name.to_string(),
                content: content.to_string(),
                proxied: true,
            });
        }
        Ok(())
    }

    async fn delete_dns_record(
        &self,
        _token: &str,
        _zone_id: &str,
        record_id: &str,
    ) -> Result<(), CfError> {
        self.dns_deleted.lock().unwrap().push(record_id.to_string());
        self.dns.lock().unwrap().retain(|r| r.id != record_id);
        Ok(())
    }

    async fn tunnel_status(
        &self,
        _token: &str,
        _account_id: &str,
        _tunnel_id: &str,
    ) -> Result<String, CfError> {
        Ok(self.status.lock().unwrap().clone())
    }

    async fn enable_email_routing(&self, _token: &str, _zone_id: &str) -> Result<(), CfError> {
        if !self.email_scope_ok {
            return Err(CfError::MissingScope("Email Routing Rules:Edit".into()));
        }
        *self.routing_enabled.lock().unwrap() = true;
        Ok(())
    }

    async fn add_destination_address(
        &self,
        _token: &str,
        _account_id: &str,
        email: &str,
    ) -> Result<DestinationStatus, CfError> {
        if !self.email_scope_ok {
            return Err(CfError::MissingScope("Email Routing Rules:Edit".into()));
        }
        Ok(DestinationStatus {
            email: email.to_string(),
            verified: self.destination_verified,
        })
    }

    async fn create_routing_rule(
        &self,
        _token: &str,
        _zone_id: &str,
        _name: &str,
        _to_address: &str,
        _forward_to: &str,
    ) -> Result<String, CfError> {
        if !self.email_scope_ok {
            return Err(CfError::MissingScope("Email Routing Rules:Edit".into()));
        }
        // Idempotent by matcher: reuse the held rule, only counting real creates.
        let mut held = self.existing_rule.lock().unwrap();
        if let Some(tag) = held.as_ref() {
            return Ok(tag.clone());
        }
        self.rule_create_calls
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let tag = "rule-tag-abc".to_string();
        *held = Some(tag.clone());
        Ok(tag)
    }

    async fn delete_routing_rule(
        &self,
        _token: &str,
        _zone_id: &str,
        _rule_tag: &str,
    ) -> Result<(), CfError> {
        *self.existing_rule.lock().unwrap() = None;
        Ok(())
    }

    async fn email_routing_status(
        &self,
        _token: &str,
        _zone_id: &str,
    ) -> Result<EmailRoutingStatus, CfError> {
        if !self.email_scope_ok {
            return Err(CfError::MissingScope("Email Routing Rules:Edit".into()));
        }
        Ok(EmailRoutingStatus {
            enabled: *self.routing_enabled.lock().unwrap(),
        })
    }
}

// ── the token probe, against a stubbed Cloudflare ────────────────────────────

#[cfg(test)]
mod real_probe_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    /// A loopback stand-in for `api.cloudflare.com` that answers by PATH.
    ///
    /// Hand-rolled (the repo's own idiom for a stub HTTP peer, see
    /// `tests/browser_service.rs`) so the test has no framework behaviour of its
    /// own to debug. `hits` counts requests, which is how "we did NOT retry a
    /// token Cloudflare already refused" is asserted.
    struct StubCf {
        base: String,
        hits: Arc<AtomicUsize>,
    }

    /// `routes`: `(path fragment, http status, json body)`, first match wins.
    async fn stub_cf(routes: Vec<(&'static str, u16, &'static str)>) -> StubCf {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind loopback");
        let addr = listener.local_addr().expect("local_addr");
        let hits = Arc::new(AtomicUsize::new(0));
        let hits_srv = hits.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    break;
                };
                let routes = routes.clone();
                let hits = hits_srv.clone();
                tokio::spawn(async move {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut buf = [0u8; 2048];
                    let n = sock.read(&mut buf).await.unwrap_or(0);
                    let head = String::from_utf8_lossy(&buf[..n]).to_string();
                    hits.fetch_add(1, Ordering::SeqCst);
                    let (status, body) = routes
                        .iter()
                        .find(|(frag, _, _)| head.contains(*frag))
                        .map(|(_, s, b)| (*s, *b))
                        .unwrap_or((404, r#"{"success":false,"errors":[]}"#));
                    let resp = format!(
                        "HTTP/1.1 {status} X\r\n\
                         Content-Type: application/json\r\n\
                         Content-Length: {}\r\n\
                         Connection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    let _ = sock.write_all(resp.as_bytes()).await;
                });
            }
        });
        StubCf {
            base: format!("http://{addr}/client/v4"),
            hits,
        }
    }

    const OK_ACCOUNTS: &str = r#"{"success":true,"errors":[],"result":[{"id":"acct-from-accounts"}]}"#;
    const NO_ACCOUNTS: &str = r#"{"success":true,"errors":[],"result":[]}"#;
    const OK_ZONES: &str =
        r#"{"success":true,"errors":[],"result":[{"id":"z1","name":"example.com","account":{"id":"acct-from-zone"}}]}"#;
    /// What the LIVE API answers a junk token on `/accounts` (measured).
    const BAD_TOKEN: &str =
        r#"{"success":false,"errors":[{"code":9109,"message":"Invalid access token"}],"result":null}"#;
    /// A real token that simply may not make this call.
    const NOT_PERMITTED: &str =
        r#"{"success":false,"errors":[{"code":10000,"message":"Authentication error"}],"result":null}"#;

    #[tokio::test]
    async fn a_working_token_yields_its_account() {
        let stub = stub_cf(vec![("/accounts", 200, OK_ACCOUNTS)]).await;
        let api = RealCfApi::with_base(stub.base.clone());
        assert_eq!(
            api.account_id("cfat_whatever").await.expect("ok"),
            "acct-from-accounts"
        );
    }

    /// THE BUG: an account-owned (`cfat_…`) token is refused by the user-only
    /// `/user/tokens/verify` and by `/accounts` when it is scoped to zones — but
    /// it can still name its account through the zone it CAN see. Before this
    /// change the wizard answered "cloudflare token is not active" here.
    #[tokio::test]
    async fn an_account_owned_token_is_proven_through_the_zone_it_can_see() {
        let stub = stub_cf(vec![
            ("/accounts", 403, NOT_PERMITTED),
            ("/zones", 200, OK_ZONES),
        ])
        .await;
        let api = RealCfApi::with_base(stub.base.clone());
        assert_eq!(
            api.account_id("cfat_account_owned").await.expect("ok"),
            "acct-from-zone"
        );
    }

    #[tokio::test]
    async fn a_token_cloudflare_refuses_is_reported_as_refused_and_not_retried() {
        let stub = stub_cf(vec![("/accounts", 403, BAD_TOKEN), ("/zones", 200, OK_ZONES)]).await;
        let api = RealCfApi::with_base(stub.base.clone());
        let err = api.account_id("junk").await.expect_err("refused");
        assert!(matches!(err, CfError::TokenInactive), "got {err:?}");
        // Exactly one call: a token Cloudflare already refused cannot become
        // valid by asking a different endpoint.
        assert_eq!(stub.hits.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_real_token_that_reaches_nothing_names_the_permission_to_add() {
        let stub = stub_cf(vec![
            ("/accounts", 200, NO_ACCOUNTS),
            ("/zones", 403, NOT_PERMITTED),
        ])
        .await;
        let api = RealCfApi::with_base(stub.base.clone());
        match api.account_id("real-but-unscoped").await {
            Err(CfError::MissingScope(s)) => {
                assert!(s.contains("Cloudflare Tunnel: Edit"), "hint was: {s}")
            }
            other => panic!("expected a missing-permission error, got {other:?}"),
        }
    }
}
