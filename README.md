# EduTrack School Management System
### Remote Access — No Wi-Fi Restriction

Access from anywhere — phone, laptop, tablet — without same Wi-Fi.

---

## 🌍 Deploy to Railway (FREE — Recommended)

Railway gives a permanent public URL e.g. https://edutrack.railway.app
Anyone opens it on any device, anywhere in the world.

### Steps:

1. Create account at github.com (free)
2. Go to github.com/new → new repo called "edutrack" → Public
3. Upload ALL files from this folder to that repo
4. Go to railway.app → sign up with GitHub
5. Click "New Project" → "Deploy from GitHub repo" → select edutrack
6. Wait ~2 min for deploy → click Settings → Generate Domain
7. Share the URL with anyone — works on all devices globally

---

## 🌍 Deploy to Render (Also FREE)

1. render.com → sign up with GitHub
2. New Web Service → connect edutrack repo
3. Build Command: npm install
4. Start Command: node server.js
5. Plan: Free → Create Web Service
6. Get URL: https://edutrack.onrender.com

Note: Render free tier sleeps after 15 min idle (30s wake time).
Railway stays always-on — recommended.

---

## 💻 Run Locally (same Wi-Fi only)

  npm install
  node server.js

Open: http://localhost:3000

---

## ⚙️ Africa's Talking Setup

1. Sign up at africastalking.com
2. Dashboard → Settings → API Key → copy it
3. In app: Settings → AT Credentials → paste key → Save
4. Click Test SMS to verify

Sandbox mode (free): username = sandbox, no API key needed.

---

## 📁 Files

  server.js       - Proxy + web server
  package.json    - Dependencies
  railway.json    - Railway config
  Procfile        - Render/Heroku config
  public/
    index.html    - Full app
