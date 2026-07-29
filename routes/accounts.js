const express = require("express");
const crypto = require("crypto");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const store = require("../lib/store");
const { requireAdmin } = require("../lib/auth");
const { rateLimit } = require("../lib/security");

const router = express.Router();

// ─── Hardened image upload ───────────────────────────────────
// Same route, same field name, same 5MB limit — but now:
//   • only image/* MIME types are accepted
//   • filename is generated server-side (no user-controlled path)
//   • extension whitelist enforced
//   • at most 1 file per request
const ALLOWED_EXT = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

const upload = multer({
  storage: multer.diskStorage({
    destination: path.join(__dirname, "..", "uploads"),
    filename: (req, file, cb) => {
      const rawExt = (path.extname(file.originalname) || ".jpg").toLowerCase();
      const ext = ALLOWED_EXT.has(rawExt) ? rawExt : ".jpg";
      // Do not embed user-controlled req.params.id verbatim — hash it.
      const safeId = crypto.createHash("sha1")
        .update(String(req.params.id || "unknown"))
        .digest("hex")
        .slice(0, 12);
      const rand = crypto.randomBytes(6).toString("hex");
      cb(null, `${safeId}-${Date.now()}-${rand}${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME.has(String(file.mimetype).toLowerCase())) {
      return cb(new Error("Only JPG/PNG/GIF/WEBP images are allowed."), false);
    }
    cb(null, true);
  },
});

// ---------- helpers ----------

function getCountdownEndsAt(a) {
  if (a.countdownEndsAt) return a.countdownEndsAt;
  const rows = store.readAll("settings");
  const days = Number(rows[0] && rows[0].raffleCountdownDays) > 0
    ? Number(rows[0].raffleCountdownDays)
    : 7;
  const base = a.createdAt ? new Date(a.createdAt).getTime() : Date.now();
  return new Date(base + days * 24 * 60 * 60 * 1000).toISOString();
}

// Normalise an Imgur URL.  Returns a direct-image URL or null.
function normaliseImgurUrl(raw) {
  if (!raw || typeof raw !== "string") return null;
  let url = raw.trim();
  if (!url) return null;
  // Hard cap length (defensive).
  if (url.length > 500) return null;
  // Must be http/https, never javascript:/data:
  if (!/^https?:\/\//i.test(url)) return null;
  if (/^https?:\/\/i\.imgur\.com\/[A-Za-z0-9]+\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i.test(url)) {
    return url;
  }
  if (/^https?:\/\/.+\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i.test(url)) {
    return url;
  }
  const m = url.match(/^https?:\/\/(?:www\.)?imgur\.com\/(?:gallery\/|a\/)?([A-Za-z0-9]{5,})/i);
  if (m) {
    return `https://i.imgur.com/${m[1]}.jpg`;
  }
  return null;
}

// Whitelist of characters allowed inside a raffle id (as posted by the
// immortal-raffles client). Prevents anyone shoving a path or HTML into it.
function safeId(v) {
  const s = String(v || "").trim();
  if (!s || s.length > 80) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(s)) return null;
  return s;
}

function safeStr(v, max) {
  if (v === undefined || v === null) return "";
  const s = String(v);
  if (s.length > max) return s.slice(0, max);
  return s;
}

// ---------- PUBLIC ----------

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
      status: a.status,
      countdownEndsAt: getCountdownEndsAt(a),
      winnerTicket: a.status === "closed" ? a.winnerTicket : undefined,
      tournamentLink: a.tournamentLink || null,
      rev: Number(a.rev) || 0,
    }));
  res.json(publicAccounts);
});

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
  const id = safeId(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid id." });
  const a = store.findById("accounts", id);
  if (!a) return res.status(404).json({ error: "Account not found" });
  const { ticketsSold, ...safe } = a;
  res.json({ ...safe, countdownEndsAt: getCountdownEndsAt(a) });
});

// ---------- ADMIN ----------

router.get("/admin/accounts", requireAdmin, (req, res) => {
  res.json(store.readAll("accounts"));
});

// ---------- PUBLIC IMMORTAL-RAFFLE REHYDRATE ----------
// Same idempotent contract as before.  Added: strict field validation,
// length caps, and safe-id enforcement so nobody can inject arbitrary
// blobs into the store even though the endpoint is public.
function handleRehydrate(req, res) {
  const body = req.body || {};
  const id = safeId(body.id);
  if (!id) return res.status(400).json({ error: "id, name, worth and ticketPrice are required" });

  const name = safeStr(body.name, 200).trim();
  const worth = Number(body.worth);
  const ticketPrice = Number(body.ticketPrice);
  if (!name || !(worth > 0) || !(ticketPrice > 0)) {
    return res.status(400).json({ error: "id, name, worth and ticketPrice are required" });
  }
  if (worth > 100_000_000 || ticketPrice > 100_000) {
    return res.status(400).json({ error: "worth or ticketPrice out of range" });
  }

  const tombs = store.readAll("tombstones").map((t) => String(t.id));
  if (tombs.indexOf(String(id)) !== -1) {
    return res.status(410).json({ error: "This raffle was deleted by the operator." });
  }
  const existing = store.findById("accounts", id);
  if (existing) {
    return res.status(200).json(existing);
  }
  let imgUrlClean = null;
  if (body.imageUrl !== undefined && body.imageUrl !== null && String(body.imageUrl).trim() !== "") {
    imgUrlClean = normaliseImgurUrl(body.imageUrl);
    if (!imgUrlClean) {
      return res.status(400).json({ error: "imageUrl must be a valid Imgur (or direct image) URL" });
    }
  }
  let ends = null;
  if (body.countdownEndsAt) {
    const d = new Date(body.countdownEndsAt);
    if (!isNaN(d.getTime())) ends = d.toISOString();
  }
  if (!ends) {
    const rows = store.readAll("settings");
    const days = Number(rows[0] && rows[0].raffleCountdownDays) > 0 ? Number(rows[0].raffleCountdownDays) : 7;
    ends = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  }
  // Sanitise features array — cap size and per-item length.
  let features = [];
  if (Array.isArray(body.features)) {
    features = body.features.slice(0, 30).map((f) => safeStr(f, 200));
  }
  const tournamentLink = body.tournamentLink ? safeStr(body.tournamentLink, 500).trim() : null;

  const account = {
    id: String(id),
    name,
    worth,
    ticketPrice,
    features,
    image: null,
    imageUrl: imgUrlClean,
    ticketsSold: 0,
    status: "open",
    winnerTicket: null,
    winnerEmail: null,
    tournamentLink: tournamentLink || null,
    countdownEndsAt: ends,
    createdAt: body.createdAt || new Date().toISOString(),
    rev: 0,
  };
  store.insert("accounts", account);
  return res.status(201).json(account);
}

router.post("/accounts/rehydrate", (req, res) => handleRehydrate(req, res));

router.post("/admin/accounts/rehydrate", requireAdmin, (req, res) => handleRehydrate(req, res));

router.post("/admin/accounts", requireAdmin, (req, res) => {
  const { name, worth, ticketPrice, features, imageUrl, tournamentLink } = req.body || {};
  if (!name || !worth || !ticketPrice) {
    return res.status(400).json({ error: "name, worth and ticketPrice are required" });
  }
  const nameSafe = safeStr(name, 200).trim();
  const worthNum = Number(worth);
  const priceNum = Number(ticketPrice);
  if (!nameSafe || !(worthNum > 0) || !(priceNum > 0)) {
    return res.status(400).json({ error: "name, worth and ticketPrice are required" });
  }
  if (worthNum > 100_000_000 || priceNum > 100_000) {
    return res.status(400).json({ error: "worth or ticketPrice out of range" });
  }
  let imgUrlClean = null;
  if (imageUrl !== undefined && imageUrl !== null && String(imageUrl).trim() !== "") {
    imgUrlClean = normaliseImgurUrl(imageUrl);
    if (!imgUrlClean) {
      return res.status(400).json({ error: "imageUrl must be a valid Imgur (or direct image) URL" });
    }
  }
  const settingsRows = store.readAll("settings");
  const countdownDays = Number(settingsRows[0] && settingsRows[0].raffleCountdownDays) > 0
    ? Number(settingsRows[0].raffleCountdownDays)
    : 7;
  const createdAt = new Date().toISOString();
  const countdownEndsAt = new Date(Date.now() + countdownDays * 24 * 60 * 60 * 1000).toISOString();

  let featuresSafe = [];
  if (Array.isArray(features)) featuresSafe = features.slice(0, 30).map((f) => safeStr(f, 200));

  const account = {
    id: crypto.randomUUID(),
    name: nameSafe,
    worth: worthNum,
    ticketPrice: priceNum,
    features: featuresSafe,
    image: null,
    imageUrl: imgUrlClean,
    ticketsSold: 0,
    status: "open",
    winnerTicket: null,
    winnerEmail: null,
    tournamentLink: tournamentLink ? safeStr(tournamentLink, 500) : null,
    countdownEndsAt,
    createdAt,
    rev: 0,
  };
  store.insert("accounts", account);
  res.status(201).json(account);
});

router.put("/admin/accounts/:id", requireAdmin, (req, res) => {
  const id = safeId(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid id." });
  const { name, worth, ticketPrice, features, status, countdownEndsAt, countdownDaysFromNow, imageUrl, tournamentLink } = req.body || {};
  const patch = {};
  if (name !== undefined) patch.name = safeStr(name, 200);
  if (worth !== undefined) {
    const w = Number(worth);
    if (!(w >= 0) || w > 100_000_000) return res.status(400).json({ error: "worth out of range" });
    patch.worth = w;
  }
  if (ticketPrice !== undefined) {
    const p = Number(ticketPrice);
    if (!(p >= 0) || p > 100_000) return res.status(400).json({ error: "ticketPrice out of range" });
    patch.ticketPrice = p;
  }
  if (features !== undefined) {
    if (!Array.isArray(features)) return res.status(400).json({ error: "features must be an array" });
    patch.features = features.slice(0, 30).map((f) => safeStr(f, 200));
  }
  if (status !== undefined) {
    if (!["open", "closed", "archived"].includes(String(status))) {
      return res.status(400).json({ error: "invalid status" });
    }
    patch.status = status;
  }
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
      patch.tournamentLink = safeStr(tournamentLink, 500).trim();
    }
  }

  const cur = store.findById("accounts", id);
  patch.rev = (Number(cur && cur.rev) || 0) + 1;

  const updated = store.update("accounts", id, patch);
  if (updated) return res.json(updated);

  // Materialise a minimal row (same behaviour as before).
  const materialised = {
    id: String(id),
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

router.post("/admin/accounts/:id/image", requireAdmin, (req, res, next) => {
  // Wrap multer so its errors become clean JSON (never leak internal messages).
  upload.single("image")(req, res, function (err) {
    if (err) {
      const msg = err && err.message && err.message.length < 200 ? err.message : "Upload failed.";
      return res.status(400).json({ error: msg });
    }
    const id = safeId(req.params.id);
    if (!id) {
      // Best-effort cleanup of a stray file.
      if (req.file && req.file.path) { try { fs.unlinkSync(req.file.path); } catch (_) {} }
      return res.status(400).json({ error: "Invalid id." });
    }
    const account = store.findById("accounts", id);
    if (!account) {
      if (req.file && req.file.path) { try { fs.unlinkSync(req.file.path); } catch (_) {} }
      return res.status(404).json({ error: "Account not found" });
    }
    if (!req.file) return res.status(400).json({ error: "No image uploaded" });

    const updated = store.update("accounts", id, {
      image: `/uploads/${req.file.filename}`,
    });
    res.json(updated);
  });
});

router.post("/admin/accounts/:id/draw", requireAdmin, (req, res) => {
  const id = safeId(req.params.id);
  if (!id) return res.status(400).json({ error: "Invalid id." });
  const account = store.findById("accounts", id);
  if (!account) return res.status(404).json({ error: "Account not found" });
  if (account.ticketsSold === 0) {
    return res.status(400).json({ error: "No tickets have been sold for this account yet" });
  }

  const tickets = store.readAll("tickets").filter((t) => t.accountId === account.id);
  // Cryptographically random pick.
  const winningTicket = tickets[crypto.randomInt(0, tickets.length)];

  const updated = store.update("accounts", id, {
    status: "closed",
    winnerTicket: winningTicket.ticketNumber,
    winnerEmail: winningTicket.buyerEmail,
  });

  res.json({ account: updated, winningTicket });
});

router.delete("/admin/accounts/:id", requireAdmin, (req, res) => {
  const targetId = safeId(req.params.id);
  if (!targetId) return res.status(400).json({ error: "Invalid id." });
  const all = store.readAll("accounts").filter((a) => a.id !== targetId);
  store.writeAll("accounts", all);

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
