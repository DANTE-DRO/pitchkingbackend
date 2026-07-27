const express = require("express");
const store = require("../lib/store");
const { login, requireAdmin } = require("../lib/auth");

const router = express.Router();

router.post("/admin/login", (req, res) => {
  const { username, password } = req.body;
  const token = login(username, password);
  if (!token) return res.status(401).json({ error: "Incorrect username or password" });
  res.json({ token, username });
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
