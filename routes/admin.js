const express = require("express");
const store = require("../lib/store");
const wallet = require("../lib/wallet");
const { login, requireAdmin, logout } = require("../lib/auth");
const { rateLimit } = require("../lib/security");

const router = express.Router();

// Tight per-IP throttle on login — 10 attempts / 5 minutes.
// Preserves the same route path, same body shape, same responses.
const loginLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  bucket: "admin-login",
  message: "Too many login attempts. Please wait a few minutes and try again.",
});

router.post("/admin/login", loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== "string" || typeof password !== "string") {
    return res.status(400).json({ error: "Username and password are required." });
  }
  if (username.length > 200 || password.length > 300) {
    return res.status(400).json({ error: "Credentials too long." });
  }
  const token = await login(username, password, req);
  if (!token) return res.status(401).json({ error: "Incorrect username or password" });
  res.json({ token, username });
});

// Additive: explicit logout (existing clients that never call this
// keep working unchanged — sessions still expire via TTL).
router.post("/admin/logout", (req, res) => {
  logout(req.headers["x-admin-token"]);
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────
// DASHBOARD — totals received from Raffles + Head-to-Head
// (Additive endpoint. No existing route/logic is modified.)
// ─────────────────────────────────────────────────────────────
router.get("/admin/dashboard", requireAdmin, (req, res) => {
  const tickets    = store.readAll("tickets");
  const challenges = store.readAll("challenges");
  const bets       = store.readAll("bets");
  const accounts   = store.readAll("accounts");

  // Total received from Raffles (sum of every ticket sold)
  const raffleTotal = tickets.reduce((s, t) => s + Number(t.pricePaid || 0), 0);

  // Total received from Head-to-Head multi-participant challenges
  const h2hMultiTotal = challenges.reduce(
    (s, c) => s + Number(c.amount || 0) * (c.participants ? c.participants.length : 0),
    0
  );

  // Total received from legacy 1v1 bets (creator + opponent stakes)
  const h2hLegacyTotal = bets.reduce((s, b) => {
    let x = 0;
    if (b.creator  && b.creator.depositPaid)  x += Number(b.amount || 0);
    if (b.opponent && b.opponent.depositPaid) x += Number(b.amount || 0);
    return s + x;
  }, 0);

  const h2hTotal        = h2hMultiTotal + h2hLegacyTotal;
  const grandTotal      = raffleTotal + h2hTotal;
  const platformEarned  = challenges.reduce(
    (s, c) => s + (c.payout ? Number(c.payout.platformAmount || 0) : 0),
    0
  );

  res.json({
    raffles: {
      total: raffleTotal,
      ticketsSold: tickets.length,
      accountsCount: accounts.length,
    },
    headToHead: {
      total: h2hTotal,
      multiParticipantTotal: h2hMultiTotal,
      legacyBetsTotal: h2hLegacyTotal,
      challengesCount: challenges.length,
      legacyBetsCount: bets.length,
    },
    platformEarned,
    grandTotal,
    generatedAt: new Date().toISOString(),
  });
});

// ─────────────────────────────────────────────────────────────
// IMMORTAL WALLET — append-only ledger of every successful M-Pesa
// receipt. Money that arrived once stays counted forever, even after
// redeploys, container restarts, or accidental data-file wipes.
// Additive endpoints. No existing route/logic is modified.
// ─────────────────────────────────────────────────────────────
router.get("/admin/wallet", requireAdmin, (req, res) => {
  const s = wallet.summary();
  const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 1000);
  res.json({
    summary: s,
    entries: wallet.list(limit),
    generatedAt: new Date().toISOString(),
  });
});

router.get("/admin/settings", requireAdmin, (req, res) => {
  const rows = store.readAll("settings");
  res.json(rows[0]);
});

// Public read-only settings (for the raffle countdown, etc.) — no secrets exposed.
router.get("/settings/public", (req, res) => {
  const rows = store.readAll("settings");
  const s = rows[0] || {};
  res.json({
    raffleCountdownDays: Number(s.raffleCountdownDays) > 0 ? Number(s.raffleCountdownDays) : 7,
  });
});

// Body: { winnerPercent, platformPercent, raffleCountdownDays }
//   - winnerPercent + platformPercent must add up to 100 (unchanged rule).
//   - raffleCountdownDays is optional; if provided it must be a positive number.
router.post("/admin/settings", requireAdmin, (req, res) => {
  const { winnerPercent, platformPercent, raffleCountdownDays } = req.body;
  const wp = Number(winnerPercent);
  const pp = Number(platformPercent);
  if (!(wp > 0) || !(pp >= 0) || wp + pp !== 100) {
    return res.status(400).json({ error: "winnerPercent and platformPercent must add up to exactly 100" });
  }
  const patch = { winnerPercent: wp, platformPercent: pp };
  if (raffleCountdownDays !== undefined && raffleCountdownDays !== null && raffleCountdownDays !== "") {
    const days = Number(raffleCountdownDays);
    if (!(days > 0) || days > 365) {
      return res.status(400).json({ error: "raffleCountdownDays must be a number between 1 and 365" });
    }
    patch.raffleCountdownDays = days;
  }
  const updated = store.update("settings", "settings", patch);
  res.json(updated);
});

module.exports = router;
