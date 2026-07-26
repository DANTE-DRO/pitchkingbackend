const express = require("express");
const crypto = require("crypto");
const store = require("../lib/store");
const { sendEmail } = require("../lib/email");
const { initiateSTKPush } = require("../lib/payment");

const router = express.Router();

function generateUniqueTicketNumber(existingNumbers) {
  let n;
  do {
    n = crypto.randomInt(100000, 999999); // 6-digit ticket number
  } while (existingNumbers.has(n));
  existingNumbers.add(n);
  return n;
}

// Buy one or more raffle tickets for an account.
// Body: { accountId, quantity, email, phone }
router.post("/raffle/buy", async (req, res) => {
  const { accountId, quantity, email, phone } = req.body;

  if (!accountId || !quantity || !email) {
    return res.status(400).json({ error: "accountId, quantity and email are required" });
  }
  const qty = Number(quantity);
  if (!Number.isInteger(qty) || qty < 1 || qty > 500) {
    return res.status(400).json({ error: "quantity must be a whole number between 1 and 500" });
  }

  const account = store.findById("accounts", accountId);
  if (!account) return res.status(404).json({ error: "Account not found" });
  if (account.status !== "open") {
    return res.status(400).json({ error: "This raffle is no longer open for ticket purchases" });
  }

  const totalCost = qty * account.ticketPrice;

  // Placeholder payment step — see backend/lib/payment.js
  const payment = await initiateSTKPush({
    phone: phone || "unknown",
    amount: totalCost,
    accountRef: account.id,
    description: `${qty} raffle ticket(s) for ${account.name}`,
  });

  if (!payment.success) {
    return res.status(402).json({ error: "Payment could not be completed. Please try again." });
  }

  // Generate unique ticket numbers for this account
  const existingNumbers = new Set(
    store.readAll("tickets").filter((t) => t.accountId === account.id).map((t) => t.ticketNumber)
  );
  const purchaseId = crypto.randomUUID();
  const ticketNumbers = [];
  for (let i = 0; i < qty; i++) {
    const ticketNumber = generateUniqueTicketNumber(existingNumbers);
    ticketNumbers.push(ticketNumber);
    store.insert("tickets", {
      id: crypto.randomUUID(),
      purchaseId,
      accountId: account.id,
      accountName: account.name,
      ticketNumber,
      buyerEmail: email,
      buyerPhone: phone || null,
      pricePaid: account.ticketPrice,
      createdAt: new Date().toISOString(),
    });
  }

  store.update("accounts", account.id, { ticketsSold: account.ticketsSold + qty });

  await sendEmail({
    to: email,
    subject: `Your PitchKing raffle ticket number(s) — ${account.name}`,
    html: `
      <p>Thanks for your purchase! You bought <strong>${qty}</strong> ticket(s) for
      <strong>${account.name}</strong> (worth KSh ${account.worth.toLocaleString()}).</p>
      <p>Your ticket number${qty > 1 ? "s are" : " is"}:</p>
      <p style="font-size:18px;font-weight:bold;letter-spacing:1px;">
        ${ticketNumbers.join(", ")}
      </p>
      <p>Keep this email safe — these numbers are used to pick the winner. Good luck!</p>
      <p>— PitchKing</p>
    `,
  });

  res.status(201).json({
    ticketNumbers,
    totalCost,
    transactionId: payment.transactionId,
  });
});

module.exports = router;
