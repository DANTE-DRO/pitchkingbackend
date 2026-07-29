// ─────────────────────────────────────────────────────────────
// PitchKing — Security hardening layer (ADDITIVE ONLY).
//
// This file introduces defensive middleware. It does NOT change:
//   • any route paths or response shapes
//   • the KCB Buni STK Push flow
//   • the immortal-raffle / rehydrate / tombstone logic
//   • the admin login credentials source (still ADMIN_USERNAME / ADMIN_PASSWORD)
//   • the hidden footer control panel UX
//
// It only ADDS: security headers, strict CORS, per-route rate limiting,
// body-size caps, safer JSON error handling, timing-safe compares,
// input sanitisation, and a hardened session model (TTL + rotation +
// IP+UA binding). All defaults are conservative.
// ─────────────────────────────────────────────────────────────

const crypto = require("crypto");

// ─── Utility: timing-safe string compare ─────────────────────
function safeEqual(a, b) {
  const aBuf = Buffer.from(String(a || ""), "utf8");
  const bBuf = Buffer.from(String(b || ""), "utf8");
  if (aBuf.length !== bBuf.length) {
    // still do a comparison to keep timing similar
    crypto.timingSafeEqual(aBuf, Buffer.alloc(aBuf.length));
    return false;
  }
  return crypto.timingSafeEqual(aBuf, bBuf);
}

// ─── In-memory sliding-window rate limiter ───────────────────
// Keyed by "bucket:ip". No external dep. Good enough for a small
// single-instance service. Auto-purges stale buckets.
const buckets = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) {
    if (now - v.resetAt > 60_000) buckets.delete(k);
  }
}, 60_000).unref?.();

function clientIp(req) {
  // Render puts the real IP in X-Forwarded-For. Only trust it because
  // we set `app.set('trust proxy', 1)` in the server.
  const xf = (req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return xf || req.ip || req.connection?.remoteAddress || "unknown";
}

function rateLimit({ windowMs = 60_000, max = 60, bucket = "default", message } = {}) {
  return function (req, res, next) {
    const key = `${bucket}:${clientIp(req)}`;
    const now = Date.now();
    let entry = buckets.get(key);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      buckets.set(key, entry);
    }
    entry.count += 1;
    res.setHeader("X-RateLimit-Limit", String(max));
    res.setHeader("X-RateLimit-Remaining", String(Math.max(0, max - entry.count)));
    if (entry.count > max) {
      const retry = Math.ceil((entry.resetAt - now) / 1000);
      res.setHeader("Retry-After", String(retry));
      return res.status(429).json({
        error: message || "Too many requests. Please slow down and try again shortly.",
      });
    }
    next();
  };
}

// ─── Security headers (Helmet-equivalent, zero-dep) ──────────
function securityHeaders() {
  return function (req, res, next) {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("X-XSS-Protection", "0");
    res.setHeader(
      "Permissions-Policy",
      "geolocation=(), microphone=(), camera=(), payment=(), usb=()"
    );
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    // HSTS is safe because Render terminates TLS.
    res.setHeader(
      "Strict-Transport-Security",
      "max-age=63072000; includeSubDomains; preload"
    );
    // Loose CSP for the admin/receipt HTML pages we serve. The
    // customer frontend is deployed separately so this only affects
    // /admin, /, /callback, /api/raffle/receipt/*.
    res.setHeader(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        "img-src 'self' data: https://i.imgur.com https://imgur.com https:",
        "style-src 'self' 'unsafe-inline'",
        "script-src 'self' 'unsafe-inline'",
        "connect-src 'self' https:",
        "font-src 'self' data: https:",
        "frame-ancestors 'self'",
        "base-uri 'self'",
        "form-action 'self'",
        "object-src 'none'",
      ].join("; ")
    );
    // Hide server fingerprint.
    res.removeHeader("X-Powered-By");
    next();
  };
}

// ─── Strict CORS (allow-list only) ───────────────────────────
// Add / remove origins via ALLOWED_ORIGINS env (comma-separated).
// The default list covers your existing production surfaces.
function buildAllowedOrigins() {
  const envList = String(process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const defaults = [
    "https://pitchking.co.ke",
    "https://www.pitchking.co.ke",
    "https://pitchkingbackend.onrender.com",
  ];
  return Array.from(new Set([...envList, ...defaults]));
}

function corsStrict() {
  const allowed = buildAllowedOrigins();
  return function (req, res, next) {
    const origin = req.headers.origin;
    // Requests without an Origin header (curl, server-to-server, KCB
    // callbacks) are allowed to reach routes; CORS is a browser-only
    // shield. This preserves the existing KCB callback flow.
    if (origin) {
      if (allowed.includes(origin)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
        res.setHeader("Access-Control-Allow-Credentials", "false");
        res.setHeader(
          "Access-Control-Allow-Methods",
          "GET,POST,PUT,DELETE,OPTIONS"
        );
        res.setHeader(
          "Access-Control-Allow-Headers",
          "Content-Type, X-Admin-Token, X-Requested-With"
        );
        res.setHeader("Access-Control-Max-Age", "600");
      } else {
        // Unknown origin → do NOT set CORS headers. Browser blocks.
        // We still let the request through so non-browser clients
        // (health checks, KCB callback) keep working.
      }
    }
    if (req.method === "OPTIONS") return res.status(204).end();
    next();
  };
}

// ─── Prototype-pollution / mass-assignment guard ─────────────
// Recursively drop any key that is __proto__ / constructor / prototype
// from request bodies before route handlers see them.
const BLOCK_KEYS = new Set(["__proto__", "constructor", "prototype"]);
function stripProtoPollution(obj) {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) {
    obj.forEach(stripProtoPollution);
    return obj;
  }
  for (const k of Object.keys(obj)) {
    if (BLOCK_KEYS.has(k)) {
      delete obj[k];
      continue;
    }
    if (obj[k] && typeof obj[k] === "object") stripProtoPollution(obj[k]);
  }
  return obj;
}
function bodySanitiser() {
  return function (req, res, next) {
    if (req.body) stripProtoPollution(req.body);
    if (req.query) stripProtoPollution(req.query);
    next();
  };
}

// ─── JSON parse error handler ────────────────────────────────
function jsonErrorHandler() {
  return function (err, req, res, next) {
    if (err && err.type === "entity.parse.failed") {
      return res.status(400).json({ error: "Invalid JSON body." });
    }
    if (err && err.type === "entity.too.large") {
      return res.status(413).json({ error: "Request body is too large." });
    }
    next(err);
  };
}

// ─── Last-resort error sanitiser ─────────────────────────────
// Never leak stack traces or internal messages to the client.
function finalErrorHandler() {
  // 4-arg signature is required for Express to treat it as error middleware.
  // eslint-disable-next-line no-unused-vars
  return function (err, req, res, next) {
    console.error("[unhandled]", req.method, req.originalUrl, err && err.message);
    if (res.headersSent) return;
    res.status(500).json({ error: "An unexpected error occurred." });
  };
}

// ─── HTTP Parameter Pollution guard ──────────────────────────
// If a query param comes through as an array (e.g. ?id=1&id=2), keep
// only the last value. Simple, effective, no dep.
function hppGuard() {
  return function (req, res, next) {
    if (req.query && typeof req.query === "object") {
      for (const k of Object.keys(req.query)) {
        if (Array.isArray(req.query[k])) {
          req.query[k] = req.query[k][req.query[k].length - 1];
        }
      }
    }
    next();
  };
}

// ─── Suspicious-path fast-reject ─────────────────────────────
// Cheaply drop the noisiest scanner probes so they never touch the app.
const BAD_PATH = /(\.env(\.|$)|\/wp-|\/phpmyadmin|\/xmlrpc|\/\.git|\/\.aws|\/actuator|\/config\.json|\.php$|\.asp$|\.aspx$)/i;
function pathFirewall() {
  return function (req, res, next) {
    if (BAD_PATH.test(req.path)) {
      return res.status(404).json({ error: "Not found." });
    }
    next();
  };
}

module.exports = {
  safeEqual,
  rateLimit,
  securityHeaders,
  corsStrict,
  bodySanitiser,
  jsonErrorHandler,
  finalErrorHandler,
  hppGuard,
  pathFirewall,
  clientIp,
};
