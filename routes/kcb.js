// PitchKing — KCB Buni callback + test routes.
// - POST /callback  is what KCB posts back after the customer enters their PIN.
// - GET  /callback/status/:checkoutId  is polled by the frontend to know when the STK is settled.
// - POST /kcb/test-stk  triggers a live STK push (used for the ops smoke-test).
// These routes are additive — no existing business logic was changed.

const express = require("express");
const {
  initiateSTKPush,
  handleCallback,
  getPending,
  getAccessToken,
  _config,
} = require("../lib/payment");

const router = express.Router();

// KCB posts here after the customer confirms (or cancels) on their phone.
router.post("/callback", express.json({ limit: "1mb" }), (req, res) => {
  try {
    const result = handleCallback(req.body || {});
    console.log(
      `[KCB callback] ${result.status} — checkout=${result.checkoutRequestId} receipt=${result.mpesaReceipt || "-"} :: ${result.message}`
    );
    // KCB expects a plain acknowledgement.
    res.json({ ResultCode: 0, ResultDesc: "Accepted" });
  } catch (err) {
    console.error("[KCB callback] error:", err);
    res.json({ ResultCode: 0, ResultDesc: "Accepted" });
  }
});

// Some gateways send GET pings — respond OK so their health check passes.
router.get("/callback", (req, res) => {
  res.json({ ok: true, service: "PitchKing KCB callback" });
});

// Polling endpoint for the customer UI — "is my payment done yet?"
router.get("/callback/status/:checkoutId", (req, res) => {
  const rec = getPending(req.params.checkoutId);
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

// Ops smoke-test: verifies token + STK push against the live sandbox/prod gateway.
router.post("/kcb/test-stk", async (req, res) => {
  const phone = (req.body && req.body.phone) || "0797977136";
  const amount = Number((req.body && req.body.amount) || 1);
  try {
    const token = await getAccessToken();
    const result = await initiateSTKPush({
      phone,
      amount,
      accountRef: "PK-TEST",
      description: "PitchKing STK test",
    });
    res.json({
      tokenAcquired: Boolean(token),
      config: _config,
      push: result,
    });
  } catch (err) {
    res.status(500).json({ error: err.message, config: _config });
  }
});

module.exports = router;
