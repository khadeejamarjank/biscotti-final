# Biscotti Cake Factory — Website

A premium, mobile-first website for Biscotti Cake Factory (Mathara, Calicut) with a
staff-editable menu, a Bake Room custom-order form, and a Node/Express backend.

```
biscotti-website/
├── frontend/         Static site (HTML/CSS/JS) — the customer-facing pages
├── backend/          Node/Express API + file storage for the menu & orders
└── README.md         This file
```

## Quick start (recommended — runs frontend + backend together)

```bash
cd backend
npm install
npm start
```

Then open **http://localhost:3000** — the backend serves the frontend for you,
so the menu editor, image uploads, and Bake Room requests all work fully.

The default staff login is **staff / biscotti2026**. Set different starting
values with environment variables before the very first run:

```bash
STAFF_USERNAME="yourname" STAFF_PASSWORD="your-new-password" npm start
```

Once staff mode is open, use **Change password** in the staff bar to update
the username/password from the site itself at any time — no redeploy needed.
That change is saved the same way the menu is (local file, or the connected
database on Vercel), so it persists and applies to everyone.

### "Forgot password?" (email reset)

The login screen has a **Forgot password?** link. To actually send the reset
email, set these environment variables (works with Gmail, SendGrid, Mailgun,
or any SMTP provider):

```bash
SMTP_HOST="smtp.gmail.com"
SMTP_PORT="587"
SMTP_USER="youraddress@gmail.com"
SMTP_PASS="your-app-password"    # for Gmail, use an App Password, not your normal one
EMAIL_FROM="youraddress@gmail.com"
```

Also set a registered email for staff to reset against — either
`STAFF_EMAIL="youraddress@gmail.com"` before the very first run, or set/update
it any time via **Change password** in the staff bar (it now has an email
field alongside the username/password).

Without SMTP configured, "Forgot password?" still works for local testing —
it prints and returns the reset link directly instead of emailing it (visible
in the server logs), so you can develop without setting up email. Once SMTP
env vars are set, real emails send and that dev fallback stops appearing.

Reset links expire after 30 minutes and can only be used once.

## Running the frontend on its own (no backend)

You can also just open `frontend/index.html` directly in a browser, or host the
`frontend` folder on any static host (Netlify, GitHub Pages, etc.). In that mode:

- The menu, slideshow, and Bake Room form all still work.
- Staff edits (adding/editing cakes, changing photos) are saved in that browser's
  local storage instead of the shared backend, so they won't sync across devices.
- The staff username/password check — and any password change made via
  **Change password** — happens in the browser's local storage instead of on a
  server, so it's specific to that one browser.

This is a convenient way to preview or demo the site, but for a real shop you'll
want the backend running so every device sees the same menu.

## How the menu data works

- `backend/data/menu.json` is the live menu the API reads and writes.
- `backend/data/menu.default.json` is a frozen copy of the original Biscotti menu
  (created automatically the first time the server runs). The "Reset menu to
  default" button in staff mode restores this file.
- `backend/data/orders.json` stores Bake Room custom-cake requests submitted
  through the form, along with any uploaded reference photo (saved under
  `backend/public/uploads/`).

## Photos

Every photo on the site (hero slideshow, menu tabs, Bake Room) is set up in two
layers:

1. A real photo URL (or an uploaded photo, once staff replace it).
2. An always-visible illustrated cake graphic underneath, matched to that cake's
   flavour, that only shows if the photo can't load for any reason (offline, a
   blocked network, a broken link). This means the site never shows a blank box.

Staff can replace any photo with their own via the pencil/photo icons in staff
mode — uploaded photos are embedded directly and always display correctly,
since no external network request is needed to show them.

## API reference

All endpoints are prefixed with `/api`.

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/menu` | — | Full menu (categories + products) |
| POST | `/staff/login` | — | `{ password }` → `{ token }` |
| POST | `/orders` | — | Bake Room submission (multipart form, optional `photo` file) |
| GET | `/orders` | staff | List Bake Room requests |
| PUT | `/categories/:id` | staff | Update `{ tagline, desc, image }` |
| POST | `/products/:catId` | staff | Add `{ n, p, t }` |
| PUT | `/products/:catId/:idx` | staff | Replace a cake at index |
| DELETE | `/products/:catId/:idx` | staff | Remove a cake |
| POST | `/reset` | staff | Restore the original default menu |

Staff-only endpoints require an `Authorization: Bearer <token>` header, using
the token returned by `/staff/login`.

## Deploying for real

### On a regular Node host (Render, Railway, a VPS, etc.)

1. Upload the whole `biscotti-website` folder.
2. `cd backend && npm install`
3. Set `STAFF_PASSWORD` and `PORT` environment variables as needed.
4. `npm start` (or run it under a process manager like `pm2`).

These hosts keep a normal, persistent filesystem, so `backend/data/menu.json`
just works — edits save straight to disk and survive restarts and redeploys.

### On Vercel

Vercel's serverless functions run on a **read-only, throwaway filesystem** —
writing to `menu.json` there does not persist between requests, so edits would
appear to save and then vanish on the next refresh. `vercel.json` is already
set up to route the whole site through `backend/server.js` as one function,
but you also need a real place to store edits:

1. Push/upload this folder to a Vercel project as usual.
2. In the Vercel dashboard → your project → **Storage** tab → **Create
   Database** → choose a **Redis** option (via Upstash, from the Marketplace)
   → **Connect** it to this project. Vercel injects the connection env vars
   automatically — no code changes needed.
3. Redeploy. Visit `/api/health` on your deployed URL — it should report
   `"storage":"vercel-kv"`. If it still says `"local-file"`, the Redis store
   isn't connected to this project/environment yet.
4. Edits made in staff mode now save to that Redis store, so they persist
   across refreshes, redeploys, and are the same for every visitor/device —
   not just saved to one browser's local storage.

Without step 2, the site still works, but falls back to saving edits only in
each visitor's own browser (same as running the frontend with no backend at
all — see below).
