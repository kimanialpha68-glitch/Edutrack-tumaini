/**
 * Tumaini Valley Springs — EduTrack Server v4
 * WebSocket sync + AI Composer + SMS/WhatsApp + Push Notifications
 *
 * Required env vars on Render:
 *   MONGODB_URI        — MongoDB Atlas connection string
 *   SYNC_SECRET        — Any password to protect sync
 *   GEMINI_API_KEY     — Google Gemini AI (for AI Message Composer)
 *   VAPID_PUBLIC_KEY   — BGrDmvlq-4UdRe3KciNtSC18JvoHFju-KgzzwAkFwUBrNBIafyrYLf9Yx1Vnd4NLQjmHUiov6aTbiPM8VY8y2Tg
 *   VAPID_PRIVATE_KEY  — q8t553rfS570qzHGnxpCppaFSPpKWgttXaqe503QGUs
 *   ADMIN_PHONE        — e.g. 254725347495 (no + or spaces)
 */

const express  = require('express');
const cors     = require('cors');
const compression = require('compression');
const fetch    = require('node-fetch');
const path     = require('path');
const http     = require('http');
const webpush  = require('web-push');
const { WebSocketServer } = require('ws');
const { MongoClient }     = require('mongodb');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server, perMessageDeflate: true });

const PORT          = process.env.PORT              || 3000;
const MONGO_URI     = process.env.MONGODB_URI       || null;
const SYNC_SECRET   = process.env.SYNC_SECRET       || 'edutrack-sync';
const GEMINI_KEY = process.env.GEMINI_API_KEY || null;
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY  || null;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || null;

let adminPhone = process.env.ADMIN_PHONE || '';
let db = null;

const DB_NAME   = 'edutrack';
const COLL_DATA = 'schooldata';
const COLL_SUBS = 'pushsubscriptions';
const COLL_CFG  = 'config';

// ── VAPID ─────────────────────────────────────────────────────────────────────
if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails('mailto:admin@tumainisprings.ac.ke', VAPID_PUBLIC, VAPID_PRIVATE);
}

// ── MongoDB ───────────────────────────────────────────────────────────────────
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
    startAlertScheduler();
  } catch (e) { console.error('❌ MongoDB failed:', e.message); }
}
connectMongo();

app.use(cors({ origin: '*' }));
app.use(compression()); // gzip all JSON/static responses — biggest single lever on bandwidth
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Rate limit ────────────────────────────────────────────────────────────────
const rlMap = new Map();
function rateLimit(req, res, next) {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'x';
  const now = Date.now();
  const d   = rlMap.get(ip) || { count: 0, start: now };
  if (now - d.start > 60000) { rlMap.set(ip, { count: 1, start: now }); return next(); }
  if (d.count >= 120) return res.status(429).json({ error: 'Too many requests' });
  d.count++; rlMap.set(ip, d); next();
}
function authSync(req, res, next) {
  const s = req.headers['x-sync-secret'] || req.query.secret;
  if (s !== SYNC_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
const clients = new Set();
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.searchParams.get('secret') !== SYNC_SECRET) { ws.close(4001, 'Unauthorized'); return; }
  clients.add(ws);
  if (db) {
    db.collection(COLL_DATA).findOne({ _id: 'main' }).then(doc => {
      if (doc && ws.readyState === ws.OPEN) {
        const { _id, ...data } = doc;
        ws.send(JSON.stringify({ type: 'snapshot', data, savedAt: doc.savedAt }));
      }
    }).catch(() => {});
  }
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
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
  await Promise.allSettled(subs.map(async (sub, i) => {
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
async function getATConfig() {
  if (!db) return null;
  try { const doc = await db.collection(COLL_DATA).findOne({ _id: 'main' }); return doc?.atConfig || null; } catch { return null; }
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

// Sync load
app.get('/api/sync', authSync, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'No database' });
  try {
    const doc = await db.collection(COLL_DATA).findOne({ _id: 'main' });
    if (!doc) return res.json({ data: null, savedAt: null });
    const { _id, ...data } = doc;
    res.json({ data, savedAt: doc.savedAt });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Sync save
app.post('/api/sync', authSync, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'No database' });
  const { data } = req.body;
  if (!data) return res.status(400).json({ error: 'Missing data' });
  try {
    const savedAt = new Date().toISOString();
    await db.collection(COLL_DATA).replaceOne({ _id: 'main' }, { _id: 'main', ...data, savedAt }, { upsert: true });
    res.json({ ok: true, savedAt });
    broadcast(data, savedAt);
    if (data.adminPhone) {
      adminPhone = data.adminPhone;
      db.collection(COLL_CFG).replaceOne({ _id: 'adminPhone' }, { _id: 'adminPhone', value: data.adminPhone }, { upsert: true }).catch(() => {});
    }
    setImmediate(() => runAlertCheck(data).catch(() => {}));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Reset all data
app.post('/api/reset', authSync, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'No database' });
  try {
    await db.collection(COLL_DATA).deleteOne({ _id: 'main' });
    broadcast({}, new Date().toISOString());
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Push: get VAPID public key
app.get('/api/push/vapid-public-key', (req, res) => {
  if (!VAPID_PUBLIC) return res.status(503).json({ error: 'VAPID not configured' });
  res.json({ key: VAPID_PUBLIC });
});

// Push: subscribe
app.post('/api/push/subscribe', authSync, async (req, res) => {
  if (!VAPID_PUBLIC || !db) return res.status(503).json({ error: 'Push not configured' });
  const { subscription, deviceLabel } = req.body;
  if (!subscription?.endpoint) return res.status(400).json({ error: 'Invalid subscription' });
  try {
    await db.collection(COLL_SUBS).replaceOne(
      { 'subscription.endpoint': subscription.endpoint },
      { subscription, deviceLabel: deviceLabel || 'Unknown', registeredAt: new Date().toISOString() },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Push: unsubscribe
app.post('/api/push/unsubscribe', authSync, async (req, res) => {
  const { endpoint } = req.body;
  if (!db || !endpoint) return res.status(400).json({ error: 'Missing endpoint' });
  try { await db.collection(COLL_SUBS).deleteOne({ 'subscription.endpoint': endpoint }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Push: test
app.post('/api/push/test', authSync, async (req, res) => {
  if (!VAPID_PUBLIC) return res.status(503).json({ error: 'Push not configured' });
  await sendPushToAll('✅ TVS EduTrack', 'Push notifications working! You will receive alerts for insurance, stock and logins.', 'tvs-test');
  res.json({ ok: true });
});

// Login notification
app.post('/api/notify/login', authSync, async (req, res) => {
  const { username, role, deviceHint } = req.body;
  const time = new Date().toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' });
  const msg  = `🔐 TVS Login: ${username} (${role}) at ${time}${deviceHint ? ' — ' + deviceHint : ''}`;
  await sendPushToAll('🔐 TVS Login', `${username} (${role}) signed in at ${time}`, 'tvs-login');
  if (adminPhone) { const atCfg = await getATConfig(); if (atCfg) await sendSMS(adminPhone, msg, atCfg); }
  res.json({ ok: true });
});

// Manual alert check
app.post('/api/notify/check', authSync, async (req, res) => {
  const { data } = req.body;
  const alerts = await runAlertCheck(data || {}).catch(e => []);
  res.json({ ok: true, alerts });
});

// AI Composer
app.post('/api/ai-compose', rateLimit, async (req, res) => {
  if (!GEMINI_KEY) return res.status(503).json({ error: 'Set GEMINI_API_KEY in environment variables.' });
  const { prompt, term, gradeContext } = req.body;
  if (!prompt?.trim()) return res.status(400).json({ error: 'Prompt required' });
  const ctx = [term ? `Term: ${term}.` : '', gradeContext ? `Audience: ${gradeContext}.` : ''].filter(Boolean).join(' ');
  const fullPrompt = `You write professional, warm school-to-parent SMS/WhatsApp messages for Tumaini Valley Springs Schools in Ruiru, Kenya. Respond ONLY with valid JSON (no markdown, no backticks): {"subject":"...","body":"...","type":"general"}. Types: fees,general,reopening,academic,transport,event. Use placeholders: {parent},{student},{grade},{term},{balance}.\n\n${ctx ? ctx + '\n\n' : ''}${prompt}`;
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: fullPrompt }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 500 }
        })
      }
    );
    const d = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: d.error?.message || 'Gemini AI failed' });
    const text = d.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
    res.json(parsed);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// SMS proxy
app.post('/api/sms', rateLimit, async (req, res) => {
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

// WhatsApp proxy
app.post('/api/whatsapp', rateLimit, async (req, res) => {
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
  console.log(`║  TVS EduTrack Server v4               ║`);
  console.log(`╚══════════════════════════════════════╝`);
  console.log(`  Port:  ${PORT}`);
  console.log(`  Sync:  ${MONGO_URI     ? '✅ MongoDB'  : '⚠️  No DB'}`);
  console.log(`  AI:    ${GEMINI_KEY ? '✅ Gemini' : '⚠️  No key (set GEMINI_API_KEY)'}`);
  console.log(`  Push:  ${VAPID_PUBLIC  ? '✅ Enabled'  : '⚠️  No VAPID'}`);
  console.log(`  SMS:   ${adminPhone    ? '✅ ' + adminPhone : '⚠️  No phone'}\n`);
});
