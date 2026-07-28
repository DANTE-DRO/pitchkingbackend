const express = require("express");
const crypto = require("crypto");
const multer = require("multer");
const path = require("path");
const store = require("../lib/store");
const { requireAdmin } = require("../lib/auth");

const router = express.Router();

const upload = multer({
  storage: multer.diskStorage({
    destination: path.join(__dirname, "..", "uploads"),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || ".jpg";
      cb(null, `${req.params.id}-${Date.now()}${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});

// ---------- PUBLIC ----------

// Compute the current countdown end timestamp for an account.
// Priority:
//   1) account.countdownEndsAt (explicit per-account override set from admin panel)
//   2) account.createdAt + settings.raffleCountdownDays * 1 day
//   3) fallback: now + 7 days
function getCountdownEndsAt(a) {
  if (a.countdownEndsAt) return a.countdownEndsAt;
  const rows = store.readAll("settings");
  const days = Number(rows[0] && rows[0].raffleCountdownDays) > 0
    ? Number(rows[0].raffleCountdownDays)
    : 7;
  const base = a.createdAt ? new Date(a.createdAt).getTime() : Date.now();
  return new Date(base + days * 24 * 60 * 60 * 1000).toISOString();
}

// Normalise an Imgur URL. Accepts:
//   https://imgur.com/AbCdEfG
//   https://imgur.com/gallery/AbCdEfG
//   https://i.imgur.com/AbCdEfG.jpg
// Returns a direct-image URL (i.imgur.com/<id>.jpg) or null if it looks invalid.
function normaliseImgurUrl(raw) {
  if (!raw || typeof raw !== "string") return null;
  let url = raw.trim();
  if (!url) return null;
  // Already a direct image URL from any host — accept as-is.
  if (/^https?:\/\/i\.imgur\.com\/[A-Za-z0-9]+\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i.test(url)) {
    return url;
  }
  // Any other direct http(s) image URL — accept as-is (defensive: users may paste other hosts).
  if (/^https?:\/\/.+\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i.test(url)) {
    return url;
  }
  // Imgur page URL → convert to direct image URL (default to .jpg, Imgur serves the right type regardless).
  const m = url.match(/^https?:\/\/(?:www\.)?imgur\.com\/(?:gallery\/|a\/)?([A-Za-z0-9]{5,})/i);
  if (m) {
    return `https://i.imgur.com/${m[1]}.jpg`;
  }
  return null;
}

// List all raffle accounts customers can currently buy tickets for.
// NOTE: ticketsSold is intentionally NOT exposed on the public feed —
// the number of tickets already sold must stay private on the frontend.
router.get("/accounts", (req, res) => {
  const accounts = store.readAll("accounts");
  const publicAccounts = accounts
    .filter((a) => a.status !== "archived")
    .map((a) => ({
      id: a.id,
      name: a.name,
      worth: a.worth,
      ticketPrice: a.ticketPrice,
      image: a.image,
      imageUrl: a.imageUrl || null,
      features: a.features,
      status: a.status, // "open" | "closed"
      countdownEndsAt: getCountdownEndsAt(a),
      winnerTicket: a.status === "closed" ? a.winnerTicket : undefined,
    }));
  res.json(publicAccounts);
});

router.get("/accounts/:id", (req, res) => {
  const a = store.findById("accounts", req.params.id);
  if (!a) return res.status(404).json({ error: "Account not found" });
  // Public detail: strip ticketsSold, add countdownEndsAt.
  const { ticketsSold, ...safe } = a;
  res.json({ ...safe, countdownEndsAt: getCountdownEndsAt(a) });
});

// ---------- ADMIN ----------

router.get("/admin/accounts", requireAdmin, (req, res) => {
  res.json(store.readAll("accounts"));
});

router.post("/admin/accounts", requireAdmin, (req, res) => {
  const { name, worth, ticketPrice, features, imageUrl } = req.body;
  if (!name || !worth || !ticketPrice) {
    return res.status(400).json({ error: "name, worth and ticketPrice are required" });
  }
  let imgUrlClean = null;
  if (imageUrl !== undefined && imageUrl !== null && String(imageUrl).trim() !== "") {
    imgUrlClean = normaliseImgurUrl(imageUrl);
    if (!imgUrlClean) {
      return res.status(400).json({ error: "imageUrl must be a valid Imgur (or direct image) URL" });
    }
  }
  const account = {
    id: crypto.randomUUID(),
    name,
    worth: Number(worth),
    ticketPrice: Number(ticketPrice),
    features: Array.isArray(features) ? features : [],
    image: null,
    imageUrl: imgUrlClean,
    ticketsSold: 0,
    status: "open", // open | closed | archived
    winnerTicket: null,
    winnerEmail: null,
    createdAt: new Date().toISOString(),
  };
  store.insert("accounts", account);
  res.status(201).json(account);
});

// Update name / worth / price / features / status / countdown / imageUrl.
router.put("/admin/accounts/:id", requireAdmin, (req, res) => {
  const { name, worth, ticketPrice, features, status, countdownEndsAt, countdownDaysFromNow, imageUrl } = req.body;
  const patch = {};
  if (name !== undefined) patch.name = name;
  if (worth !== undefined) patch.worth = Number(worth);
  if (ticketPrice !== undefined) patch.ticketPrice = Number(ticketPrice);
  if (features !== undefined) patch.features = features;
  if (status !== undefined) patch.status = status;
  if (countdownEndsAt !== undefined) {
    if (countdownEndsAt === null || countdownEndsAt === "") {
      patch.countdownEndsAt = null;
    } else {
      const d = new Date(countdownEndsAt);
      if (isNaN(d.getTime())) return res.status(400).json({ error: "countdownEndsAt is not a valid date" });
      patch.countdownEndsAt = d.toISOString();
    }
  }
  if (countdownDaysFromNow !== undefined && countdownDaysFromNow !== null && countdownDaysFromNow !== "") {
    const days = Number(countdownDaysFromNow);
    if (!(days > 0) || days > 365) return res.status(400).json({ error: "countdownDaysFromNow must be between 1 and 365" });
    patch.countdownEndsAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  }
  if (imageUrl !== undefined) {
    if (imageUrl === null || String(imageUrl).trim() === "") {
      patch.imageUrl = null;
    } else {
      const clean = normaliseImgurUrl(imageUrl);
      if (!clean) return res.status(400).json({ error: "imageUrl must be a valid Imgur (or direct image) URL" });
      patch.imageUrl = clean;
    }
  }

  const updated = store.update("accounts", req.params.id, patch);
  if (!updated) return res.status(404).json({ error: "Account not found" });
  res.json(updated);
});

router.post("/admin/accounts/:id/image", requireAdmin, upload.single("image"), (req, res) => {
  const account = store.findById("accounts", req.params.id);
  if (!account) return res.status(404).json({ error: "Account not found" });
  if (!req.file) return res.status(400).json({ error: "No image uploaded" });

  const updated = store.update("accounts", req.params.id, {
    image: `/uploads/${req.file.filename}`,
  });
  res.json(updated);
});

// Pick a random winning ticket from everyone who bought one, and close the
// raffle. This is the "raffle draw".
router.post("/admin/accounts/:id/draw", requireAdmin, (req, res) => {
  const account = store.findById("accounts", req.params.id);
  if (!account) return res.status(404).json({ error: "Account not found" });
  if (account.ticketsSold === 0) {
    return res.status(400).json({ error: "No tickets have been sold for this account yet" });
  }

  const tickets = store.readAll("tickets").filter((t) => t.accountId === account.id);
  const winningTicket = tickets[Math.floor(Math.random() * tickets.length)];

  const updated = store.update("accounts", req.params.id, {
    status: "closed",
    winnerTicket: winningTicket.ticketNumber,
    winnerEmail: winningTicket.buyerEmail,
  });

  res.json({ account: updated, winningTicket });
});

router.delete("/admin/accounts/:id", requireAdmin, (req, res) => {
  const all = store.readAll("accounts").filter((a) => a.id !== req.params.id);
  store.writeAll("accounts", all);
  res.json({ ok: true });
});

module.exports = router;
