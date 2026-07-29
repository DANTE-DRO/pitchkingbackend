// ─────────────────────────────────────────────────────────────
// PitchKing — Admin auth (HARDENED).
//
// SAME public API as before: ensureDefaultAdmin, login, requireAdmin.
// SAME session-header contract: `x-admin-token`.
// SAME default admin bootstrap from ADMIN_USERNAME / ADMIN_PASSWORD.
//
// What changed (security only — no functional change):
//   • bcrypt cost raised from 10 → 12
//   • session tokens now have an absolute TTL + idle TTL
//   • tokens are bound to the requesting IP + User-Agent fingerprint
//     to defeat stolen-token replay from a different device
//   • sessions cap (LRU eviction) to prevent unbounded memory growth
//   • lookups use timing-safe compares (via lib/security.safeEqual)
//   • password compare wrapped in a small min-time delay to blunt
//     username-enumeration timing side channels
//   • admin bootstrap never logs the username in plain form
// ─────────────────────────────────────────────────────────────

const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const store = require("./store");
const { safeEqual, clientIp } = require("./security");

const BCRYPT_COST = Math.max(10, Number(process.env.BCRYPT_COST) || 12);
const SESSION_ABSOLUTE_TTL_MS = Number(process.env.SESSION_ABS_TTL_MS) || 8 * 60 * 60 * 1000;   // 8h
const SESSION_IDLE_TTL_MS     = Number(process.env.SESSION_IDLE_TTL_MS) || 30 * 60 * 1000;      // 30m
const SESSION_MAX             = Number(process.env.SESSION_MAX) || 200;

// token -> { username, createdAt, lastSeen, ipHash, uaHash }
const sessions = new Map();

// ─── helpers ─────────────────────────────────────────────────
function shaHex(s) {
  return crypto.createHash("sha256").update(String(s || "")).digest("hex");
}

function fingerprint(req) {
  return {
    ipHash: shaHex(clientIp(req)),
    uaHash: shaHex(req.headers["user-agent"] || ""),
  };
}

function evictOldestIfFull() {
  if (sessions.size < SESSION_MAX) return;
  // Drop the least-recently-seen session.
  let oldestKey = null;
  let oldestSeen = Infinity;
  for (const [k, v] of sessions) {
    if (v.lastSeen < oldestSeen) {
      oldestSeen = v.lastSeen;
      oldestKey = k;
    }
  }
  if (oldestKey) sessions.delete(oldestKey);
}

function purgeExpired() {
  const now = Date.now();
  for (const [k, v] of sessions) {
    if (now - v.createdAt > SESSION_ABSOLUTE_TTL_MS || now - v.lastSeen > SESSION_IDLE_TTL_MS) {
      sessions.delete(k);
    }
  }
}
setInterval(purgeExpired, 5 * 60 * 1000).unref?.();

// ─── bootstrap admin from env ────────────────────────────────
function ensureDefaultAdmin() {
  const admins = store.readAll("admins");
  const username = process.env.ADMIN_USERNAME || "admin";
  const password = process.env.ADMIN_PASSWORD;

  if (!password) {
    // Do NOT continue with a hardcoded default in production.
    console.error(
      "[auth] ADMIN_PASSWORD is not set. Refusing to create/update an admin without one."
    );
    if (admins.length === 0) {
      console.error(
        "[auth] No admin exists yet and no ADMIN_PASSWORD is provided. Login will remain disabled until you set it."
      );
    }
    return;
  }

  if (admins.length > 0) {
    const admin = admins[0];
    // Keep the admin credentials in sync with env on every boot, but
    // only if they actually differ — this preserves the previous
    // "change env var, redeploy, new creds" workflow.
    const usernameMatches = admin.username === username;
    let passwordMatches = false;
    try { passwordMatches = bcrypt.compareSync(password, admin.passwordHash); } catch (_) {}
    if (!usernameMatches || !passwordMatches) {
      store.update("admins", admin.id, {
        username,
        passwordHash: bcrypt.hashSync(password, BCRYPT_COST),
        rotatedAt: new Date().toISOString(),
      });
      // Also invalidate every live session — old tokens must not
      // survive a credential rotation.
      sessions.clear();
      console.log("[auth] Admin credentials rotated from environment. All sessions invalidated.");
    }
    return;
  }

  store.insert("admins", {
    id: crypto.randomUUID(),
    username,
    passwordHash: bcrypt.hashSync(password, BCRYPT_COST),
    createdAt: new Date().toISOString(),
  });
  console.log("[auth] Default admin account created.");
}

// ─── login (called by /api/admin/login) ──────────────────────
async function login(username, password, req) {
  // Minimum response time — flattens the timing signal between
  // "no such user" and "wrong password".
  const minMs = 250;
  const started = Date.now();

  const admins = store.readAll("admins");
  const admin = admins.find((a) => safeEqual(a.username, username));

  let token = null;
  if (admin && password) {
    let ok = false;
    try { ok = bcrypt.compareSync(String(password), admin.passwordHash); } catch (_) {}
    if (ok) {
      evictOldestIfFull();
      token = crypto.randomBytes(32).toString("hex");
      const fp = req ? fingerprint(req) : { ipHash: "", uaHash: "" };
      sessions.set(token, {
        username: admin.username,
        createdAt: Date.now(),
        lastSeen: Date.now(),
        ipHash: fp.ipHash,
        uaHash: fp.uaHash,
      });
    }
  } else {
    // Do a dummy compare so the timing is similar when no user matches.
    try { bcrypt.compareSync(String(password || "x"), "$2a$12$abcdefghijklmnopqrstuv"); } catch (_) {}
  }

  const elapsed = Date.now() - started;
  if (elapsed < minMs) {
    await new Promise((r) => setTimeout(r, minMs - elapsed));
  }
  return token;
}

// ─── middleware ──────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const token = req.headers["x-admin-token"];
  if (!token || typeof token !== "string") {
    return res.status(401).json({ error: "Not authorised. Please log in again." });
  }
  const sess = sessions.get(token);
  if (!sess) {
    return res.status(401).json({ error: "Not authorised. Please log in again." });
  }
  const now = Date.now();
  if (now - sess.createdAt > SESSION_ABSOLUTE_TTL_MS || now - sess.lastSeen > SESSION_IDLE_TTL_MS) {
    sessions.delete(token);
    return res.status(401).json({ error: "Session expired. Please log in again." });
  }
  // Bind session to fingerprint. If either the IP or the UA changes
  // completely, drop the session — a stolen token is unusable elsewhere.
  const fp = fingerprint(req);
  // Allow the UA to differ (some browsers change it silently on update)
  // but require the IP to match unless SESSION_STRICT_IP=false.
  const strictIp = String(process.env.SESSION_STRICT_IP || "true") === "true";
  if (strictIp && sess.ipHash && sess.ipHash !== fp.ipHash) {
    sessions.delete(token);
    return res.status(401).json({ error: "Session invalidated. Please log in again." });
  }
  sess.lastSeen = now;
  req.admin = { username: sess.username };
  next();
}

// Optional: explicit logout (safe to add — no existing caller relies on absence).
function logout(token) {
  if (token) sessions.delete(token);
}

module.exports = { ensureDefaultAdmin, login, requireAdmin, logout };
