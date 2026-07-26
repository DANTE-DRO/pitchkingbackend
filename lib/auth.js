const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const store = require("./store");

const sessions = new Map(); // token -> { username, createdAt }

function ensureDefaultAdmin() {
  const admins = store.readAll("admins");
  const username = process.env.ADMIN_USERNAME || "admin";
  const password = process.env.ADMIN_PASSWORD || "11hezron72";

  if (admins.length > 0) {
    // Keep the admin password in sync with the .env value on every boot,
    // so if you change ADMIN_PASSWORD in Render it takes effect on redeploy.
    const admin = admins[0];
    if (admin.username !== username || !bcrypt.compareSync(password, admin.passwordHash)) {
      store.update("admins", admin.id, {
        username,
        passwordHash: bcrypt.hashSync(password, 10),
      });
      console.log(`[auth] Admin credentials updated from environment variables.`);
    }
    return;
  }

  store.insert("admins", {
    id: crypto.randomUUID(),
    username,
    passwordHash: bcrypt.hashSync(password, 10),
    createdAt: new Date().toISOString(),
  });

  console.log(`[auth] Created default admin account "${username}".`);
}

function login(username, password) {
  const admins = store.readAll("admins");
  const admin = admins.find((a) => a.username === username);
  if (!admin) return null;
  if (!bcrypt.compareSync(password, admin.passwordHash)) return null;

  const token = crypto.randomBytes(24).toString("hex");
  sessions.set(token, { username, createdAt: Date.now() });
  return token;
}

function requireAdmin(req, res, next) {
  const token = req.headers["x-admin-token"];
  if (!token || !sessions.has(token)) {
    return res.status(401).json({ error: "Not authorised. Please log in again." });
  }
  next();
}

module.exports = { ensureDefaultAdmin, login, requireAdmin };
