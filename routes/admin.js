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

router.get("/admin/settings", requireAdmin, (req, res) => {
  const rows = store.readAll("settings");
  res.json(rows[0]);
});

// Body: { winnerPercent, platformPercent } — must add up to 100.
router.post("/admin/settings", requireAdmin, (req, res) => {
  const { winnerPercent, platformPercent } = req.body;
  const wp = Number(winnerPercent);
  const pp = Number(platformPercent);
  if (!(wp > 0) || !(pp >= 0) || wp + pp !== 100) {
    return res.status(400).json({ error: "winnerPercent and platformPercent must add up to exactly 100" });
  }
  const updated = store.update("settings", "settings", { winnerPercent: wp, platformPercent: pp });
  res.json(updated);
});

module.exports = router;
