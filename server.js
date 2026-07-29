// PitchKing backend — Express server (HARDENED).
//
// Behavioural contract is IDENTICAL to the previous version:
//   • Same route paths, same request/response shapes.
//   • Same admin credential bootstrap via ADMIN_USERNAME / ADMIN_PASSWORD.
//   • Same KCB Buni STK Push flow and callback URL layout.
//   • Same immortal-raffle rehydrate + tombstone endpoints.
//
// What this file changed (security only):
//   1. `trust proxy` set so rate-limits and audit logs see the real IP
//      behind Render's load balancer.
//   2. Strict CORS allow-list (env var ALLOWED_ORIGINS extends it).
//   3. Helmet-equivalent security headers on every response.
//   4. Path firewall + prototype-pollution + HPP guards run before routes.
//   5. Global light rate limit on /api/* plus tighter buckets on hot routes.
//   6. Body size caps: 256 KB for API, 512 KB for callback, 6 MB for image
//      uploads. Prevents memory-exhaustion posts.
//   7. Public rehydrate is throttled — same route, same idempotent behaviour,
//      just no longer floodable.
//   8. Static /admin and /uploads have hardened Cache-Control + Content-Type.
//   9. `uploads` folder never runs scripts (no directory listing, X-C-T-O nosniff).
//  10. Final error handler sanitises stack traces.

require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs");

const store = require("./lib/store");
const wallet = require("./lib/wallet");
const { ensureDefaultAdmin } = require("./lib/auth");
const {
  securityHeaders,
  corsStrict,
  bodySanitiser,
  jsonErrorHandler,
  finalErrorHandler,
  hppGuard,
  pathFirewall,
  rateLimit,
} = require("./lib/security");

// Make absolutely sure required folders exist BEFORE anything else runs.
["data", "uploads", "public", path.join("public", "admin")].forEach((d) => {
  const p = path.join(__dirname, d);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});

// Tighten perms on data/uploads if the platform allows it (best-effort).
try { fs.chmodSync(path.join(__dirname, "data"), 0o700); } catch (_) {}
try { fs.chmodSync(path.join(__dirname, "uploads"), 0o755); } catch (_) {}

store.init();
wallet.init();
ensureDefaultAdmin();

// Safety net: one unexpected error should never take the whole site down.
process.on("unhandledRejection", (err) => {
  console.error("[unhandledRejection]", err && err.message);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err && err.message);
});

const app = express();

// Behind Render's proxy — trust exactly one hop so req.ip / X-Forwarded-For
// resolve to the real client. Required for rate limiting to bucket per user.
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.set("etag", "strong");

// Order matters: firewall → headers → CORS → parsers → sanitisers → routes.
app.use(pathFirewall());
app.use(securityHeaders());
app.use(corsStrict());

// Handle preflight explicitly (corsStrict already answers OPTIONS 204, but
// this line keeps the intent visible).
app.options("*", corsStrict());

// Body parsing — smaller default than before (was 2mb → 256kb) to reduce
// abuse surface. Individual routes that need more raise their own limit.
app.use(express.json({ limit: "256kb" }));
app.use(express.urlencoded({ extended: false, limit: "64kb" }));

app.use(hppGuard());
app.use(bodySanitiser());
app.use(jsonErrorHandler());

// Global soft rate limit on the API surface (per IP).
app.use("/api", rateLimit({
  windowMs: 60_000,
  max: 300, // room for a busy customer session + admin refreshes
  bucket: "api-global",
}));

// Extra bucket on the public rehydrate — the immortal-raffle sync flow
// posts here from every visitor's browser on load. Same idempotent
// behaviour, just no longer a floodable insertion channel.
app.use("/api/accounts/rehydrate", rateLimit({
  windowMs: 60_000,
  max: 30,
  bucket: "rehydrate",
  message: "Too many raffle sync attempts. Please slow down.",
}));

// Payment-initiating routes get their own bucket so a single IP can't
// spam STK prompts to random phone numbers.
app.use("/api/raffle/buy", rateLimit({
  windowMs: 60_000, max: 8, bucket: "pay-raffle",
  message: "Please wait before making another payment attempt.",
}));
app.use("/api/raffle/join-tournament", rateLimit({
  windowMs: 60_000, max: 8, bucket: "pay-tournament",
  message: "Please wait before making another payment attempt.",
}));
app.use("/api/bets", rateLimit({
  windowMs: 60_000, max: 12, bucket: "pay-bets",
  message: "Please wait before making another challenge action.",
}));

// Uploaded raffle-account images — served read-only, no directory index,
// nosniff and long cache. Keeps the existing /uploads/<file> URL contract.
app.use(
  "/uploads",
  (req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "public, max-age=86400, immutable");
    // Block anything that isn't a plain filename (prevents traversal probes).
    if (/(\.\.|\/\.|%2e%2e)/i.test(req.path)) return res.status(404).end();
    next();
  },
  express.static(path.join(__dirname, "uploads"), {
    dotfiles: "deny",
    index: false,
    fallthrough: true,
    maxAge: "1d",
  })
);

// API routes
app.use("/api", require("./routes/accounts"));
app.use("/api", require("./routes/raffle"));
app.use("/api", require("./routes/bets"));
app.use("/api", require("./routes/challenges"));
app.use("/api", require("./routes/admin"));
app.use("/api", require("./routes/cp"));

// KCB Buni callback + polling + smoke test.
// Mounted at the root so KCB_CALLBACK_URL = https://<host>/callback works directly.
app.use("/", require("./routes/kcb"));

app.get("/api/health", (req, res) =>
  res.json({ ok: true, name: "PitchKing API", time: new Date().toISOString() })
);

// -------- Admin panel served publicly at /admin --------
// URL: https://pitchkingbackend.onrender.com/admin
const adminDir = path.join(__dirname, "public", "admin");
app.use(
  "/admin",
  (req, res, next) => {
    // Admin HTML shouldn't be cached by intermediaries.
    res.setHeader("Cache-Control", "no-store");
    next();
  },
  express.static(adminDir, { dotfiles: "deny", index: false })
);
app.get("/admin", (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(path.join(adminDir, "login.html"));
});

// Friendly root
app.get("/", (req, res) => {
  res.type("html").send(`
    <!doctype html><meta charset="utf-8"/>
    <title>PitchKing API</title>
    <body style="font-family:Segoe UI,Roboto,Arial,sans-serif;background:#0a0f1e;color:#e6f0ff;padding:40px;">
      <h1 style="color:#00e5ff;">⚽ PitchKing Backend is running</h1>
      <p>API base: <code>/api</code></p>
      <p>Health check: <a style="color:#ffd400" href="/api/health">/api/health</a></p>
      <p>Admin panel: <a style="color:#ffd400" href="/admin">/admin</a></p>
    </body>
  `);
});

// 404 for anything else (JSON for /api/*, HTML otherwise).
app.use((req, res) => {
  if (req.path.startsWith("/api") || req.path.startsWith("/callback") || req.path.startsWith("/kcb")) {
    return res.status(404).json({ error: "Not found." });
  }
  res.status(404).type("html").send("<h1>Not found</h1>");
});

// Final error sanitiser — must be last.
app.use(finalErrorHandler());

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`\nPitchKing backend running on port ${PORT}`);
  console.log(`Admin panel:  /admin`);
  console.log(`Health check: /api/health\n`);
});
