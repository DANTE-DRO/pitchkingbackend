// Tiny JSON-file "database". No external DB, no native modules — safe for Render.
const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");

function filePath(name) {
  return path.join(DATA_DIR, `${name}.json`);
}

function ensureFile(name, defaultValue) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const p = filePath(name);
  if (!fs.existsSync(p)) fs.writeFileSync(p, JSON.stringify(defaultValue, null, 2));
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
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(filePath(name), JSON.stringify(data, null, 2));
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
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  ensureFile("accounts", []);
  ensureFile("tickets", []);
  ensureFile("bets", []);
  ensureFile("challenges", []);
  ensureFile("wallets", []);
  ensureFile("admins", []);
  ensureFile("settings", [
    { id: "settings", winnerPercent: 80, platformPercent: 20 },
  ]);
}

module.exports = { init, readAll, writeAll, insert, update, findById };
