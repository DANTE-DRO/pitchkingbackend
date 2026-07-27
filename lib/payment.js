// ─────────────────────────────────────────────────────────────
// PitchKing — KCB Buni STK Push integration (PRODUCTION)
//
// This file is the ONLY payment layer. All existing routes
// (raffle, challenges, wallet withdraw) call `initiateSTKPush(...)`
// exactly the same way they did before — nothing in the business
// logic or flow was changed.
//
// The order of the KCB flow is strictly:
//   1. Get OAuth access token  (client_credentials, Basic auth)
//   2. Push STK to the customer phone (Bearer token)
//   3. Wait for the customer to enter their M-Pesa PIN
//   4. KCB posts the result to KCB_CALLBACK_URL
//   5. We finalise the transaction based on that callback
// ─────────────────────────────────────────────────────────────

const crypto = require("crypto");

const KCB_BASE_URL       = process.env.KCB_BASE_URL       || "https://api.buni.kcbgroup.com";
const KCB_TOKEN_ENDPOINT = process.env.KCB_TOKEN_ENDPOINT || `${KCB_BASE_URL}/token`;
const KCB_STK_ENDPOINT   = (process.env.KCB_STK_ENDPOINT  || `${KCB_BASE_URL}/mm/api/request/1.0.0/stkpush`).trim();
const KCB_CONSUMER_KEY   = process.env.KCB_CONSUMER_KEY   || "";
const KCB_CONSUMER_SECRET= process.env.KCB_CONSUMER_SECRET|| "";
const KCB_CALLBACK_URL   = process.env.KCB_CALLBACK_URL   || "";
const KCB_SHORTCODE      = process.env.KCB_SHORTCODE      || process.env.KCB_TILL || "";
const KCB_PASSKEY        = process.env.KCB_PASSKEY        || "";
const KCB_ENV            = process.env.KCB_ENV            || "production";

// In-memory ledger of pending STK requests so the /callback route
// can look up the original transaction. This is intentionally
// process-local (matches the app's existing JSON-file storage
// approach — no new DB, no new dependency).
const pending = new Map();

/**
 * Normalise a Kenyan phone number to the 2547XXXXXXXX form KCB expects.
 * Accepts 07XXXXXXXX, 7XXXXXXXX, 2547XXXXXXXX, +2547XXXXXXXX.
 */
function normalisePhone(raw) {
  let p = String(raw || "").replace(/\D/g, "");
  if (p.startsWith("0"))       p = "254" + p.slice(1);
  else if (p.startsWith("7") || p.startsWith("1")) p = "254" + p;
  else if (p.startsWith("254")) { /* already good */ }
  else if (p.startsWith("+254")) p = p.slice(1);
  return p;
}

// ─────────────────────────────────────────────────────────────
// 1) OAUTH — client_credentials with Basic auth
// ─────────────────────────────────────────────────────────────
let cachedToken = null;
let cachedTokenExpiry = 0;

async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiry - 30_000) return cachedToken;

  const basic = Buffer
    .from(`${KCB_CONSUMER_KEY}:${KCB_CONSUMER_SECRET}`)
    .toString("base64");

  const url = `${KCB_TOKEN_ENDPOINT}?grant_type=client_credentials`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json",
    },
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }

  if (!res.ok || !data.access_token) {
    const msg = data.error_description || data.error || data.raw || `HTTP ${res.status}`;
    throw new Error(`KCB token error: ${msg}`);
  }

  cachedToken       = data.access_token;
  cachedTokenExpiry = now + (Number(data.expires_in || 3600) * 1000);
  return cachedToken;
}

// ─────────────────────────────────────────────────────────────
// 2) STK PUSH
// ─────────────────────────────────────────────────────────────
async function initiateSTKPush({ phone, amount, accountRef, description }) {
  const phoneNumber = normalisePhone(phone);

  // ─────────────────────────────────────────────────────────────
  // KCB requires invoiceNumber to be:
  //   <KCB_TILL/ShortCode>#<AccountReference>
  // or with a hyphen: <KCB_TILL>-<AccountReference>
  // (per Eddy Munene, KCB API Integrations)
  // We sanitise the accountRef into a short alphanumeric tail so
  // KCB accepts it, but the STRUCTURE and BUSINESS LOGIC of every
  // calling route is unchanged.
  // ─────────────────────────────────────────────────────────────
  const till = String(KCB_SHORTCODE || process.env.KCB_TILL || "").trim();
  const rawRef =
    String(accountRef || `PK${Date.now()}${crypto.randomInt(1000, 9999)}`)
      .replace(/[^A-Za-z0-9]/g, "")
      .slice(0, 12) || `PK${crypto.randomInt(100000, 999999)}`;
  const invoiceNumber = `${till}#${rawRef}`;

  // Guard: without credentials we cannot push. Fail cleanly so the
  // calling route surfaces a real error instead of silently succeeding.
  if (!KCB_CONSUMER_KEY || !KCB_CONSUMER_SECRET) {
    return { success: false, error: "Payment gateway is not configured." };
  }
  if (!/^2547\d{8}$|^2541\d{8}$/.test(phoneNumber)) {
    return { success: false, error: "Please enter a valid Safaricom phone number (e.g. 07XXXXXXXX)." };
  }

  let token;
  try {
    token = await getAccessToken();
  } catch (e) {
    return { success: false, error: `Could not authenticate with payment gateway: ${e.message}` };
  }

  const body = {
    phoneNumber,
    amount: String(Math.round(Number(amount))),
    invoiceNumber,
    sharedShortCode: false,
    orgShortCode: String(KCB_SHORTCODE),
    orgPassKey: KCB_PASSKEY,
    callbackUrl: KCB_CALLBACK_URL,
    transactionDescription: String(description || "PitchKing payment").slice(0, 100),
    accountReference: String(accountRef || invoiceNumber).slice(0, 20),
  };

  let res, data;
  try {
    res = await fetch(KCB_STK_ENDPOINT, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
  } catch (e) {
    return { success: false, error: `Network error contacting payment gateway: ${e.message}` };
  }

  // KCB Buni wraps its answer as { header:{statusCode,statusDescription}, response:{...} }.
  // Older docs show a flat shape — support both.
  const header   = data.header   || {};
  const response = data.response || data;

  const statusCode = header.statusCode || response.ResponseCode || response.responseCode;
  const checkoutId =
    response.CheckoutRequestID ||
    response.checkoutRequestID ||
    response.MerchantRequestID ||
    invoiceNumber;

  const ok = res.ok && (String(statusCode) === "0" || Boolean(response.CheckoutRequestID));

  if (!ok) {
    const msg =
      response.errorMessage ||
      response.error_description ||
      response.ResponseDescription ||
      response.responseDescription ||
      response.CustomerMessage ||
      header.statusDescription ||
      data.message ||
      data.raw ||
      `HTTP ${res.status}`;
    console.error("[KCB STK non-ok]", res.status, JSON.stringify(data));
    return { success: false, error: `Payment gateway declined the request: ${msg}`, raw: data };
  }

  // Record the pending push so the callback route can settle it.
  pending.set(checkoutId, {
    invoiceNumber,
    phone: phoneNumber,
    amount: Number(amount),
    accountRef,
    description,
    createdAt: Date.now(),
    status: "PENDING",
  });

  return {
    success: true,          // "push was sent" — customer now sees the prompt
    pending: true,          // waiting for M-Pesa PIN confirmation
    checkoutRequestId: checkoutId,
    invoiceNumber,
    transactionId: invoiceNumber,
    message: "Waiting for payment confirmation…",
  };
}

// ─────────────────────────────────────────────────────────────
// 3) CALLBACK — invoked by KCB on the KCB_CALLBACK_URL
//    Returns { ok, status: "SUCCESS"|"FAILED", data }
// ─────────────────────────────────────────────────────────────
function handleCallback(body) {
  const cb = (body && body.Body && body.Body.stkCallback) || body || {};
  const checkoutId = cb.CheckoutRequestID || cb.checkoutRequestID || null;
  const resultCode = Number(cb.ResultCode !== undefined ? cb.ResultCode : cb.resultCode);
  const resultDesc = cb.ResultDesc || cb.resultDesc || "";

  const meta = {};
  const items =
    (cb.CallbackMetadata && cb.CallbackMetadata.Item) ||
    (cb.callbackMetadata && cb.callbackMetadata.Item) ||
    [];
  items.forEach((it) => { if (it && it.Name) meta[it.Name] = it.Value; });

  const record = checkoutId ? pending.get(checkoutId) : null;

  if (resultCode === 0) {
    if (record) {
      record.status = "SUCCESS";
      record.mpesaReceipt = meta.MpesaReceiptNumber || null;
      record.settledAt = Date.now();
    }
    return {
      ok: true,
      status: "SUCCESS",
      checkoutRequestId: checkoutId,
      mpesaReceipt: meta.MpesaReceiptNumber || null,
      amount: meta.Amount || null,
      phone: meta.PhoneNumber || null,
      message: "Payment successful",
    };
  }

  if (record) {
    record.status = "FAILED";
    record.failureReason = resultDesc;
    record.settledAt = Date.now();
  }
  return {
    ok: false,
    status: "FAILED",
    checkoutRequestId: checkoutId,
    resultCode,
    message: resultDesc || "Payment was not completed",
  };
}

function getPending(checkoutId) {
  return pending.get(checkoutId) || null;
}

/**
 * Server-side wait for the STK to settle.
 * Resolves with { status: "SUCCESS"|"FAILED"|"TIMEOUT", ...record }.
 *
 * Business routes use this so a purchase / stake is only persisted
 * AFTER the customer has actually entered their M-Pesa PIN and the
 * KCB callback has confirmed the payment. This is what turns the
 * previous "simulation" behaviour into a real transaction.
 */
async function waitForSettlement(checkoutId, { timeoutMs = 90_000, intervalMs = 2000 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const rec = pending.get(checkoutId);
    if (rec && rec.status === "SUCCESS") {
      return {
        status: "SUCCESS",
        mpesaReceipt: rec.mpesaReceipt || null,
        amount: rec.amount,
        phone: rec.phone,
        message: "Payment successful",
      };
    }
    if (rec && rec.status === "FAILED") {
      return {
        status: "FAILED",
        message: rec.failureReason || "Payment was not completed",
      };
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return {
    status: "TIMEOUT",
    message: "Payment confirmation timed out. Please try again.",
  };
}

module.exports = {
  initiateSTKPush,
  handleCallback,
  getPending,
  waitForSettlement,
  getAccessToken, // exported for the /kcb/test route
  _config: {
    KCB_ENV,
    KCB_BASE_URL,
    KCB_TOKEN_ENDPOINT,
    KCB_STK_ENDPOINT,
    KCB_CALLBACK_URL,
    KCB_SHORTCODE,
  },
};
