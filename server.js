// PitchKing backend — Express server
// Fixes for previous Render deploy errors:
//   1) No native modules (no better-sqlite3) — pure JSON file storage.
//   2) Data folder is auto-created at boot, so "Cannot find module './data/universities'"
//      style errors cannot happen — we do not require any data file.
//   3) Admin panel is served from /public/admin as a public static site,
//      so it lives at https://<your-backend>.onrender.com/admin
//      and never needs to be hosted elsewhere.

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");

const store = require("./lib/store");
const { ensureDefaultAdmin } = require("./lib/auth");
const { handleCallback } = require("./lib/payment");

// Make absolutely sure required folders exist BEFORE anything else runs.
// This is the root cause of the "Cannot find module './data/xxx'" error
// from the deploy screenshot — the folder simply did not exist yet.
["data", "uploads", "public", path.join("public", "admin")].forEach((d) => {
  const p = path.join(__dirname, d);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});

store.init();
ensureDefaultAdmin();

// Safety net: one unexpected error should never take the whole site down.
process.on("unhandledRejection", (err) => {
  console.error("[unhandledRejection]", err);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
});

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// Uploaded raffle-account images
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// KCB Buni STK Push callback — KCB posts the final payment result here.
// This must respond 200 quickly; the actual result is routed back to
// whichever request is waiting on it inside lib/payment.js.
app.post("/callback", (req, res) => {
  try {
    handleCallback(req.body);
  } catch (err) {
    console.error("[KCB] Error handling callback:", err);
  }
  res.status(200).json({ ResultCode: 0, ResultDesc: "Callback received successfully" });
});

// API routes
app.use("/api", require("./routes/accounts"));
app.use("/api", require("./routes/raffle"));
app.use("/api", require("./routes/bets"));
app.use("/api", require("./routes/challenges"));
app.use("/api", require("./routes/admin"));

app.get("/api/health", (req, res) =>
  res.json({ ok: true, name: "PitchKing API", time: new Date().toISOString() })
);

// -------- Admin panel served publicly at /admin --------
// This is the "admin panel in a public folder" the user asked for.
// URL: https://pitchkingbackend.onrender.com/admin
const adminDir = path.join(__dirname, "public", "admin");
app.use("/admin", express.static(adminDir));
app.get("/admin", (req, res) => res.sendFile(path.join(adminDir, "login.html")));

// Friendly root
app.get("/", (req, res) => {
  res.type("html").send(`
    <!doctype html><meta charset="utf-8"/>
    <title>PitchKing API</title>
    <body style="font-family:Segoe UI,Roboto,Arial,sans-serif;background:#0a0f1e;color:#e6f0ff;padding:40px;">
      <h1 style="color:#00e5ff;">⚽ PitchKing Backend is running</h1>
      <p>API base: <code>/api</code></p>
      <p>Health check: <a style="color:#ffd400" href="/api/health">/api/health</a></p>
      <p>Admin panel: <a style="color:#ffd400" href="/admin">/admin</a></p>
    </body>
  `);
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`\nPitchKing backend running on port ${PORT}`);
  console.log(`Admin panel:  /admin`);
  console.log(`Health check: /api/health\n`);
});
