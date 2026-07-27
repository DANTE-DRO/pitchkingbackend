const express = require("express");
const crypto = require("crypto");
const store = require("../lib/store");
const { requireAdmin } = require("../lib/auth");
const { initiateSTKPush, waitForSettlement } = require("../lib/payment");

const router = express.Router();

function getSettings() {
  const rows = store.readAll("settings");
  return rows[0] || { winnerPercent: 80, platformPercent: 20 };
}

function shortCode() {
  // Short, easy to read/share playing code, e.g. "7F3K9Q"
  return crypto.randomBytes(4).toString("hex").toUpperCase().slice(0, 6);
}

// ---------- PUBLIC ----------

// Player A creates a challenge.
// Body: { amount, phone, email, playingCode? }
// If playingCode is omitted, the server generates one and returns it —
// Player A shares that code with their opponent however they like
// (WhatsApp, in-game chat, etc.)
router.post("/bets", async (req, res) => {
  const { amount, phone, email, playingCode } = req.body;
  if (!amount || !phone || !email) {
    return res.status(400).json({ error: "amount, phone and email are required" });
  }
  const stake = Number(amount);
  if (!(stake > 0)) return res.status(400).json({ error: "amount must be greater than 0" });

  const code = (playingCode || shortCode()).toUpperCase();

  const existing = store
    .readAll("bets")
    .find((b) => b.playingCode === code && b.status === "awaiting_opponent");
  if (existing) {
    return res.status(409).json({ error: "That playing code is already in use. Please choose another." });
  }

  // 1) Real STK Push to the creator's phone.
  const payment = await initiateSTKPush({
    phone,
    amount: stake,
    accountRef: code,
    description: `Challenge stake for playing code ${code}`,
  });
  if (!payment.success) {
    return res.status(402).json({ error: payment.error || "Deposit could not be completed. Please try again." });
  }

  // 2) Wait for the KCB callback to confirm the customer entered
  //    their M-Pesa PIN. Only persist the bet after settlement.
  const settlement = await waitForSettlement(payment.checkoutRequestId);
  if (settlement.status !== "SUCCESS") {
    return res.status(402).json({
      error: settlement.message || "Payment was not completed. Please try again.",
      checkoutRequestId: payment.checkoutRequestId,
    });
  }

  const bet = {
    id: crypto.randomUUID(),
    playingCode: code,
    amount: stake,
    status: "awaiting_opponent", // awaiting_opponent | active | awaiting_admin | disputed | paid | cancelled
    creator: { phone, email, agreed: true, depositPaid: true, resultClaim: null },
    opponent: null,
    winnerSide: null, // "creator" | "opponent"
    payout: null,
    adminNote: null,
    createdAt: new Date().toISOString(),
  };
  store.insert("bets", bet);
  res.status(201).json(bet);
});

// Look up an open challenge by its playing code, so an opponent can join it.
router.get("/bets/code/:code", (req, res) => {
  const code = req.params.code.toUpperCase();
  const bet = store.readAll("bets").find((b) => b.playingCode === code);
  if (!bet) return res.status(404).json({ error: "No challenge found with that playing code" });
  if (bet.status !== "awaiting_opponent") {
    return res.status(400).json({ error: "This challenge is no longer open to a new opponent" });
  }
  res.json({ id: bet.id, playingCode: bet.playingCode, amount: bet.amount, status: bet.status });
});

// Player B joins and matches the stake.
// Body: { phone, email, agree: true }
router.post("/bets/:id/join", async (req, res) => {
  const { phone, email, agree } = req.body;
  const bet = store.findById("bets", req.params.id);
  if (!bet) return res.status(404).json({ error: "Challenge not found" });
  if (bet.status !== "awaiting_opponent") {
    return res.status(400).json({ error: "This challenge is no longer open to a new opponent" });
  }
  if (!phone || !email || !agree) {
    return res.status(400).json({
      error: "phone, email are required, and you must agree that the loser authorises payout to the winner",
    });
  }

  // 1) Real STK Push to the opponent's phone.
  const payment = await initiateSTKPush({
    phone,
    amount: bet.amount,
    accountRef: bet.playingCode,
    description: `Challenge stake for playing code ${bet.playingCode}`,
  });
  if (!payment.success) {
    return res.status(402).json({ error: payment.error || "Deposit could not be completed. Please try again." });
  }

  // 2) Wait for real settlement before marking the bet active.
  const settlement = await waitForSettlement(payment.checkoutRequestId);
  if (settlement.status !== "SUCCESS") {
    return res.status(402).json({
      error: settlement.message || "Payment was not completed. Please try again.",
      checkoutRequestId: payment.checkoutRequestId,
    });
  }

  // 3) Re-read the bet in case it was joined or cancelled meanwhile.
  const freshBet = store.findById("bets", bet.id);
  if (!freshBet || freshBet.status !== "awaiting_opponent") {
    return res.status(400).json({
      error: "This challenge is no longer open. Please contact support for a refund.",
      checkoutRequestId: payment.checkoutRequestId,
      mpesaReceipt: settlement.mpesaReceipt || null,
    });
  }

  const updated = store.update("bets", freshBet.id, {
    status: "active",
    opponent: { phone, email, agreed: true, depositPaid: true, resultClaim: null },
  });
  res.json(updated);
});

// Either player reports who won, after the match has been played.
// Body: { side: "creator" | "opponent" (who is reporting), winnerSide: "creator" | "opponent" }
router.post("/bets/:id/result", (req, res) => {
  const { side, winnerSide } = req.body;
  const bet = store.findById("bets", req.params.id);
  if (!bet) return res.status(404).json({ error: "Challenge not found" });
  if (bet.status !== "active") {
    return res.status(400).json({ error: "This challenge is not currently active" });
  }
  if (!["creator", "opponent"].includes(side) || !["creator", "opponent"].includes(winnerSide)) {
    return res.status(400).json({ error: "side and winnerSide must be 'creator' or 'opponent'" });
  }

  const patch = {};
  patch[side] = { ...bet[side], resultClaim: winnerSide };
  let updatedBet = store.update("bets", bet.id, patch);

  const bothReported = updatedBet.creator.resultClaim && updatedBet.opponent.resultClaim;
  if (bothReported) {
    if (updatedBet.creator.resultClaim === updatedBet.opponent.resultClaim) {
      const settings = getSettings();
      const winnerSideFinal = updatedBet.creator.resultClaim;
      const pot = updatedBet.amount * 2;
      const winnerAmount = Math.round((pot * settings.winnerPercent) / 100);
      const platformAmount = pot - winnerAmount;
      updatedBet = store.update("bets", bet.id, {
        status: "awaiting_admin",
        winnerSide: winnerSideFinal,
        payout: {
          pot,
          winnerPercent: settings.winnerPercent,
          platformPercent: settings.platformPercent,
          winnerAmount,
          platformAmount,
          winnerPhone: updatedBet[winnerSideFinal].phone,
        },
      });
    } else {
      updatedBet = store.update("bets", bet.id, {
        status: "disputed",
        adminNote: "Players reported different winners — needs manual admin review.",
      });
    }
  }

  res.json(updatedBet);
});

// ---------- ADMIN ----------

router.get("/admin/bets", requireAdmin, (req, res) => {
  res.json(store.readAll("bets"));
});

// Admin manually decides the winner for a disputed challenge.
router.post("/admin/bets/:id/resolve", requireAdmin, (req, res) => {
  const { winnerSide, note } = req.body;
  const bet = store.findById("bets", req.params.id);
  if (!bet) return res.status(404).json({ error: "Challenge not found" });
  if (!["creator", "opponent"].includes(winnerSide)) {
    return res.status(400).json({ error: "winnerSide must be 'creator' or 'opponent'" });
  }

  const settings = getSettings();
  const pot = bet.amount * 2;
  const winnerAmount = Math.round((pot * settings.winnerPercent) / 100);
  const platformAmount = pot - winnerAmount;

  const updated = store.update("bets", bet.id, {
    status: "awaiting_admin",
    winnerSide,
    adminNote: note || "Resolved manually by admin after a disputed result.",
    payout: {
      pot,
      winnerPercent: settings.winnerPercent,
      platformPercent: settings.platformPercent,
      winnerAmount,
      platformAmount,
      winnerPhone: bet[winnerSide].phone,
    },
  });
  res.json(updated);
});

// Admin confirms the payout has actually been sent (manually, outside this
// system — e.g. via M-Pesa) and marks the challenge as fully settled.
router.post("/admin/bets/:id/authorize", requireAdmin, (req, res) => {
  const bet = store.findById("bets", req.params.id);
  if (!bet) return res.status(404).json({ error: "Challenge not found" });
  if (bet.status !== "awaiting_admin") {
    return res.status(400).json({ error: "This challenge is not awaiting payout authorisation" });
  }
  const updated = store.update("bets", bet.id, {
    status: "paid",
    paidAt: new Date().toISOString(),
  });
  res.json(updated);
});

router.post("/admin/bets/:id/cancel", requireAdmin, (req, res) => {
  const updated = store.update("bets", req.params.id, { status: "cancelled" });
  if (!updated) return res.status(404).json({ error: "Challenge not found" });
  res.json(updated);
});

module.exports = router;
