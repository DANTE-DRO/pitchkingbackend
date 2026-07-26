/**
 * DevaBlueForex Backend Server
 * Pure JS storage (lowdb) — no native compilation required.
 * Render.com deploy-safe (no better-sqlite3 / node-gyp).
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');

const app = express();
const PORT = process.env.PORT || 10000;
const JWT_SECRET = process.env.JWT_SECRET || 'devablueforex_secret_2026';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '11devablue72';

// ---------- DATA STORE ----------
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const adapter = new FileSync(path.join(DATA_DIR, 'db.json'));
const db = low(adapter);

db.defaults({
  users: [],
  signals: [],
  courses: [],
  bookings: [],
  payments: [],
  testimonials: [],
  announcements: [],
  sessions: [],
  loginLogs: []
}).write();

// Seed default courses if empty
if (db.get('courses').size().value() === 0) {
  db.set('courses', [
    {
      id: uuidv4(),
      title: 'Master Sniper Entry',
      subtitle: 'The complete system for precision market entries',
      price: 299,
      features: ['48-Page Comprehensive Guide', 'Institutional Entry Models', 'Lifetime Access', 'Private Community', 'Weekly Live Sessions'],
      badge: 'BESTSELLER',
      icon: '🎯'
    },
    {
      id: uuidv4(),
      title: 'In-Person Masterclass',
      subtitle: 'Learn the exact trading systems used by Deva Blue',
      price: 500,
      features: ['Hands-on training', 'Direct mentorship', 'Networking opportunities', 'Certificate of completion', 'Lifetime replays'],
      badge: 'PREMIUM',
      icon: '💎'
    },
    {
      id: uuidv4(),
      title: 'Session Booking',
      subtitle: 'Flexible 1-hour sessions for strategy tuning',
      price: 50,
      features: ['Flexible scheduling', 'Live chart analysis', 'Personalized guidance', 'Recording provided', '7-day follow-up'],
      badge: 'FLEXIBLE',
      icon: '📊'
    },
    {
      id: uuidv4(),
      title: 'VIP Signal Membership',
      subtitle: 'Real-time premium signals delivered to your device',
      price: 149,
      features: ['Daily signals', '85%+ accuracy', 'Risk management', 'Telegram + WhatsApp alerts', 'Monthly performance report'],
      badge: 'HOT',
      icon: '⚡'
    }
  ]).write();
}

if (db.get('signals').size().value() === 0) {
  db.set('signals', [
    { id: uuidv4(), pair: 'XAU/USD', direction: 'BUY', entry: 2385.50, sl: 2380.00, tp: 2400.00, status: 'ACTIVE', posted: new Date().toISOString(), analyst: 'Deva Blue' },
    { id: uuidv4(), pair: 'EUR/USD', direction: 'SELL', entry: 1.0854, sl: 1.0880, tp: 1.0800, status: 'ACTIVE', posted: new Date().toISOString(), analyst: 'Deva Blue' },
    { id: uuidv4(), pair: 'GBP/JPY', direction: 'BUY', entry: 198.45, sl: 197.80, tp: 199.80, status: 'HIT TP', posted: new Date(Date.now() - 86400000).toISOString(), analyst: 'Deva Blue' }
  ]).write();
}

if (db.get('testimonials').size().value() === 0) {
  db.set('testimonials', [
    { id: uuidv4(), name: 'Michael K.', text: 'DevaBlueForex changed my trading forever. The sniper entries are surgical.', rating: 5, posted: new Date().toISOString() },
    { id: uuidv4(), name: 'Sarah L.', text: 'From losing streaks to consistent profits in 3 months. Deva is the real deal.', rating: 5, posted: new Date().toISOString() },
    { id: uuidv4(), name: 'James O.', text: 'The mentorship is worth 10x the price. Best investment of my life.', rating: 5, posted: new Date().toISOString() }
  ]).write();
}

// ---------- MIDDLEWARE ----------
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));
app.use(compression());
app.use(morgan('tiny'));
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true });
const apiLimiter = rateLimit({ windowMs: 60 * 1000, max: 120 });
app.use('/api/', apiLimiter);

// ---------- AUTH HELPERS ----------
function signToken(user) {
  return jwt.sign({ id: user.id, email: user.email, role: user.role || 'user' }, JWT_SECRET, { expiresIn: '7d' });
}

function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function adminRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No admin token' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
    req.admin = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid admin token' });
  }
}

// ---------- HEALTH ----------
app.get('/', (req, res) => res.json({ status: 'DevaBlueForex API running', version: '1.0.0', time: new Date().toISOString() }));
app.get('/api/health', (req, res) => res.json({ ok: true, service: 'devablueforex-backend', uptime: process.uptime() }));

// ---------- AUTH ROUTES ----------
app.post('/api/auth/register', authLimiter, async (req, res) => {
  try {
    const { name, email, password, phone } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Missing required fields' });
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const exists = db.get('users').find({ email: email.toLowerCase() }).value();
    if (exists) return res.status(409).json({ error: 'Email already registered' });

    const hash = await bcrypt.hash(password, 10);
    const user = {
      id: uuidv4(),
      name,
      email: email.toLowerCase(),
      phone: phone || '',
      password: hash,
      role: 'user',
      verified: true,
      createdAt: new Date().toISOString(),
      balance: 0,
      subscription: null
    };
    db.get('users').push(user).write();
    db.get('loginLogs').push({ id: uuidv4(), userId: user.id, email: user.email, action: 'register', at: new Date().toISOString(), ip: req.ip }).write();

    const token = signToken(user);
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const user = db.get('users').find({ email: email.toLowerCase() }).value();
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    db.get('loginLogs').push({ id: uuidv4(), userId: user.id, email: user.email, action: 'login', at: new Date().toISOString(), ip: req.ip }).write();

    const token = signToken(user);
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role, phone: user.phone, balance: user.balance, subscription: user.subscription } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
});

app.post('/api/auth/logout', authRequired, (req, res) => {
  db.get('loginLogs').push({ id: uuidv4(), userId: req.user.id, email: req.user.email, action: 'logout', at: new Date().toISOString(), ip: req.ip }).write();
  res.json({ ok: true, message: 'Logged out' });
});

app.get('/api/auth/me', authRequired, (req, res) => {
  const user = db.get('users').find({ id: req.user.id }).value();
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { password, ...safe } = user;
  res.json({ user: safe });
});

app.post('/api/auth/refresh', authRequired, (req, res) => {
  const user = db.get('users').find({ id: req.user.id }).value();
  if (!user) return res.status(404).json({ error: 'User not found' });
  const token = signToken(user);
  res.json({ token });
});

// ---------- PUBLIC DATA ----------
app.get('/api/courses', (req, res) => res.json(db.get('courses').value()));
app.get('/api/testimonials', (req, res) => res.json(db.get('testimonials').value()));
app.get('/api/announcements', (req, res) => res.json(db.get('announcements').value()));

app.get('/api/signals', authRequired, (req, res) => {
  res.json(db.get('signals').orderBy('posted', 'desc').value());
});

// Public preview (limited)
app.get('/api/signals/preview', (req, res) => {
  const preview = db.get('signals').take(2).value().map(s => ({ pair: s.pair, direction: s.direction, status: s.status, posted: s.posted }));
  res.json(preview);
});

// ---------- BOOKINGS ----------
app.post('/api/bookings', authRequired, (req, res) => {
  const { courseId, date, notes } = req.body;
  const course = db.get('courses').find({ id: courseId }).value();
  if (!course) return res.status(404).json({ error: 'Course not found' });

  const booking = {
    id: uuidv4(),
    userId: req.user.id,
    userEmail: req.user.email,
    courseId,
    courseTitle: course.title,
    price: course.price,
    date: date || new Date().toISOString(),
    notes: notes || '',
    status: 'PENDING',
    createdAt: new Date().toISOString()
  };
  db.get('bookings').push(booking).write();
  res.json({ ok: true, booking });
});

app.get('/api/bookings/mine', authRequired, (req, res) => {
  const list = db.get('bookings').filter({ userId: req.user.id }).orderBy('createdAt', 'desc').value();
  res.json(list);
});

// ---------- PAYMENTS ----------
app.post('/api/payments', authRequired, (req, res) => {
  const { amount, method, reference, courseId } = req.body;
  const payment = {
    id: uuidv4(),
    userId: req.user.id,
    userEmail: req.user.email,
    amount,
    method: method || 'M-Pesa',
    reference: reference || '',
    courseId: courseId || null,
    status: 'PENDING',
    createdAt: new Date().toISOString()
  };
  db.get('payments').push(payment).write();
  res.json({ ok: true, payment });
});

app.get('/api/payments/mine', authRequired, (req, res) => {
  const list = db.get('payments').filter({ userId: req.user.id }).orderBy('createdAt', 'desc').value();
  res.json(list);
});

// ---------- MARKET DATA (mock live) ----------
app.get('/api/market/live', (req, res) => {
  const rand = (base, range) => (base + (Math.random() - 0.5) * range).toFixed(4);
  res.json([
    { pair: 'EUR/USD', bid: rand(1.0850, 0.005), ask: rand(1.0852, 0.005), change: (Math.random() * 2 - 1).toFixed(2) + '%' },
    { pair: 'GBP/USD', bid: rand(1.2745, 0.008), ask: rand(1.2747, 0.008), change: (Math.random() * 2 - 1).toFixed(2) + '%' },
    { pair: 'XAU/USD', bid: rand(2385.5, 5), ask: rand(2385.9, 5), change: (Math.random() * 2 - 1).toFixed(2) + '%' },
    { pair: 'USD/JPY', bid: rand(154.32, 0.5), ask: rand(154.34, 0.5), change: (Math.random() * 2 - 1).toFixed(2) + '%' },
    { pair: 'BTC/USD', bid: rand(68450, 500), ask: rand(68470, 500), change: (Math.random() * 4 - 2).toFixed(2) + '%' }
  ]);
});

// ---------- ADMIN AUTH ----------
app.post('/api/admin/login', authLimiter, (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password required' });
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Invalid admin password' });
  const token = jwt.sign({ id: 'admin-root', email: 'admin@devablueforex.com', role: 'admin' }, JWT_SECRET, { expiresIn: '12h' });
  db.get('loginLogs').push({ id: uuidv4(), userId: 'admin-root', email: 'admin', action: 'admin-login', at: new Date().toISOString(), ip: req.ip }).write();
  res.json({ token, admin: true });
});

// ---------- ADMIN ROUTES ----------
app.get('/api/admin/stats', adminRequired, (req, res) => {
  res.json({
    users: db.get('users').size().value(),
    signals: db.get('signals').size().value(),
    bookings: db.get('bookings').size().value(),
    payments: db.get('payments').size().value(),
    revenue: db.get('payments').filter({ status: 'CONFIRMED' }).map('amount').value().reduce((a, b) => a + b, 0),
    logins24h: db.get('loginLogs').filter(l => (Date.now() - new Date(l.at).getTime()) < 86400000).size().value()
  });
});

app.get('/api/admin/users', adminRequired, (req, res) => {
  const users = db.get('users').value().map(({ password, ...u }) => u);
  res.json(users);
});

app.delete('/api/admin/users/:id', adminRequired, (req, res) => {
  db.get('users').remove({ id: req.params.id }).write();
  res.json({ ok: true });
});

app.get('/api/admin/signals', adminRequired, (req, res) => res.json(db.get('signals').value()));
app.post('/api/admin/signals', adminRequired, (req, res) => {
  const signal = { id: uuidv4(), ...req.body, posted: new Date().toISOString() };
  db.get('signals').push(signal).write();
  res.json(signal);
});
app.put('/api/admin/signals/:id', adminRequired, (req, res) => {
  db.get('signals').find({ id: req.params.id }).assign(req.body).write();
  res.json({ ok: true });
});
app.delete('/api/admin/signals/:id', adminRequired, (req, res) => {
  db.get('signals').remove({ id: req.params.id }).write();
  res.json({ ok: true });
});

app.get('/api/admin/courses', adminRequired, (req, res) => res.json(db.get('courses').value()));
app.post('/api/admin/courses', adminRequired, (req, res) => {
  const course = { id: uuidv4(), ...req.body };
  db.get('courses').push(course).write();
  res.json(course);
});
app.put('/api/admin/courses/:id', adminRequired, (req, res) => {
  db.get('courses').find({ id: req.params.id }).assign(req.body).write();
  res.json({ ok: true });
});
app.delete('/api/admin/courses/:id', adminRequired, (req, res) => {
  db.get('courses').remove({ id: req.params.id }).write();
  res.json({ ok: true });
});

app.get('/api/admin/bookings', adminRequired, (req, res) => res.json(db.get('bookings').orderBy('createdAt', 'desc').value()));
app.put('/api/admin/bookings/:id', adminRequired, (req, res) => {
  db.get('bookings').find({ id: req.params.id }).assign(req.body).write();
  res.json({ ok: true });
});

app.get('/api/admin/payments', adminRequired, (req, res) => res.json(db.get('payments').orderBy('createdAt', 'desc').value()));
app.put('/api/admin/payments/:id', adminRequired, (req, res) => {
  db.get('payments').find({ id: req.params.id }).assign(req.body).write();
  res.json({ ok: true });
});

app.get('/api/admin/testimonials', adminRequired, (req, res) => res.json(db.get('testimonials').value()));
app.post('/api/admin/testimonials', adminRequired, (req, res) => {
  const t = { id: uuidv4(), ...req.body, posted: new Date().toISOString() };
  db.get('testimonials').push(t).write();
  res.json(t);
});
app.delete('/api/admin/testimonials/:id', adminRequired, (req, res) => {
  db.get('testimonials').remove({ id: req.params.id }).write();
  res.json({ ok: true });
});

app.get('/api/admin/announcements', adminRequired, (req, res) => res.json(db.get('announcements').value()));
app.post('/api/admin/announcements', adminRequired, (req, res) => {
  const a = { id: uuidv4(), ...req.body, posted: new Date().toISOString() };
  db.get('announcements').push(a).write();
  res.json(a);
});
app.delete('/api/admin/announcements/:id', adminRequired, (req, res) => {
  db.get('announcements').remove({ id: req.params.id }).write();
  res.json({ ok: true });
});

app.get('/api/admin/logs', adminRequired, (req, res) => {
  res.json(db.get('loginLogs').orderBy('at', 'desc').take(200).value());
});

// ---------- ERROR HANDLER ----------
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`✅ DevaBlueForex backend running on port ${PORT}`);
  console.log(`   Admin password: ${ADMIN_PASSWORD}`);
});
