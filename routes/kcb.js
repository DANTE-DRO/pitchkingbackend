// PitchKing — KCB Buni callback + test routes (HARDENED).
// - POST /callback  is what KCB posts back after the customer enters their PIN.
// - GET  /callback/status/:checkoutId  is polled by the frontend to know when the STK is settled.
// - POST /kcb/test-stk  triggers a live STK push (used for the ops smoke-test).
//   ↑ Was PUBLIC. Now REQUIRES admin session — otherwise any visitor could
//     spam STK pushes to arbitrary phone numbers. No route path change.
// These routes are additive — no existing business logic was changed.

const express = require("express");
const {
  initiateSTKPush,
  handleCallback,
  getPending,
  getAccessToken,
  _config,
} = require("../lib/payment");
const { requireAdmin } = require("../lib/auth");
const { rateLimit, safeEqual } = require("../lib/security");
const wallet = require("../lib/wallet");
const crypto = require("crypto");

const router = express.Router();

// Optional shared secret KCB can include in a header (KCB Buni supports
// a static signature/token). If KCB_CALLBACK_SECRET is set, we require
// the incoming callback to carry the matching value in x-callback-token.
// If it's NOT set, we keep the previous behaviour (accept all callbacks)
// so this change is strictly additive.
const CALLBACK_SECRET = String(process.env.KCB_CALLBACK_SECRET || "").trim();

// Guard the callback with a light rate limit — a flood of forged
// callbacks should never overwhelm the process.
const callbackLimiter = rateLimit({
  windowMs: 60_000,
  max: 240, // 4/sec sustained is plenty for real KCB traffic
  bucket: "kcb-callback",
});

// KCB posts here after the customer confirms (or cancels) on their phone.
router.post("/callback", callbackLimiter, express.json({ limit: "256kb" }), (req, res) => {
  try {
    if (CALLBACK_SECRET) {
      const supplied = String(req.headers["x-callback-token"] || "");
      if (!safeEqual(supplied, CALLBACK_SECRET)) {
        // Return the same shape KCB expects so it does not retry against
        // our real settlement logic, but do not act on the payload.
        console.warn("[KCB callback] rejected — bad or missing signature.");
        return res.json({ ResultCode: 0, ResultDesc: "Accepted" });
      }
    }
    const result = handleCallback(req.body || {});
    console.log(
      `[KCB callback] ${result.status} — checkout=${result.checkoutRequestId} receipt=${result.mpesaReceipt || "-"} :: ${result.message}`
    );
    // Immortal-wallet credit — additive, never blocks the KCB ack.
    // Only credits on SUCCESS, and de-duplicates internally so retried
    // KCB callbacks never double-count. Any error here is swallowed so
    // the callback response to KCB remains unchanged.
    try {
      if (result && result.status === "SUCCESS") {
        const rec = require("../lib/payment").getPending(result.checkoutRequestId);
        wallet.credit({
          source: rec && rec.description
            ? (String(rec.description).toLowerCase().includes("tournament") ? "tournament"
              : String(rec.description).toLowerCase().includes("raffle")     ? "raffle"
              : String(rec.description).toLowerCase().includes("challenge") ? "challenge"
              : String(rec.description).toLowerCase().includes("bet")       ? "bet"
              : "unknown")
            : "unknown",
          amount: rec ? rec.amount : (result.amount || 0),
          mpesaReceipt: result.mpesaReceipt,
          checkoutRequestId: result.checkoutRequestId,
          phone: rec ? rec.phone : (result.phone || null),
          accountRef: rec ? rec.accountRef : null,
          description: rec ? rec.description : null,
        });
      }
    } catch (_) { /* wallet errors never affect KCB ack */ }
    // KCB expects a plain acknowledgement.
    res.json({ ResultCode: 0, ResultDesc: "Accepted" });
  } catch (err) {
    console.error("[KCB callback] error:", err && err.message);
    res.json({ ResultCode: 0, ResultDesc: "Accepted" });
  }
});

// Some gateways send GET pings — respond OK so their health check passes.
router.get("/callback", (req, res) => {
  res.json({ ok: true, service: "PitchKing KCB callback" });
});

// Polling endpoint for the customer UI — "is my payment done yet?"
// Rate-limited per IP so it can't be used to enumerate checkout IDs.
const pollLimiter = rateLimit({
  windowMs: 60_000,
  max: 240,
  bucket: "kcb-poll",
});
router.get("/callback/status/:checkoutId", pollLimiter, (req, res) => {
  const id = String(req.params.checkoutId || "");
  // Basic shape guard — must look like a checkout ID token.
  if (!id || id.length > 128 || !/^[A-Za-z0-9._#-]+$/.test(id)) {
    return res.status(400).json({ status: "UNKNOWN" });
  }
  const rec = getPending(id);
  if (!rec) return res.status(404).json({ status: "UNKNOWN" });
  res.json({
    status: rec.status,                        // PENDING | SUCCESS | FAILED
    mpesaReceipt: rec.mpesaReceipt || null,
    failureReason: rec.failureReason || null,
    cancelled: Boolean(rec.cancelled),
    resultCode: rec.resultCode,
    amount: rec.amount,
    phone: rec.phone,
    message:
      rec.status === "PENDING" ? "Waiting for payment confirmation…" :
      rec.status === "SUCCESS" ? "Payment successful" :
      rec.cancelled ? "Payment cancelled." :
      rec.failureReason || "Payment was not completed",
  });
});

// Ops smoke-test — verifies token + STK push against the live gateway.
// PREVIOUSLY PUBLIC — now requires admin session AND is rate-limited.
// This closes the "any visitor triggers arbitrary STK pushes" hole
// without touching any legitimate operator workflow.
const testStkLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 30,
  bucket: "kcb-test",
  message: "Too many test pushes. Please wait before trying again.",
});
router.post("/kcb/test-stk", requireAdmin, testStkLimiter, async (req, res) => {
  const rawPhone = (req.body && req.body.phone) || "0797977136";
  const amount = Number((req.body && req.body.amount) || 1);
  if (typeof rawPhone !== "string" || rawPhone.length > 20) {
    return res.status(400).json({ error: "Invalid phone number." });
  }
  if (!(amount > 0) || amount > 10) {
    // Cap test amount so the smoke-test cannot be used to move real money.
    return res.status(400).json({ error: "Test amount must be between 1 and 10." });
  }
  try {
    const token = await getAccessToken();
    const result = await initiateSTKPush({
      phone: rawPhone,
      amount,
      accountRef: "PK-TEST",
      description: "PitchKing STK test",
    });
    // Redact the config in the response — do not echo endpoint / shortcode
    // details back to the browser even for an admin.
    res.json({
      tokenAcquired: Boolean(token),
      env: _config.KCB_ENV,
      push: result,
    });
  } catch (err) {
    res.status(500).json({ error: "STK test failed." });
  }
});

module.exports = router;
