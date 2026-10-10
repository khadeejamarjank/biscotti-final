/**
 * Storage layer for the Biscotti menu + orders.
 *
 * Locally (npm start on your own machine) this just reads/writes the
 * JSON files under ./data — simple, no setup needed.
 *
 * On Vercel, the deployed filesystem is read-only and thrown away
 * between requests, so writing to a JSON file there silently does NOT
 * persist (this is why edits used to "disappear on refresh"). When a
 * Redis store (Upstash, via the Vercel Marketplace) is connected to
 * the project, Vercel injects a REST URL/token pair as env vars — the
 * exact variable names depend on which "custom prefix" was chosen
 * when connecting it in the dashboard, so detectRedisCredentials()
 * below scans for any matching pair rather than requiring one exact
 * name. Once found, the menu + orders are stored there, which DOES
 * persist.
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const MENU_FILE = path.join(DATA_DIR, 'menu.json');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const DEFAULT_MENU_FILE = path.join(DATA_DIR, 'menu.default.json');

function detectRedisCredentials(env) {
  // Known, exact names first (fastest path, and the documented ones).
  const exact = [
    ['KV_REST_API_URL', 'KV_REST_API_TOKEN'],
    ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'],
  ];
  for (const [u, t] of exact) {
    if (env[u] && env[t]) return { url: env[u], token: env[t] };
  }
  // Fallback: whatever custom prefix was picked when connecting the
  // database (e.g. "STORAGE" -> STORAGE_KV_REST_API_URL / _TOKEN), find
  // any *_REST_API_URL key with a matching *_REST_API_TOKEN sibling.
  const urlKey = Object.keys(env).find(k => k.endsWith('REST_API_URL') && env[k]);
  if (urlKey) {
    const tokenKey = urlKey.replace(/URL$/, 'TOKEN');
    if (env[tokenKey]) return { url: env[urlKey], token: env[tokenKey] };
  }
  return null;
}

const REDIS_CREDS = detectRedisCredentials(process.env);
const USE_KV = !!REDIS_CREDS;

let kv = null;
if (USE_KV) {
  // Lazy require so local dev without the package/env vars never touches this.
  const { Redis } = require('@upstash/redis');
  kv = new Redis({ url: REDIS_CREDS.url, token: REDIS_CREDS.token });
}

function readLocalJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return fallback; }
}
function writeLocalJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

const DEFAULT_MENU = readLocalJSON(DEFAULT_MENU_FILE, { categories: [], products: {}, gallery: [] });

async function getMenu() {
  if (USE_KV) {
    const menu = await kv.get('biscotti:menu');
    if (menu) return menu;
    await kv.set('biscotti:menu', DEFAULT_MENU); // first run — seed it
    return DEFAULT_MENU;
  }
  return readLocalJSON(MENU_FILE, DEFAULT_MENU);
}

async function saveMenu(menu) {
  if (USE_KV) { await kv.set('biscotti:menu', menu); return; }
  writeLocalJSON(MENU_FILE, menu);
}

async function resetMenu() {
  if (USE_KV) { await kv.set('biscotti:menu', DEFAULT_MENU); return; }
  writeLocalJSON(MENU_FILE, DEFAULT_MENU);
}

async function getOrders() {
  if (USE_KV) return (await kv.get('biscotti:orders')) || [];
  return readLocalJSON(ORDERS_FILE, []);
}

async function saveOrders(orders) {
  if (USE_KV) { await kv.set('biscotti:orders', orders); return; }
  writeLocalJSON(ORDERS_FILE, orders);
}

/* ---- staff credentials (username + password + recovery email) ---- */
const AUTH_FILE = path.join(DATA_DIR, 'auth.json');
const DEFAULT_AUTH = {
  username: process.env.STAFF_USERNAME || 'staff',
  password: process.env.STAFF_PASSWORD || 'biscotti2026',
  email: process.env.STAFF_EMAIL || '',
};

async function getAuth() {
  if (USE_KV) return (await kv.get('biscotti:auth')) || DEFAULT_AUTH;
  return readLocalJSON(AUTH_FILE, DEFAULT_AUTH);
}

async function saveAuth(auth) {
  if (USE_KV) { await kv.set('biscotti:auth', auth); return; }
  writeLocalJSON(AUTH_FILE, auth);
}

/* ---- password reset tokens: single-use, expiring ---- */
const RESET_FILE = path.join(DATA_DIR, 'reset.json');

async function getResetToken() {
  if (USE_KV) return (await kv.get('biscotti:reset')) || null;
  return readLocalJSON(RESET_FILE, null);
}

async function saveResetToken(record) {
  if (USE_KV) { await kv.set('biscotti:reset', record); return; }
  writeLocalJSON(RESET_FILE, record);
}

async function clearResetToken() {
  if (USE_KV) { await kv.del('biscotti:reset'); return; }
  try { fs.unlinkSync(RESET_FILE); } catch (e) { /* already gone, fine */ }
}

module.exports = {
  getMenu, saveMenu, resetMenu, getOrders, saveOrders,
  getAuth, saveAuth, getResetToken, saveResetToken, clearResetToken,
  USE_KV, REDIS_CREDS,
};
