/**
 * Tumaini Valley Springs — EduTrack Server
 * Real-time sync + AI Composer + SMS/WhatsApp + Push Notifications
 *
 * Required env vars on Render:
 *   MONGODB_URI        — MongoDB Atlas connection string
 *   SYNC_SECRET        — Any password to protect sync
 *   ANTHROPIC_API_KEY  — For AI Message Composer
 *   VAPID_PUBLIC_KEY   — Web Push public key  (see deployment guide)
 *   VAPID_PRIVATE_KEY  — Web Push private key (see deployment guide)
 *   ADMIN_PHONE        — Admin phone e.g. 254725347495 (Safaricom format, no +)
 */

const express  = require('express');
const cors     = require('cors');
const fetch    = require('node-fetch');
const path     = require('path');
const http     = require('http');
const webpush  = require('web-push');
const { WebSocketServer } = require('ws');
const { MongoClient }     = require('mongodb');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocketServer({ server });

const PORT          = process.env.PORT           || 3000;
const MONGO_URI     = process.env.MONGODB_URI    || null;
const SYNC_SECRET   = process.env.SYNC_SECRET    || 'edutrack-sync';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || null;
const ADMIN_PHONE   = process.env.ADMIN_PHONE    || '';
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY  || null;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || null;

const DB_NAME   = 'edutrack';
const COLL_DATA = 'schooldata';
const COLL_SUBS = 'pushsubscriptions';
const COLL_CFG  = 'config';

let db = null;

// ── VAPID setup ───────────────────────────────────────────────────────────────
if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails('mailto:admin@tumainisprings.ac.ke', VAPID_PUBLIC, VAPID_PRIVATE);
  console.log('✅ Web Push VAPID ready.');
} else {
  console.warn('⚠️  VAPID keys not set — Web Push disabled.');
}

// ── MongoDB ───────────────────────────────────────────────────────────────────
async function connectMongo() {
  if (!MONGO_URI) { console.log('⚠️  MONGODB_URI not set — cloud sync disabled.'); return; }
  try {
    const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
    await client.connect();
    db = client.db(DB_NAME);
    console.log('✅ MongoDB Atlas connected.');
    // Load persisted admin phone from db config if not in env
    await loadAdminPhone();
    // Start periodic alert check
    startAlertScheduler();
  } catch (e) { console.error('❌ MongoDB failed:', e.message); }
}
connectMongo();

// ── Admin phone (env takes priority, fallback to db) ─────────────────────────
let adminPhone = ADMIN_PHONE;
async function loadAdminPhone() {
  if (adminPhone) return; // env var wins
  try {
    const cfg = await db.collection(COLL_CFG).findOne({ _id: 'adminPhone' });
    if (cfg) adminPhone = cfg.value;
  } catch {}
}

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Rate limiting ─────────────────────────────────────────────────────────────
const rateLimitMap = new Map();
function rateLimit(req, res, next) {
  const ip  = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  if (!rateLimitMap.has(ip)) { rateLimitMap.set(ip, { count: 1, start: now }); return next(); }
  const d = rateLimitMap.get(ip);
  if (now - d.start > 60000) { rateLimitMap.set(ip, { count: 1, start: now }); return next(); }
  if (d.count >= 120) return res.status(429).json({ error: 'Too many requests.' });
  d.count++;
  next();
}
function authSync(req, res, next) {
  const secret = req.headers['x-sync-secret'] || req.query.secret;
  if (secret !== SYNC_SECRET) return res.status(401).json({ error: 'Unauthorized.' });
  next();
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
const clients = new Set();
wss.on('connection', (ws, req) => {
  const url    = new URL(req.url, 'http://localhost');
  const secret = url.searchParams.get('secret');
  if (secret !== SYNC_SECRET) { ws.close(4001, 'Unauthorized'); return; }
  clients.add(ws);
  console.log(`[WS] Client connected (total: ${clients.size})`);
  if (db) {
    db.collection(COLL_DATA).findOne({ _id: 'main' }).then(doc => {
      if (doc && ws.readyState === ws.OPEN) {
        const { _id, ...data } = doc;
        ws.send(JSON.stringify({ type: 'snapshot', data, savedAt: doc.savedAt }));
      }
    }).catch(() => {});
  }
  ws.on('close', () => { clients.delete(ws); });
  ws.on('error', () => clients.delete(ws));
});
function broadcast(data, savedAt) {
  const payload = JSON.stringify({ type: 'update', data, savedAt });
  for (const client of clients) {
    if (client.readyState === client.OPEN) client.send(payload);
  }
}

// ── Push notification helpers ─────────────────────────────────────────────────
async function getPushSubs() {
  if (!db) return [];
  try { return await db.collection(COLL_SUBS).find({}).toArray(); } catch { return []; }
}
async function sendPushToAll(title, body, icon = '/icons/icon-192.png', tag = 'tvs-alert') {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return;
  const subs = await getPushSubs();
  const payload = JSON.stringify({ title, body, icon, tag, timestamp: Date.now() });
  const results = await Promise.allSettled(
    subs.map(sub => webpush.sendNotification(sub.subscription, payload))
  );
  // Remove expired subscriptions
  const dead = [];
  results.forEach((r, i) => {
    if (r.status === 'rejected' && (r.reason?.statusCode === 410 || r.reason?.statusCode === 404)) {
      dead.push(subs[i]._id);
    }
  });
  if (dead.length && db) {
    await db.collection(COLL_SUBS).deleteMany({ _id: { $in: dead } });
  }
  return results;
}

// ── SMS helper ────────────────────────────────────────────────────────────────
async function sendSMS(to, message, atConfig = {}) {
  const { apiKey, username = 'sandbox', shortCode } = atConfig;
  if (!apiKey || !to) return { ok: false, error: 'No API key or phone' };
  const sandbox  = username === 'sandbox';
  const endpoint = sandbox
    ? 'https://api.sandbox.africastalking.com/version1/messaging'
    : 'https://api.africastalking.com/version1/messaging';
  const params = new URLSearchParams({ username, to, message });
  if (shortCode && shortCode.trim()) params.append('from', shortCode.trim());
  try {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', apiKey, Accept: 'application/json' },
      body: params.toString()
    });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, data };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ── Load AT config from MongoDB ───────────────────────────────────────────────
async function getATConfig() {
  if (!db) return null;
  try {
    const doc = await db.collection(COLL_DATA).findOne({ _id: 'main' });
    return doc?.atConfig || null;
  } catch { return null; }
}

// ── Alert: check data for issues and notify ───────────────────────────────────
async function runAlertCheck(data) {
  if (!data) return;
  const alerts = [];
  const today  = new Date();

  // 1. Insurance expiry alerts
  if (data.vehicles && Array.isArray(data.vehicles)) {
    for (const v of data.vehicles) {
      if (!v.insuranceExpiry) continue;
      const days = Math.ceil((new Date(v.insuranceExpiry) - today) / (1000*60*60*24));
      if (days < 0) {
        alerts.push({ type:'insurance', level:'critical',
          msg:`🚫 INSURANCE EXPIRED: ${v.plate} (${v.make||''}) — expired ${-days} days ago` });
      } else if (days <= 7) {
        alerts.push({ type:'insurance', level:'urgent',
          msg:`⚠️ Insurance expires in ${days} day(s): ${v.plate} (${v.make||''}) — ${v.insuranceExpiry}` });
      } else if (days <= 30) {
        alerts.push({ type:'insurance', level:'warning',
          msg:`📋 Insurance due in ${days} days: ${v.plate} — ${v.insuranceExpiry}` });
      }
      // Inspection alerts
      if (v.inspectionExpiry) {
        const idays = Math.ceil((new Date(v.inspectionExpiry) - today) / (1000*60*60*24));
        if (idays < 0) {
          alerts.push({ type:'inspection', level:'critical',
            msg:`🚫 INSPECTION EXPIRED: ${v.plate} — expired ${-idays} days ago` });
        } else if (idays <= 14) {
          alerts.push({ type:'inspection', level:'warning',
            msg:`🔧 Inspection due in ${idays} days: ${v.plate} — ${v.inspectionExpiry}` });
        }
      }
    }
  }

  // 2. Low stock alerts
  if (data.inventory && Array.isArray(data.inventory)) {
    for (const item of data.inventory) {
      const qty = parseFloat(item.qty) || 0;
      const min = parseFloat(item.minQty) || 0;
      if (min > 0 && qty <= min) {
        alerts.push({ type:'stock', level: qty === 0 ? 'critical' : 'warning',
          msg:`📦 ${qty === 0 ? 'OUT OF STOCK' : 'Low stock'}: ${item.name} — ${qty} ${item.unit||''} remaining (min: ${min})` });
      }
    }
  }

  // 3. Fees — unpaid past 30 days
  if (data.fees && Array.isArray(data.fees)) {
    const overdue = data.fees.filter(f => {
      if (f.status === 'paid') return false;
      if (!f.date) return false;
      const daysPast = Math.ceil((today - new Date(f.date)) / (1000*60*60*24));
      return daysPast > 30;
    });
    if (overdue.length > 0) {
      alerts.push({ type:'fees', level:'warning',
        msg:`💰 ${overdue.length} fee record(s) unpaid for over 30 days` });
    }
  }

  if (alerts.length === 0) return;

  // Send push notification
  const criticals = alerts.filter(a => a.level === 'critical');
  const warnings  = alerts.filter(a => a.level !== 'critical');
  if (criticals.length > 0) {
    await sendPushToAll(
      '🚨 TVS EduTrack Alert',
      criticals.map(a => a.msg).join('\n'),
      '/icons/icon-192.png',
      'tvs-critical'
    );
  }
  if (warnings.length > 0) {
    await sendPushToAll(
      '⚠️ TVS EduTrack Notice',
      warnings.map(a => a.msg).join('\n'),
      '/icons/icon-192.png',
      'tvs-warning'
    );
  }

  // Send SMS to admin
  if (adminPhone) {
    const atCfg = await getATConfig();
    if (atCfg) {
      const smsBody = `TVS EduTrack Alerts:\n${alerts.map(a=>a.msg).join('\n').substring(0,160)}`;
      await sendSMS(adminPhone, smsBody, atCfg);
    }
  }

  console.log(`[ALERTS] Sent ${alerts.length} alert(s)`);
  return alerts;
}

// ── Hourly alert scheduler ────────────────────────────────────────────────────
function startAlertScheduler() {
  // Run immediately, then every hour
  setTimeout(async () => {
    try {
      const doc = await db.collection(COLL_DATA).findOne({ _id: 'main' });
      if (doc) {
        const { _id, savedAt, ...data } = doc;
        await runAlertCheck(data);
      }
    } catch (e) { console.error('[Scheduler]', e.message); }
  }, 10000); // 10s after startup

  setInterval(async () => {
    try {
      const doc = await db.collection(COLL_DATA).findOne({ _id: 'main' });
      if (doc) {
        const { _id, savedAt, ...data } = doc;
        await runAlertCheck(data);
      }
    } catch (e) { console.error('[Scheduler]', e.message); }
  }, 60 * 60 * 1000); // every hour
}

// ════════════════════════════════════════
// REST API
// ════════════════════════════════════════

app.get('/api/ping', (req, res) => res.json({
  ok: true,
  message: 'Tumaini Valley Springs — online ✅',
  sync:      db             ? 'mongodb ✅'        : 'disabled ⚠️',
  ai:        ANTHROPIC_KEY  ? 'enabled ✅'         : 'disabled ⚠️ (set ANTHROPIC_API_KEY)',
  push:      VAPID_PUBLIC   ? 'enabled ✅'         : 'disabled ⚠️ (set VAPID keys)',
  adminSMS:  adminPhone     ? `+${adminPhone} ✅`  : 'not set ⚠️ (set ADMIN_PHONE)',
  ws:        `${clients.size} device(s) connected`,
  time:      new Date().toISOString()
}));

// ── Cloud sync load ───────────────────────────────────────────────────────────
app.get('/api/sync', authSync, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Cloud sync not configured.' });
  try {
    const doc = await db.collection(COLL_DATA).findOne({ _id: 'main' });
    if (!doc) return res.json({ data: null, savedAt: null });
    const { _id, ...data } = doc;
    res.json({ data, savedAt: doc.savedAt });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Cloud sync save ───────────────────────────────────────────────────────────
app.post('/api/sync', authSync, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Cloud sync not configured.' });
  const { data } = req.body;
  if (!data) return res.status(400).json({ error: 'Missing data.' });
  try {
    const savedAt = new Date().toISOString();
    await db.collection(COLL_DATA).replaceOne(
      { _id: 'main' },
      { _id: 'main', ...data, savedAt },
      { upsert: true }
    );
    res.json({ ok: true, savedAt });
    broadcast(data, savedAt);
    // Save admin phone from data if present
    if (data.adminPhone) {
      adminPhone = data.adminPhone;
      db.collection(COLL_CFG).replaceOne({ _id: 'adminPhone' }, { _id: 'adminPhone', value: data.adminPhone }, { upsert: true }).catch(() => {});
    }
    // Run alert check asynchronously after save
    setImmediate(() => runAlertCheck(data).catch(() => {}));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Push subscription register ────────────────────────────────────────────────
app.post('/api/push/subscribe', authSync, async (req, res) => {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    return res.status(503).json({ error: 'Push not configured. Set VAPID keys on Render.' });
  }
  const { subscription, deviceLabel } = req.body;
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'Invalid subscription object.' });
  }
  if (!db) return res.status(503).json({ error: 'No database.' });
  try {
    await db.collection(COLL_SUBS).replaceOne(
      { 'subscription.endpoint': subscription.endpoint },
      { subscription, deviceLabel: deviceLabel || 'Unknown', registeredAt: new Date().toISOString() },
      { upsert: true }
    );
    console.log(`[Push] Subscribed: ${deviceLabel || 'Unknown'}`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Push unsubscribe ──────────────────────────────────────────────────────────
app.post('/api/push/unsubscribe', authSync, async (req, res) => {
  const { endpoint } = req.body;
  if (!db || !endpoint) return res.status(400).json({ error: 'Missing endpoint.' });
  try {
    await db.collection(COLL_SUBS).deleteOne({ 'subscription.endpoint': endpoint });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Push test ─────────────────────────────────────────────────────────────────
app.post('/api/push/test', authSync, async (req, res) => {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    return res.status(503).json({ error: 'Push not configured.' });
  }
  const results = await sendPushToAll(
    '✅ TVS EduTrack',
    'Push notifications are working! You will receive alerts for insurance, stock and logins.',
    '/icons/icon-192.png',
    'tvs-test'
  );
  res.json({ ok: true, sent: results?.length || 0 });
});

// ── Login notification ────────────────────────────────────────────────────────
app.post('/api/notify/login', authSync, async (req, res) => {
  const { username, role, deviceHint } = req.body;
  const time = new Date().toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' });
  const msg  = `🔐 TVS Login: ${username} (${role}) signed in at ${time}${deviceHint ? ' — ' + deviceHint : ''}`;

  // Push to all subscribed devices
  await sendPushToAll('🔐 TVS EduTrack Login', `${username} (${role}) signed in at ${time}`, '/icons/icon-192.png', 'tvs-login');

  // SMS to admin
  if (adminPhone) {
    const atCfg = await getATConfig();
    if (atCfg) await sendSMS(adminPhone, msg, atCfg);
  }

  console.log(`[Login] ${msg}`);
  res.json({ ok: true });
});

// ── Manual alert check (callable from app) ────────────────────────────────────
app.post('/api/notify/check', authSync, async (req, res) => {
  const { data } = req.body;
  const alerts = await runAlertCheck(data || null).catch(e => ({ error: e.message }));
  res.json({ ok: true, alerts: alerts || [] });
});

// ── Get VAPID public key (for SW registration) ────────────────────────────────
app.get('/api/push/vapid-public-key', (req, res) => {
  if (!VAPID_PUBLIC) return res.status(503).json({ error: 'VAPID not configured.' });
  res.json({ key: VAPID_PUBLIC });
});

// ── AI Composer proxy ─────────────────────────────────────────────────────────
app.post('/api/ai-compose', rateLimit, async (req, res) => {
  if (!ANTHROPIC_KEY) {
    return res.status(503).json({ error: 'AI Composer not configured. Set ANTHROPIC_API_KEY on Render.' });
  }
  const { prompt, term, gradeContext } = req.body;
  if (!prompt || !prompt.trim()) return res.status(400).json({ error: 'Prompt is required.' });
  const contextNote = [term ? `Current term: ${term}.` : '', gradeContext ? `Audience: ${gradeContext}.` : ''].filter(Boolean).join(' ');
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        system: `You write professional, warm school-to-parent SMS/WhatsApp messages for Tumaini Valley Springs in Ruiru, Kenya. Keep messages concise (under 160 chars for SMS). Respond ONLY as JSON with no markdown: {"subject":"...","body":"...","type":"general"}. Types: fees,general,reopening,academic,transport,event. Use placeholders: {parent},{student},{grade},{term},{balance}.`,
        messages: [{ role: 'user', content: contextNote ? `${contextNote}\n\n${prompt}` : prompt }]
      })
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data.error?.message || 'AI request failed.' });
    const text   = data.content?.find(c => c.type === 'text')?.text || '{}';
    const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
    res.json(parsed);
  } catch (e) { res.status(500).json({ error: 'AI generation failed: ' + e.message }); }
});

// ── SMS proxy ─────────────────────────────────────────────────────────────────
app.post('/api/sms', rateLimit, async (req, res) => {
  const { apiKey, username, to, message, from } = req.body;
  if (!apiKey || !username || !to || !message) return res.status(400).json({ error: 'Missing fields.' });
  const result = await sendSMS(to, message, { apiKey, username, shortCode: from });
  res.status(result.ok ? 200 : 500).json(result.data || { error: result.error });
});

// ── WhatsApp proxy ────────────────────────────────────────────────────────────
app.post('/api/whatsapp', rateLimit, async (req, res) => {
  const { apiKey, username, to, message, from } = req.body;
  if (!apiKey || !username || !to || !message) return res.status(400).json({ error: 'Missing fields.' });
  const sandbox  = username === 'sandbox';
  const endpoint = sandbox
    ? 'https://api.sandbox.africastalking.com/version1/messaging/whatsapp'
    : 'https://content.africastalking.com/version1/messaging/whatsapp';
  const params = new URLSearchParams({ username, to, message });
  if (from && from.trim()) params.append('from', from.trim());
  try {
    const r    = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', apiKey, Accept: 'application/json' }, body: params.toString() });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
    res.status(r.status).json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Reset all data (wipe cloud + broadcast) ───────────────────────────────────
app.post('/api/reset', authSync, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'No database.' });
  try {
    await db.collection(COLL_DATA).deleteOne({ _id: 'main' });
    broadcast({}, new Date().toISOString());
    console.log('[RESET] All school data wiped.');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.use((req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

server.listen(PORT, '0.0.0.0', () => {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║   Tumaini Valley Springs — EduTrack v4   ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`\n  Platform : ${process.env.RENDER ? 'Render' : process.env.RAILWAY_ENVIRONMENT ? 'Railway' : 'Local'} | Port: ${PORT}`);
  console.log(`  Sync     : ${MONGO_URI     ? 'MongoDB Atlas ✅' : 'Disabled ⚠️'}`);
  console.log(`  AI       : ${ANTHROPIC_KEY ? 'Enabled ✅'       : 'Disabled ⚠️'}`);
  console.log(`  Push     : ${VAPID_PUBLIC  ? 'Enabled ✅'       : 'Disabled ⚠️'}`);
  console.log(`  SMS admin: ${adminPhone    ? adminPhone + ' ✅' : 'Not set ⚠️'}\n`);
});
