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

// List all raffle accounts customers can currently buy tickets for.
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
      features: a.features,
      ticketsSold: a.ticketsSold,
      status: a.status, // "open" | "closed"
      winnerTicket: a.status === "closed" ? a.winnerTicket : undefined,
    }));
  res.json(publicAccounts);
});

router.get("/accounts/:id", (req, res) => {
  const a = store.findById("accounts", req.params.id);
  if (!a) return res.status(404).json({ error: "Account not found" });
  res.json(a);
});

// ---------- ADMIN ----------

router.get("/admin/accounts", requireAdmin, (req, res) => {
  res.json(store.readAll("accounts"));
});

router.post("/admin/accounts", requireAdmin, (req, res) => {
  const { name, worth, ticketPrice, features } = req.body;
  if (!name || !worth || !ticketPrice) {
    return res.status(400).json({ error: "name, worth and ticketPrice are required" });
  }
  const account = {
    id: crypto.randomUUID(),
    name,
    worth: Number(worth),
    ticketPrice: Number(ticketPrice),
    features: Array.isArray(features) ? features : [],
    image: null,
    ticketsSold: 0,
    status: "open", // open | closed | archived
    winnerTicket: null,
    winnerEmail: null,
    createdAt: new Date().toISOString(),
  };
  store.insert("accounts", account);
  res.status(201).json(account);
});

// Update name / worth / price / features / status. Editing features here is
// what makes them "appear on the frontend" immediately — the public GET
// above always reads the latest saved copy, there is no separate step.
router.put("/admin/accounts/:id", requireAdmin, (req, res) => {
  const { name, worth, ticketPrice, features, status } = req.body;
  const patch = {};
  if (name !== undefined) patch.name = name;
  if (worth !== undefined) patch.worth = Number(worth);
  if (ticketPrice !== undefined) patch.ticketPrice = Number(ticketPrice);
  if (features !== undefined) patch.features = features;
  if (status !== undefined) patch.status = status;

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
