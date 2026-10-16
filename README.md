# Spin · PharmKulen

A mobile-friendly spin-the-wheel game for PharmKulen, with a separate, password-protected admin console.

- **Player game** at `/`: an app-style layout modelled on spinwheelify.com. It has a large flat wheel stage (tap the wheel or the Spin button), sound and full-screen controls, a side panel showing the player's **results** (with gift pictures and claim codes), how-to-play steps and a light/dark theme toggle. Full screen suits a shop-counter display. Results appear in a festive card with a hanging PharmKulen mascot and fireworks: a gold *Congratulations!* version with the claim code for gifts, and a blue *Thank you!* version for other outcomes.
- **Admin console** at `/admin`: dashboard, wheel and gift editor with a live preview, availability and schedule, branding text and password management.

You need Node.js 20 or newer. Run `npm install` once; the only dependency is `pg`, the PostgreSQL driver.

## Quick start

```bash
npm start            # http://localhost:3000  ·  admin: http://localhost:3000/admin
```

On first start the server creates `data/db.json` and prints a one-time **admin password** in the terminal. You can also choose the password yourself:

```bash
ADMIN_PASSWORD='choose-a-long-password' npm start
```

`ADMIN_PASSWORD` only takes effect when the admin account is first created. After that, change the password in **Admin → Security**. If it's forgotten, reset it with `node scripts/set-password.js` and restart the server.

Run the tests with `npm test`.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `DATABASE_URL` | — | PostgreSQL connection string. When set, everything is stored in Postgres; otherwise in `data/db.json` |
| `DATABASE_SSL` | auto | `1` to force TLS, `0` to turn it off. By default TLS is used for external hosts |
| `DATA_DIR` | `./data` | Where `db.json` and uploads are stored when there's no database |
| `ADMIN_PASSWORD` | random | Initial admin password (first run only) |
| `COOKIE_SECURE` | off | Set to `1` when served over HTTPS |
| `TRUST_PROXY` | off | Set to `1` behind a reverse proxy, so `X-Forwarded-*` headers are used |
| `TZ` | system | Time zone for "per day" limits and daily stats, e.g. `Asia/Phnom_Penh` |

For production, put it behind HTTPS (for example Caddy or nginx) and set `COOKIE_SECURE=1 TRUST_PROXY=1`. Render does this for you; see below.

## Deploying to Render (Docker + PostgreSQL)

The repo contains everything Render needs:

| File | Purpose |
|---|---|
| `Dockerfile` | Production image: Node 22 on Alpine, runs as a non-root user, health check on `/healthz` |
| `render.yaml` | Blueprint that creates the web service and connects it to an existing Render PostgreSQL database |
| `docker-compose.yml` | The same setup on your own computer: `docker compose up --build`, then http://localhost:3000 |
| `scripts/migrate-to-postgres.js` | Copies your local wheel, admin password, spins and images into a database |

**What's stored in PostgreSQL:** wheel settings, the admin account, every spin (with name and phone), uploaded gift images, and admin sign-ins. A Render restart, redeploy or sleep loses nothing. Tables are created automatically on first start.

**Steps**
1. Put the project in a **private** GitHub or GitLab repository. `data/` and `node_modules/` are git-ignored, so no customer data is uploaded.
2. In Render: **New → Blueprint**, choose the repo and click **Apply**. When asked, enter `DATABASE_URL` (the database's **Internal Database URL**; the web service must be in the same region as the database) and `ADMIN_PASSWORD` (only used the first time, to create the admin account).
3. *(Optional)* To bring over your current wheel, images, password and spins, copy the database's **External Database URL** from Render and run this on your computer:
   ```bash
   DATABASE_URL='postgres://…external URL…' node scripts/migrate-to-postgres.js --force
   ```
   Then restart the web service in Render (**Manual Deploy → Restart service**).
4. Open `https://<your-service>.onrender.com` for the game and `/admin` for staff.

**Plans and costs (please read).** `render.yaml` uses the **free** plans so you can try it at no cost, but:
- a free web service **sleeps after 15 minutes** without visitors, and the first visit afterwards takes about a minute;
- a **free database expires 30 days after it's created** and is **deleted 14 days later**, with no backups.

For a real event, change `plan:` in `render.yaml` to paid plans (for example web `0.5c-512mb`, database `0.1c-256mb`), or upgrade in the Render dashboard. Also export to Excel regularly.

Run **one** instance of the web service per database: the app keeps a working copy in memory.

## How the game works

- **The server decides every outcome.** It draws with `crypto.randomInt` using each segment's weight, and the wheel animates to the result it gets back. Players can't influence the result from the browser.
- **Segments are drawn equal-sized.** Weight sets the chance. Stock sets how many times a gift can be won; leave it blank for outcomes that never run out, like "Try Again".
- When a gift's stock reaches 0 it stays on the wheel marked **"All claimed"** and can't be landed on. A segment with weight 0 is marked **"Not in play"**. If nothing can be landed on, the game closes itself.
- Each gift result gets a **claim code** (for example `PK-7KD9QX`). Staff can search for the code on the dashboard and mark it as handed out.
- **Spins per device per day** is enforced with an HttpOnly cookie. It's a friendly limit, not a strong one: clearing cookies resets it. A per-IP limit (60 per minute) also stops scripted spinning.
- Chances are shown to staff in the admin **On the wheel** list, not on the player page. The footer note says plainly that gifts have no cash value and that no outcome is guaranteed. The admin editor warns you if a label or text mentions money or guarantees.

## Admin console

- **Player details:** with **Availability → Ask players for their name and phone number** switched on (the default), players fill in a short form before their first spin: name and phone number, with a short note on how the details are used. Each spin is saved with those details. The spin limit then counts per phone number (Admin → Availability → *Spins per player*, either **in total** or **per day**). With 1 spin in total, each name and phone plays once; the result window then shows **Next player**, and a used phone number is asked to enter different details. Details are never stored on the device; they're cleared after each result, so the next person always starts with an empty form.
- **Dashboard:** spins today and all time, gifts won and handed out, stock left, a 14-day chart (also available as a table), outcome and stock table with low-stock flags, recent spins with player name and phone, search by name, phone or claim code, **Export to Excel** (.xlsx with a *Spins* sheet and a *Summary* sheet) or CSV, and a statistics reset (you must type `RESET` to confirm).
- **Wheel & gifts:** add, duplicate, reorder and delete segments (2–16). Each segment can have an **image**: click Upload or drag a PNG, JPEG or WebP onto the thumbnail. It's resized in the browser to 320px, checked by file content on the server and stored in `DATA_DIR/uploads`. The image appears on the wheel slice, in the result pop-up and in the player's results. An **On the wheel** list beside the preview shows every segment with its picture and chance; click one to jump to it. For each one you can edit the label, player message, colour (logo palette or a custom colour), gift or message type, weight with a live % chance, and stock.
- **Style:** a gallery of 12 styles, each previewed with your own segments. Nine are wheels: Classic, Carnival lights, Soft pastel, Pharmacy mint, Ocean blend, Teal tones, Midnight glow, Gold celebration and Festival. **Lucky slots** is an arcade slot machine with three reels, a neon sign, a SPIN lamp and a *Gifts you could win* panel. All three reels stop on the server's result, so there are no fake near-misses. **Capsule machine** is a toy capsule machine: the knob turns, a capsule in the result's colour drops into the chute and pops open to show the gift. **Lucky drop** is a pachinko / Plinko board: a ball shoots up the side lane, bounces down through star pegs and lands in the slot of the result, with one slot per gift or outcome. There's also a *Surprise me* button. Styles change colours, rim, lights, pointer, hub and lettering; gifts, images, chances and stock are unaffected. Add or tweak styles in `public/js/styles.js`.
- **Availability:** an on/off switch, an optional opening and closing time, spins per device per day, the closed message and the "show chances" toggle.
- **Branding:** the title, tagline, Spin button label, how-to-play steps and footer note. The PharmKulen logo itself is fixed.
- **Security:** change the password. This signs out every other session.

Edits stay in a draft until you click **Save changes**. A sticky bar shows the unsaved, saving, saved and error states, and ⌘/Ctrl+S also saves. Validation errors are listed with links to the right tab. If another admin saved in the meantime, you're asked to reload instead of overwriting their changes. Stock that moved while you were editing is kept unless you changed that field yourself. **Test spin** in the preview uses your unsaved settings and isn't recorded.

## Security notes

- Passwords are hashed with scrypt. Session tokens are random and stored in an `HttpOnly; SameSite=Strict` cookie; the server keeps only a SHA-256 hash of each one. They expire after 8 hours of inactivity. With PostgreSQL, sign-ins survive restarts; with the local JSON file, a restart signs everyone out.
- Sign-in is limited to 8 attempts per 15 minutes per IP.
- State-changing requests must be JSON and same-origin. A strict Content-Security-Policy is applied (no inline scripts or styles), along with `X-Frame-Options: DENY`, `nosniff` and other headers. Admin pages are sent with `noindex`.
- Data is stored in PostgreSQL when `DATABASE_URL` is set (each spin and its stock change are saved in one transaction), otherwise in a JSON file written atomically. Either way, run a single server process.

## Project layout

```
server.js            HTTP server, API routes, static files
src/game.js          validation, availability, odds, weighted draw
src/auth.js          password hashing, sessions, rate limiting
src/storage/         postgres.js (production) and file.js (local JSON) backends
src/xlsx.js          Excel export writer
src/defaults.js      starter wheel + logo palette
public/              player game (index.html, js/app.js, css/game.css)
public/admin/        admin console (js/admin.js, css/admin.css)
public/js/wheel.js   shared SVG wheel used by both
public/assets/       PharmKulen logo and icon (cropped only, not resized or recoloured)
scripts/             set-password.js, migrate-to-postgres.js
Dockerfile, render.yaml, docker-compose.yml   hosting
test/                node:test suites
```
