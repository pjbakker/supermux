/**
 * Anchor-first login-field detection — the ONE source of truth.
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * The heart of "smart" sign-in (spec §1). This runs INSIDE the remote page via
 * `Runtime.evaluate` — so the algorithm lives here as a plain JS body string
 * ({@link LOGIN_DETECT_BODY}) that references `document`/`window` as free names,
 * and the server embeds it verbatim as its `SCAN_LOGIN_JS` const. A "kept in
 * sync" test (`login-detect.test.ts`) reads the Rust source and asserts the two
 * are byte-identical, so the page never runs two different detectors.
 *
 * The same body is callable in a test DOM (jsdom) via {@link detectLogin}, which
 * wraps it in `new Function('document','window', …)` and hands it a document.
 * That is why every capability the body touches goes through the `window`
 * argument (`window.CSS`, `window.getComputedStyle`) — a bare `CSS` reference
 * would be a ReferenceError under `new Function`, and layout-less jsdom would
 * fail the rect gate, so the body probes for a layout engine and leans on
 * computed style when there is none. In real Chrome the probe passes and the
 * full `getClientRects` visibility filter applies exactly as spec §1.2 STEP 5
 * describes.
 *
 * Contract of the returned value (spec §1.1) — JSON-serialisable so
 * `returnByValue` works, and shaped so the server's `parse_login_fields` maps it
 * unchanged:
 *
 *   { form, reason, fields:[{selector,role,label,visible,source,rect}], otp,
 *     multiStep, frameHint, generateOnly? }
 */

/** One detected, offerable field. `source` records which signal won (spec §1.2
 *  STEP 3) purely for telemetry; the client ignores it. `rect` is the field's
 *  viewport box for Phase-4 canvas anchoring (zeros in a layout-less DOM). */
export interface LoginField {
  selector: string
  role: 'username' | 'password' | 'otp'
  label: string
  visible: boolean
  source: 'autocomplete' | 'type' | 'adjacency' | 'keyword'
  rect: { x: number; y: number; w: number; h: number }
}

/** What {@link detectLogin} / the injected body returns (spec §1.1). */
export interface LoginScan {
  form: boolean
  reason:
    | null
    | 'no-password-field'
    | 'all-hidden'
    | 'too-many-fields'
    | 'cross-origin-frame'
  fields: LoginField[]
  otp: null | { selector: string; label: string }
  multiStep: 'combined' | 'username-only' | 'password-only'
  frameHint: null | 'cross-origin-iframe'
  /** Spec §1.3(d): a signup/change page whose only password is `new-password` —
   *  nothing is fillable, so `fields` is empty but `form` stays true. */
  generateOnly?: boolean
}

/**
 * The detection body — the exact JS the remote page runs (spec §1.2, steps
 * 0–7 + the §1.3 offer-nothing rules + §1.4 stable selectors). References
 * `document` and `window` as free identifiers so it works both as the server's
 * `(() => { … })()` IIFE (page globals) and under `new Function('document',
 * 'window', BODY)` in a test DOM (arguments).
 *
 * Keep this a pure string with NO backticks and NO `"##` (it lives in a Rust
 * raw string `r##"…"##` too).
 */
export const LOGIN_DETECT_BODY: string = String.raw`
  var doc = document;
  var win = window;
  var MAX_PARSEABLE_FIELDS = 100; // spec §1.3(c) — mirror Chromium kMaxParseableFields
  var FIELD_CAP = 24; // never hand the socket an unbounded field list (§1.4)

  var cssEscape =
    win.CSS && typeof win.CSS.escape === 'function'
      ? function (s) { return win.CSS.escape(s); }
      : function (s) { return String(s).replace(/[^a-zA-Z0-9_-]/g, function (ch) { return '\\' + ch; }); };
  var gcs = function (el) { try { return win.getComputedStyle(el) || {}; } catch (e) { return {}; } };
  var norm = function (s) { return (s == null ? '' : String(s)).toLowerCase().replace(/[^a-z0-9]+/g, ''); };

  // Does this environment lay out the DOM? Real Chrome yes; layout-less jsdom no.
  // When it does NOT, the rect gate would drop every field, so we lean on
  // computed style alone (spec §1.2 STEP 5 stays the rule where layout exists).
  var hasLayout = (function () {
    try {
      var p = doc.createElement('div');
      p.style.cssText = 'position:absolute;width:12px;height:12px;left:-9999px;top:-9999px';
      (doc.body || doc.documentElement).appendChild(p);
      var ok = p.getClientRects().length > 0 || p.offsetWidth > 0 || p.offsetHeight > 0;
      p.parentNode && p.parentNode.removeChild(p);
      return ok;
    } catch (e) { return true; }
  })();

  var USER_KW = ['user', 'email', 'login', 'name', 'tel', 'phone', 'mobile', 'username', 'signin', 'loginid'];
  var PW_KW = ['password', 'passwort', 'kennwort', 'contrasena', 'senha', 'motdepasse', 'passe', 'adgangskode', 'haslo', 'wachtwoord', 'pin'];
  var OTP_KW = ['otp', 'onetime', 'onetimecode', 'verification', 'verificationcode', '2fa', 'twofactor', 'authcode', 'securitycode'];

  var typeOf = function (el) {
    return ((el.getAttribute && el.getAttribute('type')) || el.type || 'text').toLowerCase();
  };
  var isUsernameType = function (t) { return t === '' || t === 'text' || t === 'email' || t === 'tel'; };

  var acTokens = function (el) {
    var raw = (el.getAttribute && el.getAttribute('autocomplete')) || '';
    return String(raw).toLowerCase().split(/\s+/).filter(Boolean);
  };
  var acHas = function (el, token) { return acTokens(el).indexOf(token) >= 0; };

  var labelText = function (el) {
    var t = '';
    try { if (el.labels && el.labels.length) { for (var i = 0; i < el.labels.length; i++) t += ' ' + (el.labels[i].textContent || ''); } } catch (e) {}
    if (!t && el.id) { try { var l = doc.querySelector('label[for="' + cssEscape(el.id) + '"]'); if (l) t = l.textContent || ''; } catch (e2) {} }
    if (!t && el.closest) { try { var lc = el.closest('label'); if (lc) t = lc.textContent || ''; } catch (e3) {} }
    return (t || '').trim();
  };

  var fieldLabel = function (el) {
    return (
      (el.getAttribute && (el.getAttribute('aria-label') || '')) ||
      labelText(el) ||
      (el.getAttribute && (el.getAttribute('placeholder') || '')) ||
      (el.getAttribute && (el.getAttribute('name') || '')) ||
      el.id ||
      ''
    ).trim();
  };

  var haystack = function (el) {
    return [
      el.getAttribute && el.getAttribute('name'),
      el.id,
      el.getAttribute && el.getAttribute('placeholder'),
      el.getAttribute && el.getAttribute('aria-label'),
      labelText(el),
    ].map(norm).filter(Boolean);
  };
  var kwScore = function (hay, set) {
    var best = 0;
    for (var i = 0; i < hay.length; i++) {
      var h = hay[i];
      for (var j = 0; j < set.length; j++) {
        var kw = set[j];
        if (h === kw) best = Math.max(best, 3); // exact
        else if (h.indexOf(kw) === 0) best = Math.max(best, 2); // startsWith
        else if (h.indexOf(kw) >= 0) best = Math.max(best, 1); // contains
      }
    }
    return best;
  };
  // Keyword role — tie-breaker only (spec §1.2 STEP 3.4). Never consulted where a
  // higher signal already labelled the field.
  var keywordRole = function (el) {
    var hay = haystack(el);
    var p = kwScore(hay, PW_KW);
    var u = kwScore(hay, USER_KW);
    if (p > 0 && p >= u) return 'password';
    if (u > 0) return 'username';
    return null;
  };
  var keywordOtp = function (el) {
    var hay = haystack(el);
    if (kwScore(hay, OTP_KW) === 0) return false;
    var ml = parseInt((el.getAttribute && el.getAttribute('maxlength')) || '0', 10);
    var t = typeOf(el);
    var im = ((el.getAttribute && el.getAttribute('inputmode')) || '').toLowerCase();
    return t === 'number' || t === 'tel' || im === 'numeric' || (ml > 0 && ml <= 8);
  };

  var ignored = function (el) {
    try { return !!(el.closest && el.closest('[data-1p-ignore],[data-op-ignore]')); } catch (e) { return false; }
  };

  // spec §1.2 STEP 5 — interactability. In a layout-less DOM the rect clause is
  // skipped (see hasLayout); everywhere else it is the decisive signal.
  var viewable = function (el) {
    if (el.disabled) return false;
    if (typeOf(el) === 'hidden') return false;
    var st = gcs(el);
    if (st.display === 'none') return false;
    if (st.visibility === 'hidden' || st.visibility === 'collapse') return false;
    var op = parseFloat(st.opacity);
    if (!isNaN(op) && op <= 0.1) return false;
    if (hasLayout) {
      var rects;
      try { rects = el.getClientRects(); } catch (e) { rects = { length: 0 }; }
      if (!rects || rects.length === 0) {
        if ((el.offsetWidth || 0) <= 2 && (el.offsetHeight || 0) <= 2) return false;
      }
    }
    return true;
  };

  var rectOf = function (el) {
    try {
      var r = el.getBoundingClientRect();
      return { x: r.left || 0, y: r.top || 0, w: r.width || 0, h: r.height || 0 };
    } catch (e) { return { x: 0, y: 0, w: 0, h: 0 }; }
  };

  // spec §1.4 — a stable selector within one root: CSS.escape'd #id when unique,
  // else an :nth-of-type path up to the nearest id'd ancestor / root.
  var localSelector = function (el, root) {
    if (el.id) {
      var idSel = '#' + cssEscape(el.id);
      try { if (root.querySelectorAll(idSel).length === 1) return idSel; } catch (e) {}
    }
    var parts = [];
    var node = el;
    var guard = 0;
    while (node && node.nodeType === 1 && node !== root && guard++ < 40) {
      if (node.id) { parts.unshift('#' + cssEscape(node.id)); break; }
      var tag = node.tagName.toLowerCase();
      var i = 1;
      var sib = node;
      while ((sib = sib.previousElementSibling)) { if (sib.tagName === node.tagName) i++; }
      parts.unshift(tag + ':nth-of-type(' + i + ')');
      node = node.parentElement;
      if (node === root) break;
    }
    return parts.join(' > ');
  };

  // spec §1.2 STEP 0 — collect candidates, piercing open shadow roots and
  // same-origin iframes. A cross-origin boundary throws or returns null: caught,
  // recorded via frameHint, never fatal.
  var crossOrigin = false;
  var cands = []; // { el, prefix }
  var boundary = 0;
  var seenRoots = [];
  var collect = function (root, prefix, depth) {
    if (!root || depth > 6 || seenRoots.indexOf(root) >= 0) return;
    seenRoots.push(root);
    var inputs;
    try { inputs = root.querySelectorAll('input'); } catch (e) { return; }
    for (var i = 0; i < inputs.length; i++) cands.push({ el: inputs[i], prefix: prefix });
    var all;
    try { all = root.querySelectorAll('*'); } catch (e2) { all = []; }
    for (var j = 0; j < all.length; j++) {
      var node = all[j];
      if (node.shadowRoot) { boundary++; collect(node.shadowRoot, prefix + '__frame(' + boundary + ') > ', depth + 1); }
      var tag = node.tagName ? node.tagName.toLowerCase() : '';
      if (tag === 'iframe' || tag === 'frame') {
        var idoc = null;
        try { idoc = node.contentDocument; } catch (e3) { crossOrigin = true; continue; }
        if (idoc) {
          try { void idoc.body; } catch (e4) { crossOrigin = true; continue; }
          boundary++;
          collect(idoc, prefix + '__frame(' + boundary + ') > ', depth + 1);
        } else {
          var src = (node.getAttribute && node.getAttribute('src')) || '';
          if (src) {
            try {
              var base = doc.baseURI || (win.location && win.location.href) || undefined;
              var u = new URL(src, base);
              if (win.location && u.origin !== win.location.origin) crossOrigin = true;
            } catch (e5) {}
          }
        }
      }
    }
  };
  try { collect(doc, '', 0); } catch (e) {}

  var frameHint = crossOrigin ? 'cross-origin-iframe' : null;

  var offerNothing = function (reason) {
    return { form: false, reason: reason, fields: [], otp: null, multiStep: 'combined', frameHint: frameHint };
  };

  // spec §1.3(e) — a page-wide opt-out silences the whole page.
  try {
    var pageOptOut = (doc.body && (doc.body.hasAttribute('data-1p-ignore') || doc.body.hasAttribute('data-op-ignore'))) ||
      (doc.documentElement && (doc.documentElement.hasAttribute('data-1p-ignore') || doc.documentElement.hasAttribute('data-op-ignore')));
    if (pageOptOut) return offerNothing('no-password-field');
  } catch (e) {}

  // Per-field opt-out (spec §1.3(e)).
  cands = cands.filter(function (c) { return !ignored(c.el); });

  // spec §1.3(c) — too many candidates: bail rather than mis-parse.
  if (cands.length > MAX_PARSEABLE_FIELDS) return offerNothing('too-many-fields');

  // Enrich each candidate once.
  var fs = [];
  for (var k = 0; k < cands.length; k++) {
    var c = cands[k];
    var el = c.el;
    fs.push({
      el: el,
      prefix: c.prefix,
      type: typeOf(el),
      visible: viewable(el),
      selector: c.prefix + localSelector(el, c.prefix ? null : doc),
    });
  }
  // Selectors inside a boundary can't be re-resolved from the top document, so
  // give them a best-effort local path (root=null falls back to document-order
  // nth from the element's own parent chain — informational for now).
  for (var s = 0; s < fs.length; s++) {
    if (fs[s].prefix) {
      var el2 = fs[s].el;
      var loc = localSelector(el2, el2.getRootNode ? el2.getRootNode() : null);
      fs[s].selector = fs[s].prefix + loc;
    }
  }

  var byEl = function (el) { for (var i = 0; i < fs.length; i++) if (fs[i].el === el) return fs[i]; return null; };
  var fieldObj = function (f, role, source) {
    return { selector: f.selector, role: role, label: fieldLabel(f.el), visible: f.visible, source: source, rect: rectOf(f.el) };
  };

  var passwords = fs.filter(function (f) { return f.type === 'password'; });
  var visiblePasswords = passwords.filter(function (f) { return f.visible; });
  var anchor = visiblePasswords.length ? visiblePasswords[0] : null;

  // spec §1.2 STEP 7 — OTP, surfaced separately from fields.
  var otpSlot = null;
  for (var o = 0; o < fs.length; o++) {
    var of = fs[o];
    if (of.type === 'password') continue;
    if (!of.visible) continue;
    if (acHas(of.el, 'one-time-code') || keywordOtp(of.el)) {
      otpSlot = { selector: of.selector, label: fieldLabel(of.el) };
      break;
    }
  }

  // ── no password anchor ──────────────────────────────────────────────────
  if (!anchor) {
    if (passwords.length === 0) {
      // spec §1.2 STEP 6 — username-first multi-step.
      for (var u2 = 0; u2 < fs.length; u2++) {
        var uf = fs[u2];
        if (!isUsernameType(uf.type) || !uf.visible) continue;
        var byAc = acHas(uf.el, 'username') || acHas(uf.el, 'email');
        if (byAc || keywordRole(uf.el) === 'username') {
          return {
            form: true, reason: null,
            fields: [fieldObj(uf, 'username', byAc ? 'autocomplete' : 'keyword')],
            otp: otpSlot, multiStep: 'username-only', frameHint: frameHint,
          };
        }
      }
      if (crossOrigin) return offerNothing('cross-origin-frame');
      var anyUserEligible = fs.some(function (f) { return isUsernameType(f.type); });
      var anyUserVisible = fs.some(function (f) { return isUsernameType(f.type) && f.visible; });
      if (anyUserEligible && !anyUserVisible) return offerNothing('all-hidden');
      return offerNothing('no-password-field');
    }
    // Passwords exist but every one failed the visibility gate.
    if (crossOrigin) return offerNothing('cross-origin-frame');
    return offerNothing('all-hidden');
  }

  // ── password anchor present ─────────────────────────────────────────────
  // spec §1.2 STEP 4 — multi-password disambiguation (current vs new-password).
  // Only the current-password (or the sole password) is fillable.
  var pwKind = function () {
    var kind = []; // parallel to passwords
    var m = {};
    var anyCurrent = false;
    for (var i = 0; i < passwords.length; i++) {
      if (acHas(passwords[i].el, 'current-password')) { m[i] = 'current'; anyCurrent = true; }
      else if (acHas(passwords[i].el, 'new-password')) { m[i] = 'new'; }
    }
    var undecided = [];
    for (var q = 0; q < passwords.length; q++) if (m[q] == null) undecided.push(q);
    if (undecided.length) {
      if (passwords.length === 1) {
        m[undecided[0]] = 'current';
      } else {
        // Value heuristic: a value shared by >1 field is a new+confirm pair.
        for (var a = 0; a < undecided.length; a++) {
          var vi = passwords[undecided[a]].el.value || '';
          if (!vi) continue;
          var dup = 0;
          for (var b = 0; b < undecided.length; b++) if ((passwords[undecided[b]].el.value || '') === vi) dup++;
          if (dup > 1) m[undecided[a]] = 'new';
        }
        var leftover = [];
        for (var c2 = 0; c2 < undecided.length; c2++) if (m[undecided[c2]] == null) leftover.push(undecided[c2]);
        for (var d = 0; d < leftover.length; d++) {
          m[leftover[d]] = d === 0 && !anyCurrent ? 'current' : 'new';
        }
      }
    }
    for (var e2 = 0; e2 < passwords.length; e2++) kind[e2] = m[e2] || 'new';
    return kind;
  }();

  var currentPwIndex = -1;
  for (var pi = 0; pi < passwords.length; pi++) {
    if (pwKind[pi] === 'current' && passwords[pi].visible) { currentPwIndex = pi; break; }
  }

  // spec §1.3(d) — nothing fillable: a generate-only signup/change field.
  if (currentPwIndex < 0) {
    return { form: true, reason: null, fields: [], otp: otpSlot, multiStep: 'combined', frameHint: frameHint, generateOnly: true };
  }
  var currentPw = passwords[currentPwIndex];

  // spec §1.2 STEP 2/3 — resolve username. autocomplete first (authoritative,
  // even when hidden — the deliberate username carrier, spec §1.2 STEP 5
  // exception), then a backward walk, then a keyword tie-break.
  var username = null;
  var usernameSource = null;
  for (var au = 0; au < fs.length; au++) {
    var af = fs[au];
    if (af.type === 'password') continue;
    if (acHas(af.el, 'username') || acHas(af.el, 'email')) { username = af; usernameSource = 'autocomplete'; break; }
  }
  var anchorIdx = fs.indexOf(currentPw);
  if (!username) {
    var before = [];
    for (var w = 0; w < anchorIdx; w++) {
      var wf = fs[w];
      if (isUsernameType(wf.type) && wf.visible) before.push(wf);
    }
    var sameForm = before.filter(function (f) { try { return f.el.form && f.el.form === currentPw.el.form; } catch (e) { return false; } });
    var pool = sameForm.length ? sameForm : before;
    if (pool.length) {
      username = pool[pool.length - 1];
      usernameSource = username.type === 'email' ? 'type' : 'adjacency';
    }
  }
  if (!username) {
    for (var kw2 = anchorIdx - 1; kw2 >= 0; kw2--) {
      var kf = fs[kw2];
      if (isUsernameType(kf.type) && kf.visible && keywordRole(kf.el) === 'username') { username = kf; usernameSource = 'keyword'; break; }
    }
  }

  var out = [];
  if (username) {
    // Kept even when hidden IF it carries autocomplete=username (spec §1.2 STEP 5
    // exception); an otherwise-invisible username is dropped.
    var keepHidden = acHas(username.el, 'username') || acHas(username.el, 'email');
    if (username.visible || keepHidden) out.push(fieldObj(username, 'username', usernameSource || 'adjacency'));
  }
  var pwSource = acHas(currentPw.el, 'current-password') ? 'autocomplete' : 'type';
  out.push(fieldObj(currentPw, 'password', pwSource));
  out = out.slice(0, FIELD_CAP);

  var multiStep = username ? 'combined' : 'password-only';

  return { form: true, reason: null, fields: out, otp: otpSlot, multiStep: multiStep, frameHint: frameHint };
`

/**
 * The exact JS expression the server injects — `LOGIN_DETECT_BODY` wrapped in an
 * IIFE. The Rust `SCAN_LOGIN_JS` const MUST equal this byte-for-byte; the sync
 * test enforces it.
 */
export const SCAN_LOGIN_JS: string = '(() => {' + LOGIN_DETECT_BODY + '})()'

/**
 * Run the detection body over a DOM (jsdom in tests, or any real document).
 * Wraps {@link LOGIN_DETECT_BODY} in `new Function('document','window', …)` so
 * the same code the page runs is what the test exercises.
 */
export function detectLogin(document: Document, window?: Window & typeof globalThis): LoginScan {
  const win = window ?? (document.defaultView as Window & typeof globalThis)
  // eslint-disable-next-line no-new-func
  const fn = new Function('document', 'window', LOGIN_DETECT_BODY) as (
    d: Document,
    w: Window & typeof globalThis | null,
  ) => LoginScan
  return fn(document, win ?? null)
}
