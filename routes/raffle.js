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
    purchaseId,
    accountName: fresh.name,
    ticketPrice: fresh.ticketPrice,
    receiptUrl: `/api/raffle/receipt/${purchaseId}`,
    message: "Payment successful. Your ticket(s) have been issued.",
  });
});

// ------------------------------------------------------------------
// JOIN TOURNAMENT
// Body: { accountId, amount, phone }
// Fires a REAL STK Push to the customer's phone. Only after the KCB
// callback confirms the payment was successful does it return the
// tournament WhatsApp group link stored on the account.
// The link is set / changed / deleted by the admin from the frontend
// control panel or the backend admin panel — it persists on the account
// record until the admin explicitly removes it.
// ------------------------------------------------------------------
router.post("/raffle/join-tournament", async (req, res) => {
  const { accountId, amount, phone } = req.body;

  if (!accountId || !amount || !phone) {
    return res.status(400).json({ error: "accountId, amount and phone are required" });
  }
  const entryAmount = Number(amount);
  if (!(entryAmount > 0)) {
    return res.status(400).json({ error: "amount must be greater than 0" });
  }

  const account = store.findById("accounts", accountId);
  if (!account) return res.status(404).json({ error: "Account not found" });
  if (account.status !== "open") {
    return res.status(400).json({ error: "This raffle is no longer open for tournament entry" });
  }

  // 1) Fire the real STK Push to the buyer's phone.
  const payment = await initiateSTKPush({
    phone,
    amount: entryAmount,
    accountRef: `${account.id}T`,
    description: `Tournament entry for ${account.name}`,
  });

  if (!payment.success) {
    return res.status(402).json({ error: payment.error || "Payment could not be completed. Please try again." });
  }

  // 2) Wait for the KCB callback to confirm the customer entered
  //    their M-Pesa PIN and the money actually moved.
  const settlement = await waitForSettlement(payment.checkoutRequestId);
  if (settlement.status !== "SUCCESS") {
    return res.status(402).json({
      error: settlement.message || "Payment was not completed. Please try again.",
      checkoutRequestId: payment.checkoutRequestId,
    });
  }

  // 3) Payment succeeded — return the tournament WhatsApp group link.
  //    The link comes from the account record (set by admin, persists
  //    until admin explicitly deletes it).
  res.status(200).json({
    success: true,
    checkoutRequestId: payment.checkoutRequestId || null,
    mpesaReceipt: settlement.mpesaReceipt || null,
    tournamentLink: account.tournamentLink || null,
    accountName: account.name,
    message: "Payment successful. Your tournament link is ready.",
  });
});

// ------------------------------------------------------------------
// DOWNLOAD RECEIPT (public, by purchaseId)
// Returns a printable, self-contained HTML receipt with a Content-
// Disposition header so the browser will offer it as a file download.
// This does NOT change any existing purchase / payment logic — it just
// reads the already-persisted tickets rows.
// ------------------------------------------------------------------
router.get("/raffle/receipt/:purchaseId", (req, res) => {
  const purchaseId = String(req.params.purchaseId || "").trim();
  const tickets = store.readAll("tickets").filter((t) => t.purchaseId === purchaseId);
  if (tickets.length === 0) {
    return res.status(404).type("html").send("<h1>Receipt not found</h1>");
  }
  const first = tickets[0];
  const total = tickets.reduce((s, t) => s + Number(t.pricePaid || 0), 0);
  const dateStr = new Date(first.createdAt).toLocaleString();
  const numbers = tickets.map((t) => t.ticketNumber).join(", ");
  const mpesa = first.mpesaReceipt ? String(first.mpesaReceipt) : "—";
  const shortId = purchaseId.slice(0, 8).toUpperCase();

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>PitchKing Receipt — ${shortId}</title>
<style>
  * { box-sizing:border-box; }
  body{
    font-family:"Segoe UI",Roboto,Arial,sans-serif;
    background:#0a1428; color:#e6f0ff;
    margin:0; padding:24px;
  }
  .receipt{
    max-width:640px; margin:0 auto;
    background:linear-gradient(160deg,#0a1428,#111f3f);
    border:1px solid #1e3163; border-radius:12px;
    padding:30px 34px; position:relative; overflow:hidden;
  }
  .receipt::before{
    content:""; position:absolute; top:0; left:0; right:0; height:4px;
    background:linear-gradient(90deg,transparent,#00e5ff,#ffd400,#00e5ff,transparent);
  }
  .brand{
    font-family:"Orbitron","Segoe UI",sans-serif;
    font-size:26px; font-weight:900; letter-spacing:2px; color:#fff;
    text-shadow:0 0 12px rgba(0,229,255,.4); margin:0 0 4px;
  }
  .brand .accent{ color:#00e5ff; }
  .sub{ color:#ffd400; font-size:11px; letter-spacing:3px; text-transform:uppercase; margin-bottom:22px; }
  h1{ margin:22px 0 14px; font-size:16px; letter-spacing:2px; text-transform:uppercase; color:#00e5ff;
      padding-bottom:8px; border-bottom:1px solid #1e3163; }
  .row{ display:flex; justify-content:space-between; padding:8px 0; font-size:14px; border-bottom:1px dashed rgba(30,49,99,.6); }
  .row .k{ color:#a9b8d6; text-transform:uppercase; letter-spacing:1px; font-size:11px; }
  .row .v{ color:#fff; font-weight:600; text-align:right; }
  .tickets{
    margin:14px 0; padding:16px;
    background:rgba(0,229,255,.06);
    border:1.5px dashed #00e5ff; border-radius:8px;
    text-align:center; letter-spacing:2px; font-weight:900;
    color:#00e5ff; font-size:18px; word-break:break-all;
    font-family:"Orbitron",monospace;
  }
  .total{
    margin-top:14px; font-size:22px; font-weight:900;
    color:#ffd400; text-align:right;
    font-family:"Orbitron","Segoe UI",sans-serif;
    text-shadow:0 0 10px rgba(255,212,0,.35);
  }
  .foot{ text-align:center; margin-top:24px; color:#6d7c9c; font-size:11px; letter-spacing:1px; }
  .print{
    display:inline-block; margin:20px 0 0; padding:10px 22px;
    background:linear-gradient(90deg,#00e5ff,#7cf9ff); color:#001018;
    border:none; cursor:pointer; font-weight:900; letter-spacing:1px;
    border-radius:6px; text-transform:uppercase; font-size:12px;
  }
  @media print{ .print{ display:none; } body{ background:#fff; color:#000; } .receipt{ background:#fff; color:#000; border-color:#ccc; } .row .v, .brand{ color:#000; } .brand .accent{ color:#0a72b8; } .tickets{ color:#0a72b8; background:#f0fcff; } .total{ color:#a07600; } }
</style>
</head>
<body>
  <div class="receipt">
    <div class="brand">⚽ PITCH<span class="accent">KING</span></div>
    <div class="sub">▸ Raffle Ticket Receipt</div>

    <h1>Purchase Details</h1>
    <div class="row"><span class="k">Receipt ID</span><span class="v">${shortId}</span></div>
    <div class="row"><span class="k">Date</span><span class="v">${dateStr}</span></div>
    <div class="row"><span class="k">Raffle</span><span class="v">${escapeHtml(first.accountName || "—")}</span></div>
    <div class="row"><span class="k">Buyer email</span><span class="v">${escapeHtml(first.buyerEmail || "—")}</span></div>
    <div class="row"><span class="k">Buyer phone</span><span class="v">${escapeHtml(first.buyerPhone || "—")}</span></div>
    <div class="row"><span class="k">M-Pesa receipt</span><span class="v">${escapeHtml(mpesa)}</span></div>
    <div class="row"><span class="k">Ticket price</span><span class="v">KSh ${Number(first.pricePaid).toLocaleString()}</span></div>
    <div class="row"><span class="k">Quantity</span><span class="v">${tickets.length}</span></div>

    <h1>Your Ticket Numbers</h1>
    <div class="tickets">${escapeHtml(numbers)}</div>

    <div class="total">TOTAL PAID: KSh ${Number(total).toLocaleString()}</div>

    <div class="foot">
      Keep this receipt safe. Winners are picked at random from all valid ticket numbers.<br/>
      — PitchKing
    </div>

    <button class="print" onclick="window.print()">Print / Save as PDF</button>
  </div>
</body>
</html>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="PitchKing-Receipt-${shortId}.html"`);
  res.send(html);
});

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

module.exports = router;
