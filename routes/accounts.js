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
      tournamentLink: a.tournamentLink || null,
      // Revision counter — bumps on every admin edit. Frontend uses it to
      // detect that a raffle has been changed on another device and
      // overwrite its immortal local copy.
      rev: Number(a.rev) || 0,
    }));
  res.json(publicAccounts);
});

// ---------- AUTHORITY FEED ----------
//
// Public, cheap, cache-busting endpoint that returns the two pieces of
// truth every browser needs to align its immortal-local copy with the
// operator's latest state:
//
//   • tombstones — every raffle id the operator has ever DELETED from
//                  ANY device. Persisted server-side so it survives
//                  Render's ephemeral restarts (via store's persistence
//                  layer). Once here, no browser is allowed to keep the
//                  raffle in localStorage/IDB or push it back via
//                  /accounts/rehydrate.
//
//   • revisions — { id: rev } for every current raffle. Browsers whose
//                 local rev is older than server rev will overwrite
//                 their local copy with the server's fields, so an edit
//                 made on the creator's device appears on every device.
router.get("/accounts/authority", (req, res) => {
  const tombstones = store.readAll("tombstones").map((t) => String(t.id));
  const revisions = {};
  store.readAll("accounts").forEach((a) => {
    if (!a || !a.id) return;
    revisions[a.id] = Number(a.rev) || 0;
  });
  res.set("Cache-Control", "no-store");
  res.json({ tombstones, revisions });
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

// Additive endpoint: create-or-restore a raffle using a client-supplied id.
//
// Why: raffle opens are now created & persisted on the frontend
// (localStorage) so they survive Render free-tier sleep/redeploys.
// When a customer starts a payment, the frontend calls this endpoint to
// make sure the backend also has a copy under the SAME id — otherwise
// after a cold start the backend wouldn't know the raffle and ticket
// issuing would fail. If a record with that id already exists, it's a
// no-op (idempotent) — nothing about existing tickets is disturbed.
// ---------- PUBLIC IMMORTAL-RAFFLE REHYDRATE ----------
//
// Same behaviour as /admin/accounts/rehydrate, but NO admin token required.
// This is what makes raffles truly immortal for every visitor:
//   • Every browser that has ever seen a raffle keeps a local copy
//     (see frontend/js/immortal-raffles.js).
//   • On page load, that browser silently POSTs its local raffles here.
//   • The endpoint is STRICTLY idempotent: if a raffle with the given
//     id already exists on the backend, nothing is touched. It can ONLY
//     insert a missing record — never overwrite, modify, or delete.
//   • Result: as soon as any device with a cached copy visits the site
//     after Render's free-tier sleep/redeploy wipes the disk, the raffle
//     list is repopulated for everyone else — without anyone touching
//     the admin panel.
//
// This is safe because:
//   • ticketsSold, winnerTicket, winnerEmail are ALWAYS reset to their
//     public defaults (0 / null) on creation — clients cannot forge them.
//   • Existing records are never mutated, so a malicious client cannot
//     re-open a closed raffle or change its price.
function handleRehydrate(req, res) {
  const { id, name, worth, ticketPrice, features, imageUrl, tournamentLink, countdownEndsAt, createdAt } = req.body || {};
  if (!id || !name || !worth || !ticketPrice) {
    return res.status(400).json({ error: "id, name, worth and ticketPrice are required" });
  }
  // If this id has been tombstoned by the operator on ANY device,
  // never re-insert it — this is the fix that makes deletions propagate
  // to every browser on the planet instead of only the creator's device.
  const tombs = store.readAll("tombstones").map((t) => String(t.id));
  if (tombs.indexOf(String(id)) !== -1) {
    return res.status(410).json({ error: "This raffle was deleted by the operator." });
  }
  const existing = store.findById("accounts", id);
  if (existing) {
    // Idempotent — keep whatever the backend already has, do NOT overwrite.
    return res.status(200).json(existing);
  }
  let imgUrlClean = null;
  if (imageUrl !== undefined && imageUrl !== null && String(imageUrl).trim() !== "") {
    imgUrlClean = normaliseImgurUrl(imageUrl);
    if (!imgUrlClean) {
      return res.status(400).json({ error: "imageUrl must be a valid Imgur (or direct image) URL" });
    }
  }
  let ends = null;
  if (countdownEndsAt) {
    const d = new Date(countdownEndsAt);
    if (!isNaN(d.getTime())) ends = d.toISOString();
  }
  if (!ends) {
    const rows = store.readAll("settings");
    const days = Number(rows[0] && rows[0].raffleCountdownDays) > 0 ? Number(rows[0].raffleCountdownDays) : 7;
    ends = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  }
  const account = {
    id: String(id),
    name: String(name),
    worth: Number(worth),
    ticketPrice: Number(ticketPrice),
    features: Array.isArray(features) ? features : [],
    image: null,
    imageUrl: imgUrlClean,
    ticketsSold: 0,
    status: "open",
    winnerTicket: null,
    winnerEmail: null,
    tournamentLink: (tournamentLink && String(tournamentLink).trim()) || null,
    countdownEndsAt: ends,
    createdAt: createdAt || new Date().toISOString(),
    rev: 0,
  };
  store.insert("accounts", account);
  return res.status(201).json(account);
}

// Public rehydrate — used by every visiting browser to silently
// re-seed a raffle the backend has forgotten. Idempotent + safe.
router.post("/accounts/rehydrate", (req, res) => handleRehydrate(req, res));

// Legacy admin rehydrate — kept for backward-compat with any older client.
router.post("/admin/accounts/rehydrate", requireAdmin, (req, res) => {
  const { id, name, worth, ticketPrice, features, imageUrl, tournamentLink, countdownEndsAt, createdAt } = req.body || {};
  if (!id || !name || !worth || !ticketPrice) {
    return res.status(400).json({ error: "id, name, worth and ticketPrice are required" });
  }
  const tombsAdm = store.readAll("tombstones").map((t) => String(t.id));
  if (tombsAdm.indexOf(String(id)) !== -1) {
    return res.status(410).json({ error: "This raffle was deleted by the operator." });
  }
  const existing = store.findById("accounts", id);
  if (existing) {
    // Idempotent — keep whatever the backend already has.
    return res.status(200).json(existing);
  }
  let imgUrlClean = null;
  if (imageUrl !== undefined && imageUrl !== null && String(imageUrl).trim() !== "") {
    imgUrlClean = normaliseImgurUrl(imageUrl);
    if (!imgUrlClean) {
      return res.status(400).json({ error: "imageUrl must be a valid Imgur (or direct image) URL" });
    }
  }
  let ends = null;
  if (countdownEndsAt) {
    const d = new Date(countdownEndsAt);
    if (!isNaN(d.getTime())) ends = d.toISOString();
  }
  if (!ends) {
    const rows = store.readAll("settings");
    const days = Number(rows[0] && rows[0].raffleCountdownDays) > 0 ? Number(rows[0].raffleCountdownDays) : 7;
    ends = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  }
  const account = {
    id: String(id),
    name: String(name),
    worth: Number(worth),
    ticketPrice: Number(ticketPrice),
    features: Array.isArray(features) ? features : [],
    image: null,
    imageUrl: imgUrlClean,
    ticketsSold: 0,
    status: "open",
    winnerTicket: null,
    winnerEmail: null,
    tournamentLink: (tournamentLink && String(tournamentLink).trim()) || null,
    countdownEndsAt: ends,
    createdAt: createdAt || new Date().toISOString(),
    rev: 0,
  };
  store.insert("accounts", account);
  res.status(201).json(account);
});

router.post("/admin/accounts", requireAdmin, (req, res) => {
  const { name, worth, ticketPrice, features, imageUrl, tournamentLink } = req.body;
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
  // Explicitly set countdownEndsAt at creation time so it is persisted as
  // a fixed timestamp — it will NOT restart if the backend sleeps/restarts.
  // The admin can still override it later from the edit panel.
  const settingsRows = store.readAll("settings");
  const countdownDays = Number(settingsRows[0] && settingsRows[0].raffleCountdownDays) > 0
    ? Number(settingsRows[0].raffleCountdownDays)
    : 7;
  const createdAt = new Date().toISOString();
  const countdownEndsAt = new Date(Date.now() + countdownDays * 24 * 60 * 60 * 1000).toISOString();

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
    tournamentLink: tournamentLink || null,
    countdownEndsAt,
    createdAt,
    rev: 0,
  };
  store.insert("accounts", account);
  res.status(201).json(account);
});

// Update name / worth / price / features / status / countdown / imageUrl.
router.put("/admin/accounts/:id", requireAdmin, (req, res) => {
  const { name, worth, ticketPrice, features, status, countdownEndsAt, countdownDaysFromNow, imageUrl, tournamentLink } = req.body;
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

  if (tournamentLink !== undefined) {
    if (tournamentLink === null || String(tournamentLink).trim() === "") {
      patch.tournamentLink = null;
    } else {
      patch.tournamentLink = String(tournamentLink).trim();
    }
  }

  // Bump the revision counter so every browser knows to overwrite its
  // immortal local copy with these new field values on next sync.
  const cur = store.findById("accounts", req.params.id);
  patch.rev = (Number(cur && cur.rev) || 0) + 1;

  const updated = store.update("accounts", req.params.id, patch);
  if (updated) return res.json(updated);

  // The raffle was never mirrored to the backend yet (it lived only in
  // the creator's immortal-local storage). Materialise a minimal row from
  // the patch so the revision + fields can propagate to every other
  // device via /accounts/authority. Anything the operator didn't supply
  // is left null / empty; subsequent syncs from the creator's browser
  // will enrich it. This is what makes tournament-link and other edits
  // reach every user's phone even before a full rehydrate has happened.
  const materialised = {
    id: String(req.params.id),
    name: patch.name || "",
    worth: Number(patch.worth) || 0,
    ticketPrice: Number(patch.ticketPrice) || 0,
    features: Array.isArray(patch.features) ? patch.features : [],
    image: null,
    imageUrl: patch.imageUrl || null,
    ticketsSold: 0,
    status: patch.status || "open",
    winnerTicket: null,
    winnerEmail: null,
    tournamentLink: (patch.tournamentLink === undefined) ? null : patch.tournamentLink,
    countdownEndsAt: patch.countdownEndsAt || null,
    createdAt: new Date().toISOString(),
    rev: patch.rev,
  };
  store.insert("accounts", materialised);
  res.json(materialised);
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
  const targetId = String(req.params.id);
  const all = store.readAll("accounts").filter((a) => a.id !== targetId);
  store.writeAll("accounts", all);

  // Permanent server-side tombstone so no visitor's browser can push this
  // raffle back via /accounts/rehydrate. This is what makes the delete
  // apply on EVERY device, not only the creator's. Written EVEN IF the
  // account row was never mirrored to the backend — the tombstone alone
  // is enough to block every future rehydrate for this id.
  try {
    const tombs = store.readAll("tombstones");
    if (!tombs.some((t) => String(t.id) === targetId)) {
      tombs.push({ id: targetId, at: new Date().toISOString() });
      store.writeAll("tombstones", tombs);
    }
  } catch (_) {}

  res.json({ ok: true });
});

module.exports = router;
