const express = require("express");
const crypto = require("crypto");
const store = require("../lib/store");
const { sendEmail } = require("../lib/email");
const { initiateSTKPush, waitForSettlement } = require("../lib/payment");

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

  if (!accountId || !quantity || !email || !phone) {
    return res.status(400).json({ error: "accountId, quantity, email and phone are required" });
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

  // 1) Fire the real STK Push to the buyer's phone.
  const payment = await initiateSTKPush({
    phone,
    amount: totalCost,
    accountRef: account.id,
    description: `${qty} raffle ticket(s) for ${account.name}`,
  });

  if (!payment.success) {
    return res.status(402).json({ error: payment.error || "Payment could not be completed. Please try again." });
  }

  // 2) Wait for the KCB callback to confirm the customer entered
  //    their M-Pesa PIN and the money actually moved. Only then
  //    do we issue tickets and send the confirmation email —
  //    otherwise a cancelled PIN entry would still hand out tickets.
  const settlement = await waitForSettlement(payment.checkoutRequestId);
  if (settlement.status !== "SUCCESS") {
    return res.status(402).json({
      error: settlement.message || "Payment was not completed. Please try again.",
      checkoutRequestId: payment.checkoutRequestId,
    });
  }

  // 3) Re-read the account in case its status changed while we were
  //    waiting for the PIN (e.g. admin closed the raffle).
  const fresh = store.findById("accounts", account.id);
  if (!fresh || fresh.status !== "open") {
    return res.status(400).json({
      error: "This raffle closed while your payment was being processed. Please contact support for a refund.",
      checkoutRequestId: payment.checkoutRequestId,
      mpesaReceipt: settlement.mpesaReceipt || null,
    });
  }

  // Generate unique ticket numbers for this account
  const existingNumbers = new Set(
    store.readAll("tickets").filter((t) => t.accountId === fresh.id).map((t) => t.ticketNumber)
  );
  const purchaseId = crypto.randomUUID();
  const ticketNumbers = [];
  for (let i = 0; i < qty; i++) {
    const ticketNumber = generateUniqueTicketNumber(existingNumbers);
    ticketNumbers.push(ticketNumber);
    store.insert("tickets", {
      id: crypto.randomUUID(),
      purchaseId,
      accountId: fresh.id,
      accountName: fresh.name,
      ticketNumber,
      buyerEmail: email,
      buyerPhone: phone,
      pricePaid: fresh.ticketPrice,
      mpesaReceipt: settlement.mpesaReceipt || null,
      createdAt: new Date().toISOString(),
    });
  }

  store.update("accounts", fresh.id, { ticketsSold: fresh.ticketsSold + qty });

  // Send confirmation email only after payment has actually settled.
  sendEmail({
    to: email,
    subject: `Your PitchKing raffle ticket number(s) — ${fresh.name}`,
    html: `
      <p>Thanks for your purchase! You bought <strong>${qty}</strong> ticket(s) for
      <strong>${fresh.name}</strong> (worth KSh ${fresh.worth.toLocaleString()}).</p>
      <p>Your ticket number${qty > 1 ? "s are" : " is"}:</p>
      <p style="font-size:18px;font-weight:bold;letter-spacing:1px;">
        ${ticketNumbers.join(", ")}
      </p>
      ${settlement.mpesaReceipt ? `<p>M-Pesa receipt: <strong>${settlement.mpesaReceipt}</strong></p>` : ""}
      <p>Keep this email safe — these numbers are used to pick the winner. Good luck!</p>
      <p>— PitchKing</p>
    `,
  }).catch(() => {});

  res.status(201).json({
    ticketNumbers,
    totalCost,
    transactionId: payment.transactionId,
    checkoutRequestId: payment.checkoutRequestId || null,
    invoiceNumber: payment.invoiceNumber || null,
    mpesaReceipt: settlement.mpesaReceipt || null,
    message: "Payment successful. Your ticket(s) have been issued.",
  });
});

module.exports = router;
