// PitchKing — Immortal Wallet ledger.
//
// ADDITIVE MODULE. Nothing in the payment flow, routes, or business logic
// is modified. This file records every successful M-Pesa receipt into an
// append-only ledger so the operator's "total amount received" can never
// vanish — not on redeploy, not on container restart, not on a race
// between two callbacks. Money that once arrived stays counted forever.
//
// Persistence strategy (three layers, best-effort each):
//   1) data/wallet-ledger.jsonl     — canonical append-only file
//   2) PERSIST_DIR/wallet-ledger.jsonl (if PERSIST_DIR env set)
//   3) PERSIST_DIR/wallet-ledger.backup.jsonl — a second mirror file so
//      a bad write on one file still leaves the other intact
//
// Each entry is a single JSON line: {id, source, amount, mpesaReceipt,
// checkoutRequestId, phone, accountRef, description, receivedAt}.
//
// Duplicate protection: the same M-Pesa receipt number can only be
// credited once. KCB is known to occasionally retry callbacks — this
// guard prevents double-counting while still preserving every genuine
// receipt for the immortal balance.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = path.join(__dirname, "..", "data");
const PERSIST_DIR = process.env.PERSIST_DIR && String(process.env.PERSIST_DIR).trim()
  ? String(process.env.PERSIST_DIR).trim()
  : null;

const LEDGER_NAME = "wallet-ledger.jsonl";
const BACKUP_NAME = "wallet-ledger.backup.jsonl";

function ledgerPathLocal()  { return path.join(DATA_DIR, LEDGER_NAME); }
function ledgerPathMirror() { return PERSIST_DIR ? path.join(PERSIST_DIR, LEDGER_NAME) : null; }
function ledgerPathBackup() { return PERSIST_DIR ? path.join(PERSIST_DIR, BACKUP_NAME) : null; }

function ensureDirs() {
  try { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
  if (PERSIST_DIR) {
    try { if (!fs.existsSync(PERSIST_DIR)) fs.mkdirSync(PERSIST_DIR, { recursive: true }); } catch (_) {}
  }
}

// On boot, if the local ledger is missing/empty but a persistent mirror
// exists, restore it. This is what makes the wallet "immortal" across
// Render's ephemeral filesystem wipes.
function tryRestore() {
  const local = ledgerPathLocal();
  const mirror = ledgerPathMirror();
  const backup = ledgerPathBackup();
  const localEmpty = !fs.existsSync(local) || (fs.statSync(local).size === 0);
  if (!localEmpty) return;
  const source =
    (mirror && fs.existsSync(mirror) && fs.statSync(mirror).size > 0) ? mirror :
    (backup && fs.existsSync(backup) && fs.statSync(backup).size > 0) ? backup : null;
  if (!source) return;
  try {
    const raw = fs.readFileSync(source, "utf-8");
    fs.writeFileSync(local, raw);
    console.log(`[wallet] Ledger restored from persistent snapshot (${source}).`);
  } catch (err) {
    console.warn(`[wallet] Could not restore ledger from persistent snapshot:`, err.message);
  }
}

function init() {
  ensureDirs();
  tryRestore();
  // Make sure the local file exists (empty is fine).
  try { if (!fs.existsSync(ledgerPathLocal())) fs.writeFileSync(ledgerPathLocal(), ""); } catch (_) {}
  if (PERSIST_DIR) {
    console.log(`[wallet] Immortal ledger active (mirrored to ${PERSIST_DIR}).`);
  } else {
    console.log(`[wallet] Immortal ledger active (local only — set PERSIST_DIR to survive redeploys).`);
  }
}

function readEntries() {
  ensureDirs();
  const p = ledgerPathLocal();
  if (!fs.existsSync(p)) return [];
  let raw;
  try { raw = fs.readFileSync(p, "utf-8"); } catch { return []; }
  if (!raw) return [];
  const out = [];
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch { /* skip corrupt line */ }
  }
  return out;
}

function appendEntryLine(line) {
  ensureDirs();
  // Canonical local file — this is what /admin/wallet reads.
  try { fs.appendFileSync(ledgerPathLocal(), line); } catch (err) {
    console.error("[wallet] Local ledger append failed:", err && err.message);
  }
  // Persistent mirror + backup — best-effort, independent try/catch per file
  // so if one is unavailable the other still gets written.
  const mirror = ledgerPathMirror();
  if (mirror) {
    try { fs.appendFileSync(mirror, line); }
    catch (err) { console.warn("[wallet] Mirror append failed:", err && err.message); }
  }
  const backup = ledgerPathBackup();
  if (backup) {
    try { fs.appendFileSync(backup, line); }
    catch (err) { console.warn("[wallet] Backup append failed:", err && err.message); }
  }
}

/**
 * Credit the immortal wallet.
 * Called by the KCB callback the moment a payment is confirmed SUCCESS.
 * Safe to call from any code path — silently ignored if the amount is
 * missing or the receipt has already been credited.
 *
 * @param {Object} p
 *   source            "raffle" | "tournament" | "challenge" | "bet" | "unknown"
 *   amount            number in KSh
 *   mpesaReceipt      M-Pesa receipt number from KCB (used as dedupe key)
 *   checkoutRequestId KCB checkout id (fallback dedupe key)
 *   phone             payer phone
 *   accountRef        optional business ref (accountId, challengeId, etc.)
 *   description       optional human description
 */
function credit(p) {
  try {
    const amount = Number(p && p.amount);
    if (!(amount > 0)) return { ok: false, reason: "no-amount" };

    // Dedupe: if we have a receipt or checkout id and we've already
    // credited it, do nothing — the wallet stays immortal but never
    // double-counts on KCB retries.
    const receipt   = p.mpesaReceipt      ? String(p.mpesaReceipt).trim() : "";
    const checkout  = p.checkoutRequestId ? String(p.checkoutRequestId).trim() : "";
    if (receipt || checkout) {
      const existing = readEntries();
      for (const e of existing) {
        if (receipt && e.mpesaReceipt && String(e.mpesaReceipt) === receipt) {
          return { ok: false, reason: "duplicate-receipt" };
        }
        if (!receipt && checkout && e.checkoutRequestId && String(e.checkoutRequestId) === checkout) {
          return { ok: false, reason: "duplicate-checkout" };
        }
      }
    }

    const entry = {
      id: crypto.randomUUID(),
      source: String(p.source || "unknown").slice(0, 40),
      amount,
      mpesaReceipt: receipt || null,
      checkoutRequestId: checkout || null,
      phone: p.phone ? String(p.phone).slice(0, 32) : null,
      accountRef: p.accountRef ? String(p.accountRef).slice(0, 80) : null,
      description: p.description ? String(p.description).slice(0, 200) : null,
      receivedAt: new Date().toISOString(),
    };
    appendEntryLine(JSON.stringify(entry) + "\n");
    return { ok: true, entry };
  } catch (err) {
    console.error("[wallet] credit() error:", err && err.message);
    return { ok: false, reason: "exception" };
  }
}

/**
 * Aggregate summary for the admin dashboard.
 * Never subtracts, never mutates, never forgets — this is the whole
 * point of the immortal wallet.
 */
function summary() {
  const entries = readEntries();
  const bySource = {};
  let total = 0;
  for (const e of entries) {
    const amt = Number(e.amount || 0);
    if (!(amt > 0)) continue;
    total += amt;
    const key = e.source || "unknown";
    bySource[key] = (bySource[key] || 0) + amt;
  }
  return {
    total,
    count: entries.length,
    bySource,
    firstReceivedAt: entries.length ? entries[0].receivedAt : null,
    lastReceivedAt:  entries.length ? entries[entries.length - 1].receivedAt : null,
    persistDirSet: Boolean(PERSIST_DIR),
  };
}

/** Return the ledger newest-first. Optional limit. */
function list(limit) {
  const entries = readEntries();
  entries.reverse();
  if (limit && limit > 0) return entries.slice(0, limit);
  return entries;
}

module.exports = { init, credit, summary, list };
