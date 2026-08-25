/**
 * Tumaini Valley Springs — EduTrack Server v5
 * WebSocket sync + AI Composer + SMS/WhatsApp + Push Notifications
 *
 * Required env vars on Render:
 *   MONGODB_URI        — MongoDB Atlas connection string
 *   SYNC_SECRET         — legacy device-pairing value (no longer sufficient for API access on its own)
 *   SESSION_SECRET      — long random string used to sign login session tokens (set this!)
 *   GEMINI_API_KEY      — Google Gemini AI (for AI Message Composer)
 *   VAPID_PUBLIC_KEY    — generate your own with `node scripts/generate-vapid.js` (see below) — DO NOT reuse any key that has ever appeared in source control or chat
 *   VAPID_PRIVATE_KEY   — see above
 *   ADMIN_PHONE         — e.g. 254725347495 (no + or spaces)
 *
 * SECURITY NOTE (v5): Authentication used to be entirely client-side (a PIN
 * checked in the browser) gated only by one shared secret known to every
 * device. That meant anyone with the secret had full admin rights regardless
 * of role, and the secret itself was being embedded in the client bundle at
 * build time — visible to anyone via view-source. v5 replaces this with
 * real server-verified accounts (scrypt-hashed PINs) and short-lived signed
 * session tokens. Every account must have its PIN changed on first login.
 * If your deploy pipeline substitutes a `__SYNC_SECRET__` value into the
 * built HTML, stop doing that — no secret should ever ship inside a file
 * served to the browser.
 */

const express  = require('express');
const cors     = require('cors');
const fetch    = require('node-fetch');
const path     = require('path');
const http     = require('http');
const crypto   = require('crypto');
const webpush  = require('web-push');
const { WebSocketServer } = require('ws');
const { MongoClient }     = require('mongodb');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

const PORT           = process.env.PORT              || 3000;
const MONGO_URI      = process.env.MONGODB_URI       || null;
const SYNC_SECRET    = process.env.SYNC_SECRET       || 'edutrack-sync';
const SESSION_SECRET = process.env.SESSION_SECRET    || SYNC_SECRET;
const GEMINI_KEY     = process.env.GEMINI_API_KEY    || null;
const VAPID_PUBLIC   = process.env.VAPID_PUBLIC_KEY  || null;
const VAPID_PRIVATE  = process.env.VAPID_PRIVATE_KEY || null;

if (!process.env.SESSION_SECRET) {
  console.warn('⚠️  SESSION_SECRET not set — falling back to SYNC_SECRET to sign login tokens. Set a dedicated SESSION_SECRET on Render.');
}

let adminPhone = process.env.ADMIN_PHONE || '';
let db = null;

const DB_NAME     = 'edutrack';
const COLL_DATA   = 'schooldata';
const COLL_SUBS   = 'pushsubscriptions';
const COLL_CFG    = 'config';
const COLL_ACCTS  = 'accounts';

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h

// ── VAPID ─────────────────────────────────────────────────────────────────────
if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails('mailto:admin@tumainisprings.ac.ke', VAPID_PUBLIC, VAPID_PRIVATE);
}

// ── Password hashing (scrypt, built into Node — no extra dependency) ──────────
function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pin), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPin(pin, stored) {
  if (!stored || typeof stored !== 'string' || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  try {
    const test = crypto.scryptSync(String(pin), salt, 64);
    const orig = Buffer.from(hash, 'hex');
    return test.length === orig.length && crypto.timingSafeEqual(test, orig);
  } catch { return false; }
}

// ── Session tokens (HMAC-signed, no extra dependency) ──────────────────────────
function b64url(input) { return Buffer.from(input).toString('base64url'); }
function signToken(payload) {
  const body = b64url(JSON.stringify(payload));
  const sig  = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  const sigBuf = Buffer.from(sig || '', 'base64url'), expBuf = Buffer.from(expected, 'base64url');
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch { return null; }
}
function authToken(roles) {
  return (req, res, next) => {
    const header = req.headers['authorization'] || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : (req.query.token || null);
    const payload = verifyToken(token);
    if (!payload) return res.status(401).json({ error: 'Unauthorized — please log in again' });
    if (roles && roles.length && !roles.includes(payload.role)) return res.status(403).json({ error: 'Forbidden for your role' });
    req.user = payload;
    next();
  };
}

// ── MongoDB ───────────────────────────────────────────────────────────────────
async function ensureDefaultAccounts() {
  if (!db) return;
  try {
    const count = await db.collection(COLL_ACCTS).countDocuments();
    if (count === 0) {
      const now = new Date().toISOString();
      await db.collection(COLL_ACCTS).insertMany([
        { _id: 'U1', username: 'admin',   pinHash: hashPin('1234'), role: 'admin',   name: 'Administrator', active: true, mustChangePin: true, createdAt: now },
        { _id: 'U2', username: 'teacher', pinHash: hashPin('5678'), role: 'teacher', name: 'Class Teacher',  active: true, mustChangePin: true, createdAt: now },
      ]);
      console.log('⚠️  Seeded default accounts (admin/1234, teacher/5678) — each MUST change its PIN on first login.');
    }
  } catch (e) { console.error('❌ Account seed check failed:', e.message); }
}

async function connectMongo() {
  if (!MONGO_URI) { console.log('⚠️  MONGODB_URI not set.'); return; }
  try {
    const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
    await client.connect();
    db = client.db(DB_NAME);
    console.log('✅ MongoDB Atlas connected.');
    if (!adminPhone) {
      const cfg = await db.collection(COLL_CFG).findOne({ _id: 'adminPhone' }).catch(() => null);
      if (cfg) adminPhone = cfg.value;
    }
    await ensureDefaultAccounts();
    startAlertScheduler();
  } catch (e) { console.error('❌ MongoDB failed:', e.message); }
}
connectMongo();

app.set('trust proxy', 1); // Render sits behind a proxy — needed for req.ip to reflect the real client
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Rate limit (keyed on the real client IP, not a spoofable header) ──────────
const rlMap = new Map();
function rateLimit(req, res, next) {
  const ip = req.ip || 'x';
  const now = Date.now();
  const d   = rlMap.get(ip) || { count: 0, start: now };
  if (now - d.start > 60000) { rlMap.set(ip, { count: 1, start: now }); return next(); }
  if (d.count >= 120) return res.status(429).json({ error: 'Too many requests' });
  d.count++; rlMap.set(ip, d); next();
}
// Tighter limit specifically for login attempts, keyed by IP + username
const loginAttempts = new Map();
function loginRateLimit(req, res, next) {
  const key = (req.ip || 'x') + ':' + String(req.body?.username || '').toLowerCase();
  const now = Date.now();
  const d = loginAttempts.get(key) || { count: 0, start: now };
  if (now - d.start > 300000) { loginAttempts.set(key, { count: 1, start: now }); return next(); }
  if (d.count >= 10) return res.status(429).json({ error: 'Too many login attempts — try again in a few minutes' });
  d.count++; loginAttempts.set(key, d); next();
}

// ── WebSocket (auth via first message, never via URL query string) ────────────
const clients = new Set();
wss.on('connection', (ws) => {
  let authed = false;
  const timer = setTimeout(() => { if (!authed) ws.close(4001, 'Unauthorized'); }, 5000);
  ws.once('message', (raw) => {
    clearTimeout(timer);
    let payload = null;
    try {
      const msg = JSON.parse(raw.toString());
      if (msg && msg.type === 'auth') payload = verifyToken(msg.token);
    } catch {}
    if (!payload) { ws.close(4001, 'Unauthorized'); return; }
    authed = true;
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
    if (db) {
      db.collection(COLL_DATA).findOne({ _id: 'main' }).then(doc => {
        if (doc && ws.readyState === ws.OPEN) {
          const { _id, ...data } = doc;
          ws.send(JSON.stringify({ type: 'snapshot', data, savedAt: doc.savedAt }));
        }
      }).catch(() => {});
    }
  });
});
function broadcast(data, savedAt) {
  const p = JSON.stringify({ type: 'update', data, savedAt });
  for (const c of clients) if (c.readyState === c.OPEN) c.send(p);
}

// ── Push helpers ──────────────────────────────────────────────────────────────
async function sendPushToAll(title, body, tag = 'tvs-alert') {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE || !db) return;
  const subs = await db.collection(COLL_SUBS).find({}).toArray().catch(() => []);
  const payload = JSON.stringify({ title, body, icon: '/icons/icon-192.png', tag });
  const dead = [];
  await Promise.allSettled(subs.map(async (sub) => {
    try { await webpush.sendNotification(sub.subscription, payload); }
    catch (e) { if (e.statusCode === 410 || e.statusCode === 404) dead.push(sub._id); }
  }));
  if (dead.length) await db.collection(COLL_SUBS).deleteMany({ _id: { $in: dead } }).catch(() => {});
}

// ── SMS helper ────────────────────────────────────────────────────────────────
async function sendSMS(to, message, cfg = {}) {
  const { apiKey, username = 'sandbox', shortCode } = cfg;
  if (!apiKey || !to) return;
  const sandbox  = username === 'sandbox';
  const endpoint = sandbox
    ? 'https://api.sandbox.africastalking.com/version1/messaging'
    : 'https://api.africastalking.com/version1/messaging';
  const params = new URLSearchParams({ username, to, message });
  if (shortCode) params.append('from', shortCode);
  try {
    await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', apiKey, Accept: 'application/json' }, body: params.toString() });
  } catch {}
}
// AT credentials now live only in a protected config doc — never in the
// shared schooldata document, and never broadcast to connected clients.
async function getATConfig() {
  if (!db) return null;
  try { const doc = await db.collection(COLL_CFG).findOne({ _id: 'atConfig' }); return doc?.value || null; } catch { return null; }
}

// ── Alert checks ──────────────────────────────────────────────────────────────
async function runAlertCheck(data) {
  if (!data) return [];
  const alerts = [];
  const today  = new Date();

  (data.vehicles || []).forEach(v => {
    if (v.insuranceExpiry) {
      const days = Math.ceil((new Date(v.insuranceExpiry) - today) / 86400000);
      if (days < 0)       alerts.push({ level: 'critical', msg: `🚫 Insurance EXPIRED: ${v.plate} — ${Math.abs(days)} days ago` });
      else if (days <= 7) alerts.push({ level: 'urgent',   msg: `⚠️ Insurance expires in ${days}d: ${v.plate} — ${v.insuranceExpiry}` });
      else if (days <= 30)alerts.push({ level: 'warning',  msg: `📋 Insurance due in ${days}d: ${v.plate}` });
    }
    if (v.inspectionExpiry) {
      const days = Math.ceil((new Date(v.inspectionExpiry) - today) / 86400000);
      if (days < 0)        alerts.push({ level: 'critical', msg: `🚫 Inspection EXPIRED: ${v.plate}` });
      else if (days <= 14) alerts.push({ level: 'warning',  msg: `🔧 Inspection due in ${days}d: ${v.plate}` });
    }
  });

  (data.inventory || []).forEach(item => {
    const qty = parseFloat(item.qty) || 0, min = parseFloat(item.minQty) || 0;
    if (min > 0 && qty <= min) alerts.push({ level: qty === 0 ? 'critical' : 'warning', msg: `📦 ${qty === 0 ? 'OUT OF STOCK' : 'Low stock'}: ${item.name} — ${qty} ${item.unit || ''} left` });
  });

  const overdue = (data.fees || []).filter(f => f.status !== 'paid' && f.date && Math.ceil((today - new Date(f.date)) / 86400000) > 30);
  if (overdue.length) alerts.push({ level: 'warning', msg: `💰 ${overdue.length} fee record(s) unpaid 30+ days` });

  if (alerts.length === 0) return alerts;

  const criticals = alerts.filter(a => a.level === 'critical');
  const warnings  = alerts.filter(a => a.level !== 'critical');

  if (criticals.length) await sendPushToAll('🚨 TVS EduTrack Alert', criticals.map(a => a.msg).join('\n'), 'tvs-critical');
  if (warnings.length)  await sendPushToAll('⚠️ TVS EduTrack Notice', warnings.map(a => a.msg).join('\n'), 'tvs-warning');

  if (adminPhone) {
    const atCfg = await getATConfig();
    if (atCfg) await sendSMS(adminPhone, `TVS Alerts:\n${alerts.map(a => a.msg).join('\n')}`.substring(0, 160), atCfg);
  }
  console.log(`[Alerts] ${alerts.length} alert(s) sent`);
  return alerts;
}

function startAlertScheduler() {
  setTimeout(async () => {
    const doc = await db.collection(COLL_DATA).findOne({ _id: 'main' }).catch(() => null);
    if (doc) { const { _id, savedAt, ...data } = doc; await runAlertCheck(data).catch(() => {}); }
  }, 15000);
  setInterval(async () => {
    const doc = await db.collection(COLL_DATA).findOne({ _id: 'main' }).catch(() => null);
    if (doc) { const { _id, savedAt, ...data } = doc; await runAlertCheck(data).catch(() => {}); }
  }, 3600000);
}

// ════════════════════════════════════════════
// ROUTES
// ════════════════════════════════════════════

app.get('/api/ping', (req, res) => res.json({
  ok: true, message: 'TVS EduTrack online ✅',
  sync:     db            ? 'mongodb ✅'       : 'disabled ⚠️',
  ai:       GEMINI_KEY ? 'enabled ✅ (Gemini)' : 'disabled ⚠️ (set GEMINI_API_KEY)',
  push:     VAPID_PUBLIC  ? 'enabled ✅'        : 'disabled ⚠️',
  adminSMS: adminPhone    ? `+${adminPhone} ✅` : 'not set ⚠️',
  ws:       `${clients.size} connected`,
  time:     new Date().toISOString()
}));

// ── Auth ────────────────────────────────────────────────────────────────────
app.post('/api/auth/login', loginRateLimit, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'No database' });
  const { username, pin } = req.body || {};
  if (!username || !pin) return res.status(400).json({ error: 'Username and PIN required' });
  try {
    const user = await db.collection(COLL_ACCTS).findOne({ username: String(username).trim().toLowerCase(), active: true });
    if (!user || !verifyPin(pin, user.pinHash)) return res.status(401).json({ error: 'Incorrect username or PIN' });
    const token = signToken({ id: user._id, username: user.username, role: user.role, name: user.name, exp: Date.now() + SESSION_TTL_MS });
    res.json({ ok: true, token, user: { id: user._id, username: user.username, role: user.role, name: user.name }, mustChangePin: !!user.mustChangePin });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/change-pin', authToken(), async (req, res) => {
  if (!db) return res.status(503).json({ error: 'No database' });
  const { newPin } = req.body || {};
  if (!newPin || String(newPin).trim().length < 4) return res.status(400).json({ error: 'PIN must be at least 4 characters' });
  try {
    await db.collection(COLL_ACCTS).updateOne({ _id: req.user.id }, { $set: { pinHash: hashPin(newPin), mustChangePin: false } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin: list / create / update accounts (PIN hashes are never returned)
app.get('/api/accounts', authToken(['admin']), async (req, res) => {
  if (!db) return res.status(503).json({ error: 'No database' });
  try {
    const list = await db.collection(COLL_ACCTS).find({}, { projection: { pinHash: 0 } }).toArray();
    res.json({ ok: true, accounts: list });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/accounts', authToken(['admin']), async (req, res) => {
  if (!db) return res.status(503).json({ error: 'No database' });
  const { id, username, pin, role, name, active } = req.body || {};
  if (!username || !role || !name) return res.status(400).json({ error: 'username, role and name are required' });
  if (!['admin', 'teacher', 'viewer'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  try {
    const _id = id || ('U' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
    const update = { username: String(username).trim().toLowerCase(), role, name, active: active !== false };
    if (pin) { update.pinHash = hashPin(pin); update.mustChangePin = true; }
    await db.collection(COLL_ACCTS).updateOne(
      { _id },
      { $set: update, $setOnInsert: { createdAt: new Date().toISOString() } },
      { upsert: true }
    );
    res.json({ ok: true, id: _id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/accounts/:id', authToken(['admin']), async (req, res) => {
  if (!db) return res.status(503).json({ error: 'No database' });
  if (req.params.id === req.user.id) return res.status(400).json({ error: "Can't delete your own account" });
  try {
    await db.collection(COLL_ACCTS).deleteOne({ _id: req.params.id });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Sync (now requires a real logged-in session, not just the shared secret) ──
app.get('/api/sync', authToken(), async (req, res) => {
  if (!db) return res.status(503).json({ error: 'No database' });
  try {
    const doc = await db.collection(COLL_DATA).findOne({ _id: 'main' });
    if (!doc) return res.json({ data: null, savedAt: null });
    const { _id, ...data } = doc;
    res.json({ data, savedAt: doc.savedAt });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sync', authToken(['admin', 'teacher']), async (req, res) => {
  if (!db) return res.status(503).json({ error: 'No database' });
  const { data } = req.body || {};
  if (!data || typeof data !== 'object' || Array.isArray(data)) return res.status(400).json({ error: 'Missing or invalid data' });
  // AT credentials must never live in the shared/broadcast document.
  const { atConfig, ...safeData } = data;
  try {
    const savedAt = new Date().toISOString();
    await db.collection(COLL_DATA).replaceOne({ _id: 'main' }, { _id: 'main', ...safeData, savedAt }, { upsert: true });
    res.json({ ok: true, savedAt });
    broadcast(safeData, savedAt);
    if (safeData.adminPhone) {
      adminPhone = safeData.adminPhone;
      db.collection(COLL_CFG).replaceOne({ _id: 'adminPhone' }, { _id: 'adminPhone', value: safeData.adminPhone }, { upsert: true }).catch(() => {});
    }
    if (atConfig && req.user.role === 'admin') {
      db.collection(COLL_CFG).replaceOne({ _id: 'atConfig' }, { _id: 'atConfig', value: atConfig }, { upsert: true }).catch(() => {});
    }
    setImmediate(() => runAlertCheck(safeData).catch(() => {}));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Admin-only: read/write the Africa's Talking credentials directly (never synced to all clients)
app.get('/api/at-config', authToken(['admin']), async (req, res) => {
  if (!db) return res.status(503).json({ error: 'No database' });
  try { res.json({ ok: true, config: await getATConfig() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/at-config', authToken(['admin']), async (req, res) => {
  if (!db) return res.status(503).json({ error: 'No database' });
  const { config } = req.body || {};
  if (!config || typeof config !== 'object') return res.status(400).json({ error: 'Missing config' });
  try {
    await db.collection(COLL_CFG).replaceOne({ _id: 'atConfig' }, { _id: 'atConfig', value: config }, { upsert: true });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Reset all data — admin only, requires explicit confirmation flag
app.post('/api/reset', authToken(['admin']), async (req, res) => {
  if (!db) return res.status(503).json({ error: 'No database' });
  if (req.body?.confirm !== true) return res.status(400).json({ error: 'Confirmation required' });
  try {
    await db.collection(COLL_DATA).deleteOne({ _id: 'main' });
    broadcast({}, new Date().toISOString());
    console.log(`[Reset] Data wiped by admin "${req.user.username}" at ${new Date().toISOString()}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Push: get VAPID public key (safe to expose — it's the public half)
app.get('/api/push/vapid-public-key', (req, res) => {
  if (!VAPID_PUBLIC) return res.status(503).json({ error: 'VAPID not configured' });
  res.json({ key: VAPID_PUBLIC });
});

// Push: subscribe / unsubscribe / test — all require a logged-in session
app.post('/api/push/subscribe', authToken(), async (req, res) => {
  if (!VAPID_PUBLIC || !db) return res.status(503).json({ error: 'Push not configured' });
  const { subscription, deviceLabel } = req.body;
  if (!subscription?.endpoint) return res.status(400).json({ error: 'Invalid subscription' });
  try {
    await db.collection(COLL_SUBS).replaceOne(
      { 'subscription.endpoint': subscription.endpoint },
      { subscription, deviceLabel: deviceLabel || 'Unknown', registeredAt: new Date().toISOString(), registeredBy: req.user.username },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/push/unsubscribe', authToken(), async (req, res) => {
  const { endpoint } = req.body;
  if (!db || !endpoint) return res.status(400).json({ error: 'Missing endpoint' });
  try { await db.collection(COLL_SUBS).deleteOne({ 'subscription.endpoint': endpoint }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/push/test', authToken(), async (req, res) => {
  if (!VAPID_PUBLIC) return res.status(503).json({ error: 'Push not configured' });
  await sendPushToAll('✅ TVS EduTrack', 'Push notifications working! You will receive alerts for insurance, stock and logins.', 'tvs-test');
  res.json({ ok: true });
});

// Login notification
app.post('/api/notify/login', authToken(), async (req, res) => {
  const { deviceHint } = req.body || {};
  const username = req.user.username, role = req.user.role;
  const time = new Date().toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' });
  const msg  = `🔐 TVS Login: ${username} (${role}) at ${time}${deviceHint ? ' — ' + deviceHint : ''}`;
  await sendPushToAll('🔐 TVS Login', `${username} (${role}) signed in at ${time}`, 'tvs-login');
  if (adminPhone) { const atCfg = await getATConfig(); if (atCfg) await sendSMS(adminPhone, msg, atCfg); }
  res.json({ ok: true });
});

// Manual alert check
app.post('/api/notify/check', authToken(), async (req, res) => {
  const { data } = req.body;
  const alerts = await runAlertCheck(data || {}).catch(() => []);
  res.json({ ok: true, alerts });
});

// AI Composer — requires login now (previously open to anyone on the internet)
app.post('/api/ai-compose', authToken(), rateLimit, async (req, res) => {
  if (!GEMINI_KEY) return res.status(503).json({ error: 'Set GEMINI_API_KEY on Render.' });
  const { prompt, term, gradeContext } = req.body;
  if (!prompt?.trim()) return res.status(400).json({ error: 'Prompt required' });
  const ctx = [term ? `Term: ${term}.` : '', gradeContext ? `Audience: ${gradeContext}.` : ''].filter(Boolean).join(' ');
  const fullPrompt = `You write professional, warm school-to-parent SMS/WhatsApp messages for Tumaini Valley Springs Schools in Ruiru, Kenya. Respond ONLY with valid JSON (no markdown, no backticks): {"subject":"...","body":"...","type":"general"}. Types: fees,general,reopening,academic,transport,event. Use placeholders: {parent},{student},{grade},{term},{balance},{due_date} — {balance} is the individual outstanding amount and {due_date} is when it is expected to be cleared, both filled in per-parent when the message is sent. For fee-related messages, include both {balance} and {due_date} naturally in the body, and greet with "Dear Parent," rather than {parent} (school policy for fee communications is to use a generic greeting, not the parent's name). For all other message types, {parent} is fine to use.\n\n${ctx ? ctx + '\n\n' : ''}${prompt}`;
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: fullPrompt }] }],
          generationConfig: {
            maxOutputTokens: 800,
            thinkingConfig: { thinkingLevel: 'minimal' } // simple text drafting — no deep reasoning needed
          }
        })
      }
    );
    const d = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: d.error?.message || 'Gemini AI failed' });
    const text = d.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    const cleaned = text.replace(/```json|```/g, '').trim();
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (jsonErr) {
      // Fallback: Gemini occasionally leaves an unescaped quote or line break inside
      // a field, which breaks strict JSON.parse. Pull subject/body/type out directly
      // instead of failing the whole request.
      const extract = key => {
        const m = cleaned.match(new RegExp('"' + key + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"'));
        return m ? m[1].replace(/\\n/g, ' ').replace(/\\"/g, '"') : null;
      };
      const body = extract('body');
      if (!body) return res.status(500).json({ error: 'AI returned malformed output — try rephrasing your prompt.' });
      parsed = { subject: extract('subject'), body, type: extract('type') || 'general' };
    }
    res.json(parsed);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// SMS proxy — requires login (previously an open relay usable by anyone with an AT key)
app.post('/api/sms', authToken(), rateLimit, async (req, res) => {
  const { apiKey, username, to, message, from } = req.body;
  if (!apiKey || !to || !message) return res.status(400).json({ error: 'Missing fields' });
  const sandbox  = username === 'sandbox';
  const endpoint = sandbox ? 'https://api.sandbox.africastalking.com/version1/messaging' : 'https://api.africastalking.com/version1/messaging';
  const params = new URLSearchParams({ username, to, message });
  if (from) params.append('from', from);
  try {
    const r = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', apiKey, Accept: 'application/json' }, body: params.toString() });
    const data = await r.json().catch(() => ({}));
    res.status(r.status).json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// WhatsApp proxy — requires login
app.post('/api/whatsapp', authToken(), rateLimit, async (req, res) => {
  const { apiKey, username, to, message, from } = req.body;
  if (!apiKey || !to || !message) return res.status(400).json({ error: 'Missing fields' });
  const sandbox  = username === 'sandbox';
  const endpoint = sandbox ? 'https://api.sandbox.africastalking.com/version1/messaging/whatsapp' : 'https://content.africastalking.com/version1/messaging/whatsapp';
  const params = new URLSearchParams({ username, to, message });
  if (from) params.append('from', from);
  try {
    const r = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', apiKey, Accept: 'application/json' }, body: params.toString() });
    const data = await r.text().then(t => { try { return JSON.parse(t); } catch { return { raw: t }; } });
    res.status(r.status).json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.use((req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║  TVS EduTrack Server v5               ║`);
  console.log(`╚══════════════════════════════════════╝`);
  console.log(`  Port:  ${PORT}`);
  console.log(`  Sync:  ${MONGO_URI     ? '✅ MongoDB'  : '⚠️  No DB'}`);
  console.log(`  AI:    ${GEMINI_KEY ? '✅ Gemini' : '⚠️  No key (set GEMINI_API_KEY)'}`);
  console.log(`  Push:  ${VAPID_PUBLIC  ? '✅ Enabled'  : '⚠️  No VAPID'}`);
  console.log(`  SMS:   ${adminPhone    ? '✅ ' + adminPhone : '⚠️  No phone'}\n`);
});
