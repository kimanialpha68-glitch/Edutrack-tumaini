/**
 * Tumaini Valley Springs Academy — Proxy + Cloud Sync Server
 * Render / Railway / Local
 *
 * Env vars needed on Render:
 *   MONGODB_URI  — your MongoDB Atlas connection string
 *   SYNC_SECRET  — any password you choose (protects your data)
 */

const express  = require('express');
const cors     = require('cors');
const fetch    = require('node-fetch');
const path     = require('path');
const { MongoClient } = require('mongodb');

const app  = express();
const PORT = process.env.PORT || 3000;

const MONGO_URI   = process.env.MONGODB_URI || null;
const SYNC_SECRET = process.env.SYNC_SECRET || 'edutrack-sync';
const DB_NAME     = 'edutrack';
const COLL_NAME   = 'schooldata';

let db = null;

async function connectMongo() {
  if (!MONGO_URI) { console.log('⚠️  MONGODB_URI not set — cloud sync disabled.'); return; }
  try {
    const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
    await client.connect();
    db = client.db(DB_NAME);
    console.log('✅ MongoDB Atlas connected.');
  } catch (e) { console.error('❌ MongoDB failed:', e.message); }
}
connectMongo();

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const rateLimitMap = new Map();
function rateLimit(req, res, next) {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  if (!rateLimitMap.has(ip)) { rateLimitMap.set(ip, { count:1, start:now }); return next(); }
  const d = rateLimitMap.get(ip);
  if (now - d.start > 60000) { rateLimitMap.set(ip, { count:1, start:now }); return next(); }
  if (d.count >= 100) return res.status(429).json({ error: 'Too many requests.' });
  d.count++; next();
}

function authSync(req, res, next) {
  const secret = req.headers['x-sync-secret'] || req.query.secret;
  if (secret !== SYNC_SECRET) return res.status(401).json({ error: 'Unauthorized.' });
  next();
}

app.get('/api/ping', (req, res) => res.json({
  ok: true, message: 'Tumaini Valley Springs Academy — online ✅',
  sync: db ? 'mongodb' : 'disabled', time: new Date().toISOString()
}));

// Load all school data
app.get('/api/sync', authSync, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Cloud sync not configured.' });
  try {
    const doc = await db.collection(COLL_NAME).findOne({ _id: 'main' });
    if (!doc) return res.json({ data: null });
    const { _id, ...data } = doc;
    res.json({ data, savedAt: doc.savedAt });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Save all school data
app.post('/api/sync', authSync, async (req, res) => {
  if (!db) return res.status(503).json({ error: 'Cloud sync not configured.' });
  const { data } = req.body;
  if (!data) return res.status(400).json({ error: 'Missing data.' });
  try {
    const savedAt = new Date().toISOString();
    await db.collection(COLL_NAME).replaceOne(
      { _id: 'main' }, { _id: 'main', ...data, savedAt }, { upsert: true }
    );
    res.json({ ok: true, savedAt });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/sms', rateLimit, async (req, res) => {
  const { apiKey, username, to, message, from } = req.body;
  if (!apiKey || !username || !to || !message)
    return res.status(400).json({ error: 'Missing fields.' });
  const sandbox = username === 'sandbox';
  const endpoint = sandbox
    ? 'https://api.sandbox.africastalking.com/version1/messaging'
    : 'https://api.africastalking.com/version1/messaging';
  const params = new URLSearchParams({ username, to, message });
  if (from && from.trim()) params.append('from', from.trim());
  try {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type':'application/x-www-form-urlencoded', apiKey, Accept:'application/json' },
      body: params.toString()
    });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
    console.log(`[SMS][${sandbox?'SANDBOX':'LIVE'}] → ${to} | ${r.status}`);
    res.status(r.status).json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/whatsapp', rateLimit, async (req, res) => {
  const { apiKey, username, to, message, from } = req.body;
  if (!apiKey || !username || !to || !message)
    return res.status(400).json({ error: 'Missing fields.' });
  const sandbox = username === 'sandbox';
  const endpoint = sandbox
    ? 'https://api.sandbox.africastalking.com/version1/messaging/whatsapp'
    : 'https://content.africastalking.com/version1/messaging/whatsapp';
  const params = new URLSearchParams({ username, to, message });
  if (from && from.trim()) params.append('from', from.trim());
  try {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type':'application/x-www-form-urlencoded', apiKey, Accept:'application/json' },
      body: params.toString()
    });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
    console.log(`[WA][${sandbox?'SANDBOX':'LIVE'}] → ${to} | ${r.status}`);
    res.status(r.status).json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.use((req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, '0.0.0.0', () => {
  const platform = process.env.RENDER ? 'Render'
    : process.env.RAILWAY_ENVIRONMENT ? 'Railway' : 'Local';
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║   Tumaini Valley Springs Academy — Sync Server         ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`\n  Platform : ${platform} | Port: ${PORT}`);
  console.log(`  Sync     : ${MONGO_URI ? 'MongoDB Atlas ✅' : 'Disabled ⚠️'}\n`);
});
