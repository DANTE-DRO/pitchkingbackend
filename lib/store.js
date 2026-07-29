// Tiny JSON-file "database". No external DB, no native modules — safe for Render.
//
// ─────────────────────────────────────────────────────────────
// Persistence fix (why raffles used to "disappear" on Render free tier):
//   Render's free web service has an EPHEMERAL filesystem. Every redeploy
//   OR container restart (which happens automatically after ~15 min idle
//   on free tier) wipes /opt/render/project/src/backend/data/*.json —
//   so any raffle "open" you created was silently lost.
//
//   This build fixes it by adding a second write target: whenever we save
//   a collection we ALSO save it to PERSIST_DIR if that env var is set
//   to a path on a Render Persistent Disk (or any writable persistent
//   location). On boot, if data/ is empty but PERSIST_DIR has snapshots,
//   we restore them. This is fully additive — if PERSIST_DIR is not set,
//   behaviour is exactly as before.
// ─────────────────────────────────────────────────────────────
const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
// If PERSIST_DIR is set (e.g. to a Render Persistent Disk mount like /var/data),
// we mirror every write there so restarts/redeploys don't wipe raffle data.
const PERSIST_DIR = process.env.PERSIST_DIR && String(process.env.PERSIST_DIR).trim()
  ? String(process.env.PERSIST_DIR).trim()
  : null;

function filePath(name) {
  return path.join(DATA_DIR, `${name}.json`);
}

function persistPath(name) {
  return PERSIST_DIR ? path.join(PERSIST_DIR, `${name}.json`) : null;
}

function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (PERSIST_DIR && !fs.existsSync(PERSIST_DIR)) {
    try { fs.mkdirSync(PERSIST_DIR, { recursive: true }); } catch (_) {}
  }
}

// If DATA_DIR file is missing/empty but PERSIST_DIR has a good snapshot, restore it.
function tryRestoreFromPersist(name) {
  if (!PERSIST_DIR) return false;
  try {
    const pp = persistPath(name);
    if (!pp || !fs.existsSync(pp)) return false;
    const raw = fs.readFileSync(pp, "utf-8");
    if (!raw || raw.trim() === "") return false;
    // sanity-parse
    JSON.parse(raw);
    fs.writeFileSync(filePath(name), raw);
    console.log(`[store] Restored "${name}" from persistent snapshot.`);
    return true;
  } catch (err) {
    console.warn(`[store] Could not restore "${name}" from persistent snapshot:`, err.message);
    return false;
  }
}

function ensureFile(name, defaultValue) {
  ensureDirs();
  const p = filePath(name);
  if (!fs.existsSync(p)) {
    // Try to restore first before writing an empty default — this is what
    // prevents "created raffles vanishing on redeploy".
    if (!tryRestoreFromPersist(name)) {
      fs.writeFileSync(p, JSON.stringify(defaultValue, null, 2));
    }
  }
}

function readAll(name) {
  ensureFile(name, []);
  const raw = fs.readFileSync(filePath(name), "utf-8");
  try {
    return JSON.parse(raw || "[]");
  } catch {
    return [];
  }
}

function writeAll(name, data) {
  ensureDirs();
  const json = JSON.stringify(data, null, 2);
  fs.writeFileSync(filePath(name), json);
  // Mirror to the persistent location so nothing is lost on restart / redeploy.
  if (PERSIST_DIR) {
    try {
      fs.writeFileSync(persistPath(name), json);
    } catch (err) {
      console.warn(`[store] Could not mirror "${name}" to PERSIST_DIR:`, err.message);
    }
  }
}

function insert(name, record) {
  const all = readAll(name);
  all.push(record);
  writeAll(name, all);
  return record;
}

function update(name, id, patch) {
  const all = readAll(name);
  const idx = all.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  all[idx] = { ...all[idx], ...patch };
  writeAll(name, all);
  return all[idx];
}

function findById(name, id) {
  return readAll(name).find((r) => r.id === id) || null;
}

function init() {
  ensureDirs();
  ensureFile("accounts", []);
  ensureFile("tickets", []);
  ensureFile("bets", []);
  ensureFile("challenges", []);
  ensureFile("wallets", []);
  ensureFile("admins", []);
  // Server-side tombstones — the operator's DELETE decisions,
  // persisted so they cannot be undone by any visitor's browser.
  ensureFile("tombstones", []);
  ensureFile("settings", [
    { id: "settings", winnerPercent: 88, platformPercent: 12, raffleCountdownDays: 7 },
  ]);

  // Additive migration: make sure raffleCountdownDays exists on old installs
  // without ever overwriting the admin's other settings.
  try {
    const rows = readAll("settings");
    if (rows[0] && rows[0].raffleCountdownDays === undefined) {
      rows[0].raffleCountdownDays = 7;
      writeAll("settings", rows);
    }
  } catch (_) {}

  if (PERSIST_DIR) {
    console.log(`[store] Persistent mirror enabled at: ${PERSIST_DIR}`);
  } else {
    console.log(`[store] PERSIST_DIR not set — running with ephemeral storage only.`);
  }
}

module.exports = { init, readAll, writeAll, insert, update, findById };
