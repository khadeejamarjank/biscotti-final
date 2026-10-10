/**
 * Biscotti Cake Factory — backend
 * A small Express server that:
 *  - Serves the static frontend (../frontend)
 *  - Exposes a JSON API for the menu (categories + products)
 *  - Protects write operations behind a staff password
 *  - Accepts Bake Room custom-cake requests (with an optional photo)
 *
 * Storage: see store.js. Uses local JSON files when run on your own
 * machine, and Vercel KV (if connected) when deployed on Vercel, so
 * edits actually persist there instead of vanishing on refresh.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const cors = require('cors');
const nodemailer = require('nodemailer');
const store = require('./store');

const PORT = process.env.PORT || 3000;
const STAFF_USERNAME_HINT = process.env.STAFF_USERNAME || 'staff';
const STAFF_PASSWORD_HINT = process.env.STAFF_PASSWORD || 'biscotti2026';

const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');
const IS_VERCEL = !!process.env.VERCEL;

// /uploads only works for local runs — Vercel's filesystem can't be
// written to, so custom-order photos there travel as data URLs instead.
if (!IS_VERCEL) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ---- outgoing email, for the "forgot password" reset link ----
// Configure via SMTP env vars (works with Gmail, SendGrid, Mailgun, etc.
// — for Gmail specifically, use an "App Password", not the normal one).
const SMTP_CONFIGURED = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
const mailer = SMTP_CONFIGURED ? nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT) || 587,
  secure: process.env.SMTP_SECURE === 'true',
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
}) : null;
const EMAIL_FROM = process.env.EMAIL_FROM || process.env.SMTP_USER || 'no-reply@biscotti.local';

// ---- very small in-memory session store for staff tokens ----
const sessions = new Map(); // token -> expiry timestamp
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

function issueToken() {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const expiry = token && sessions.get(token);
  if (!expiry || expiry < Date.now()) {
    return res.status(401).json({ error: 'Not authenticated. Please log in again.' });
  }
  next();
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' })); // generous, since photo edits arrive as base64 data URLs

const upload = multer({ storage: multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `order-${Date.now()}-${Math.round(Math.random() * 1e6)}${ext}`);
  },
}), limits: { fileSize: 10 * 1024 * 1024 } });

// ---------------- Public API ----------------

app.get('/api/menu', async (req, res) => {
  res.json(await store.getMenu());
});

app.post('/api/staff/login', async (req, res) => {
  const { username, password } = req.body || {};
  const auth = await store.getAuth();
  if (username === auth.username && password === auth.password) {
    return res.json({ token: issueToken() });
  }
  res.status(401).json({ error: 'Incorrect username or password' });
});

app.post('/api/staff/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newUsername, newPassword, newEmail } = req.body || {};
  const auth = await store.getAuth();
  if (currentPassword !== auth.password) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  if (!newPassword || newPassword.length < 4) {
    return res.status(400).json({ error: 'New password must be at least 4 characters' });
  }
  const updated = {
    username: (newUsername && newUsername.trim()) || auth.username,
    password: newPassword,
    email: (newEmail && newEmail.trim()) || auth.email || '',
  };
  await store.saveAuth(updated);
  res.json({ ok: true, username: updated.username, email: updated.email });
});

app.get('/api/staff/me', requireAuth, async (req, res) => {
  const auth = await store.getAuth();
  res.json({ username: auth.username, email: auth.email || '' });
});

const RESET_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 minutes, single-use

app.post('/api/staff/forgot-password', async (req, res) => {
  const { email } = req.body || {};
  const auth = await store.getAuth();
  const matches = auth.email && email && auth.email.trim().toLowerCase() === email.trim().toLowerCase();

  // Always respond the same way whether or not the email matched, so this
  // endpoint can't be used to check which email address is registered.
  const genericResponse = { ok: true, message: "If that email is registered, we've sent a reset link to it." };

  if (!matches) return res.json(genericResponse);

  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await store.saveResetToken({ tokenHash, expiresAt: Date.now() + RESET_TOKEN_TTL_MS });

  const origin = `${req.protocol}://${req.get('host')}`;
  const resetUrl = `${origin}/?resetToken=${token}`;

  if (mailer) {
    try {
      await mailer.sendMail({
        from: EMAIL_FROM,
        to: auth.email,
        subject: 'Reset your Biscotti staff password',
        text: `Someone requested a password reset for the Biscotti staff login.\n\nReset it here (link expires in 30 minutes, and works once):\n${resetUrl}\n\nIf you didn't request this, you can ignore this email.`,
        html: `<p>Someone requested a password reset for the Biscotti staff login.</p><p><a href="${resetUrl}">Click here to reset your password</a> (link expires in 30 minutes, and works once).</p><p>If you didn't request this, you can ignore this email.</p>`,
      });
    } catch (err) {
      console.error('Failed to send password reset email:', err);
      // Don't leak the failure to the client — still respond generically.
    }
    return res.json(genericResponse);
  }

  // No SMTP configured (e.g. local dev): can't actually send an email, so
  // return the link directly as a dev convenience. Never do this once SMTP
  // is set up — see the mailer branch above for the real flow.
  console.log(`[dev] No SMTP configured — password reset link: ${resetUrl}`);
  return res.json({ ...genericResponse, devResetUrl: resetUrl });
});

app.post('/api/staff/reset-password', async (req, res) => {
  const { token, newPassword } = req.body || {};
  if (!token || !newPassword || newPassword.length < 4) {
    return res.status(400).json({ error: 'A valid token and a new password (4+ characters) are required' });
  }
  const record = await store.getResetToken();
  if (!record || Date.now() > record.expiresAt) {
    return res.status(400).json({ error: 'This reset link is invalid or has expired. Please request a new one.' });
  }
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const providedBuf = Buffer.from(tokenHash, 'hex');
  const storedBuf = Buffer.from(record.tokenHash, 'hex');
  const valid = providedBuf.length === storedBuf.length && crypto.timingSafeEqual(providedBuf, storedBuf);
  if (!valid) {
    return res.status(400).json({ error: 'This reset link is invalid or has expired. Please request a new one.' });
  }

  const auth = await store.getAuth();
  await store.saveAuth({ ...auth, password: newPassword });
  await store.clearResetToken(); // single-use: gone after one successful reset
  res.json({ ok: true });
});

app.post('/api/orders', upload.single('photo'), async (req, res) => {
  const orders = await store.getOrders();
  const order = {
    id: Date.now(),
    receivedAt: new Date().toISOString(),
    name: req.body.name || '',
    phone: req.body.phone || '',
    occasion: req.body.occasion || '',
    date: req.body.date || '',
    size: req.body.size || '',
    flavour: req.body.flavour || '',
    details: req.body.details || '',
    photoUrl: req.file ? `/uploads/${req.file.filename}` : null,
  };
  orders.unshift(order);
  await store.saveOrders(orders);
  res.json({ ok: true, order });
});

// ---------------- Staff-only API ----------------

app.get('/api/orders', requireAuth, async (req, res) => {
  res.json(await store.getOrders());
});

app.put('/api/categories/:id', requireAuth, async (req, res) => {
  const menu = await store.getMenu();
  const cat = menu.categories.find(c => c.id === req.params.id);
  if (!cat) return res.status(404).json({ error: 'Collection not found' });
  const { tagline, desc, image } = req.body || {};
  if (typeof tagline === 'string' && tagline) cat.tagline = tagline;
  if (typeof desc === 'string' && desc) cat.desc = desc;
  if (typeof image === 'string' && image) cat.image = image;
  await store.saveMenu(menu);
  res.json({ ok: true, category: cat });
});

app.post('/api/products/:catId', requireAuth, async (req, res) => {
  const menu = await store.getMenu();
  const { catId } = req.params;
  if (!menu.products[catId]) return res.status(404).json({ error: 'Collection not found' });
  const { n, p, t, img } = req.body || {};
  if (!n || typeof p !== 'number') return res.status(400).json({ error: 'Name and price are required' });
  const item = { n, p, t: Array.isArray(t) ? t : [] };
  if (typeof img === 'string' && img) item.img = img;
  menu.products[catId].push(item);
  await store.saveMenu(menu);
  res.json({ ok: true });
});

app.put('/api/products/:catId/:idx', requireAuth, async (req, res) => {
  const menu = await store.getMenu();
  const { catId, idx } = req.params;
  const list = menu.products[catId];
  if (!list || !list[idx]) return res.status(404).json({ error: 'Cake not found' });
  const { n, p, t, img } = req.body || {};
  if (!n || typeof p !== 'number') return res.status(400).json({ error: 'Name and price are required' });
  const item = { n, p, t: Array.isArray(t) ? t : [] };
  if (typeof img === 'string' && img) item.img = img;
  else if (list[idx].img) item.img = list[idx].img;
  list[idx] = item;
  await store.saveMenu(menu);
  res.json({ ok: true });
});

app.delete('/api/products/:catId/:idx', requireAuth, async (req, res) => {
  const menu = await store.getMenu();
  const { catId, idx } = req.params;
  const list = menu.products[catId];
  if (!list || !list[idx]) return res.status(404).json({ error: 'Cake not found' });
  list.splice(idx, 1);
  await store.saveMenu(menu);
  res.json({ ok: true });
});

app.post('/api/gallery', requireAuth, async (req, res) => {
  const menu = await store.getMenu();
  const { image } = req.body || {};
  if (typeof image !== 'string' || !image) return res.status(400).json({ error: 'Photo is required' });
  if (!Array.isArray(menu.gallery)) menu.gallery = [];
  menu.gallery.push(image);
  await store.saveMenu(menu);
  res.json({ ok: true });
});

app.delete('/api/gallery/:idx', requireAuth, async (req, res) => {
  const menu = await store.getMenu();
  const { idx } = req.params;
  if (!Array.isArray(menu.gallery) || !menu.gallery[idx]) return res.status(404).json({ error: 'Photo not found' });
  menu.gallery.splice(idx, 1);
  await store.saveMenu(menu);
  res.json({ ok: true });
});

app.post('/api/reset', requireAuth, async (req, res) => {
  await store.resetMenu();
  res.json({ ok: true });
});

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    storage: store.USE_KV ? 'vercel-kv' : 'local-file',
    envVarFound: store.USE_KV ? 'connected' : null,
  });
});

// ---------------- Static files ----------------
if (!IS_VERCEL) app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.static(FRONTEND_DIR));

if (!IS_VERCEL) {
  app.listen(PORT, () => {
    console.log(`Biscotti server running: http://localhost:${PORT}`);
    console.log(`Staff login: ${STAFF_USERNAME_HINT} / ${STAFF_PASSWORD_HINT} (unless already changed in staff mode; also settable via STAFF_USERNAME / STAFF_PASSWORD env vars before first run)`);
    console.log(`Storage: ${store.USE_KV ? 'Vercel KV' : 'local JSON file'}`);
  });
}

// Vercel's Node runtime imports this file and calls it as a request
// handler — exporting the Express app is all that's needed for that.
module.exports = app;
