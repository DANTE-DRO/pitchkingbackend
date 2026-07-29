// ─────────────────────────────────────────────────────────────
// Hidden Frontend Control-Panel — server-side unlock (NEW, additive).
//
// The previous build put the control-panel password ("11hezron72") in
// the frontend JS bundle, so anyone who opened DevTools could read it.
// This route lets the frontend verify the password server-side WITHOUT
// changing the UX: the footer dot still opens a password prompt, the
// prompt still submits, and on success the same admin session token is
// returned. What's different is the password now lives ONLY on the
// server (CP_PASSWORD env var), and the check is rate-limited.
//
// New endpoint:
//   POST /api/cp/unlock  { password }  →  { token, username }
//
// No existing route was touched. If CP_PASSWORD is not set, the endpoint
// returns 503 so the frontend falls back to the standard admin login.
// ─────────────────────────────────────────────────────────────

const express = require("express");
const { login } = require("../lib/auth");
const { rateLimit, safeEqual } = require("../lib/security");

const router = express.Router();

const cpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 8,
  bucket: "cp-unlock",
  message: "Too many attempts. Please try again in a few minutes.",
});

router.post("/cp/unlock", cpLimiter, async (req, res) => {
  const cpSecret = String(process.env.CP_PASSWORD || "").trim();
  if (!cpSecret) {
    return res.status(503).json({ error: "Control-panel access is not configured." });
  }
  const supplied = req.body && typeof req.body.password === "string" ? req.body.password : "";
  if (!supplied || supplied.length > 300) {
    return res.status(400).json({ error: "Password is required." });
  }
  // Enforce a small minimum response time to blunt timing attacks.
  const t0 = Date.now();
  const ok = safeEqual(supplied, cpSecret);
  const wait = 200 - (Date.now() - t0);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));

  if (!ok) return res.status(401).json({ error: "Incorrect password." });

  // Password matches — mint a real admin session using the configured
  // admin credentials. The frontend continues to receive `{ token }`.
  const adminUser = process.env.ADMIN_USERNAME || "admin";
  const adminPass = process.env.ADMIN_PASSWORD;
  if (!adminPass) {
    return res.status(503).json({ error: "Admin login is not configured." });
  }
  const token = await login(adminUser, adminPass, req);
  if (!token) return res.status(500).json({ error: "Could not open a session." });
  res.json({ token, username: adminUser });
});

module.exports = router;
