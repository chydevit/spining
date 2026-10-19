# Spin

A mobile-friendly spin-the-wheel game that any business can set up for itself. People sign up, create one or more **companies**, and customise each company's own game, which its players play for free. PharmKulen is the first company.

| Page | Address | Who |
|---|---|---|
| Landing page with a live demo wheel | `/` | everyone (or set `HOME_COMPANY` to send `/` to one company's game) |
| Sign in / create an account | `/login`, `/signup` | everyone |
| **My companies**: create, rename and delete companies; profile and password | `/account` | signed-in users |
| A company's **player game** | `/c/<link>`, e.g. `/c/pharmkulen` | players |
| A company's **admin**: dashboard, wheel and gifts, style, availability, branding | `/c/<link>/admin` | that company's owner only |

- **Player game:** an app-style layout modelled on spinwheelify.com. It has a large wheel stage (tap the wheel or the Spin button), sound and full-screen controls, a side panel with the player's **results** (gift pictures and claim codes), how-to-play steps and a light/dark toggle. Results appear in a festive card: a gold *Congratulations!* version with the claim code for gifts, and a blue *Thank you!* version for other outcomes.
- **Each company is separate:** its own settings, gifts, images, styles, players, spin limits, dashboard and Excel export. Owners can only open their own companies' admin.
- **New companies** start with a ready-made wheel worded for them. Until they upload a logo, the game shows the Spin icon and the company name. PharmKulen keeps its own logo and pharmacy artwork.

You need Node.js 20 or newer. Run `npm install` once; the only dependency is `pg`, the PostgreSQL driver.

## Quick start

```bash
npm start            # http://localhost:3000  ·  create an account at http://localhost:3000/signup
```

Sign up, create a company, and you land in its admin. To start an empty install with the PharmKulen company already set up, give it a password for the owner account `admin@pharmkulen.local` (or `OWNER_EMAIL`):

```bash
ADMIN_PASSWORD='choose-a-long-password' npm start
```

A forgotten password can be reset from the command line: `node scripts/set-password.js you@example.com`, then restart the server.
Any account can also be promoted or assigned a role via: `node scripts/set-role.js you@example.com superadmin` (roles: `superadmin`, `admin`, `staff`, `user`).

**Upgrading from the single-company version** happens automatically on the first start. The existing game becomes the company **PharmKulen** at `/c/pharmkulen`, with all its settings, images and spins. It's owned by the account **`admin@pharmkulen.local`** (or `OWNER_EMAIL` if set) with the **Super Admin** role, and its password is the old admin password. Change the email in **My companies → Profile**. The local data file is backed up first as `data/db.json.v1-backup`. Old sign-ins are cleared, so sign in again once.

Run the tests with `npm test`.

## Roles & Super Admin

Spin features a multi-tiered role permission model:

| Role | Permissions |
|---|---|
| **Super Admin** (`superadmin`) | Full platform control. Access and customize any company's admin console, view and manage all users across the system, assign/change roles, reset user credentials, transfer company ownership, and view global statistics. |
| **Admin** (`admin`) | Standard company owner. Can create, customize, and manage their own companies, games, wheels, gifts, and limits. |
| **Staff** (`staff`) | Operational staff. Can view the dashboard, search spins, and mark prize claim codes as handed out. Restricted from altering wheel configurations or deleting companies. |
| **User** (`user`) | Standard account for players. |

Super admins can access the dedicated **Super Admin Console** from their Account page (`/account#super`).

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `DATABASE_URL` | — | PostgreSQL connection string. When set, everything is stored in Postgres; otherwise in `data/db.json` |
| `DATABASE_SSL` | auto | `1` to force TLS, `0` to turn it off. By default TLS is used for external hosts |
| `DATA_DIR` | `./data` | Where `db.json` and uploads are stored when there's no database |
| `ADMIN_PASSWORD` | — | On an **empty** install: create the PharmKulen company and its owner account with this password |
| `OWNER_EMAIL` | `admin@pharmkulen.local` | Email of that owner account (designated as Super Admin on empty install) |
| `SUPER_ADMIN_EMAIL` | — | Automatically assign the Super Admin role to this email address on startup |
| `HOME_COMPANY` | — | A company link (e.g. `pharmkulen`): `/` then opens that company's game instead of the landing page |
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
4. Open `https://<your-service>.onrender.com`: the landing page, where anyone can sign up. PharmKulen's game is at `/c/pharmkulen` (sign in as `admin@pharmkulen.local` with the old admin password to manage it). Set `HOME_COMPANY=pharmkulen` if old links to `/` should keep opening the PharmKulen game.

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
- **Branding:** the company's logo and icon (uploads), title, tagline, Spin button label, how-to-play steps and footer note.
- **Security:** change your account password (it's the same for all your companies). This signs out your other devices.

Edits stay in a draft until you click **Save changes**. A sticky bar shows the unsaved, saving, saved and error states, and ⌘/Ctrl+S also saves. Validation errors are listed with links to the right tab. If another admin saved in the meantime, you're asked to reload instead of overwriting their changes. Stock that moved while you were editing is kept unless you changed that field yourself. **Test spin** in the preview uses your unsaved settings and isn't recorded.

## Security notes

- Passwords are hashed with scrypt. Session tokens are random and stored in an `HttpOnly; SameSite=Strict` cookie; the server keeps only a SHA-256 hash of each one. They expire after 8 hours of inactivity. With PostgreSQL, sign-ins survive restarts; with the local JSON file, a restart signs everyone out.
- Sign-in is limited to 8 attempts per 15 minutes per IP, and new accounts to 10 per hour per IP. A failed sign-in never reveals whether an email has an account.
- Every admin request checks that the signed-in account owns that company; others get *403*. Uploaded images are tied to the company that uploaded them.
- State-changing requests must be JSON and same-origin. A strict Content-Security-Policy is applied (no inline scripts or styles), along with `X-Frame-Options: DENY`, `nosniff` and other headers. Admin pages are sent with `noindex`.
- Data is stored in PostgreSQL when `DATABASE_URL` is set (each spin and its stock change are saved in one transaction), otherwise in a JSON file written atomically. Either way, run a single server process.

## Project layout

```
server.js            HTTP server, API routes, static files
src/game.js          validation, availability, odds, weighted draw
src/auth.js          password hashing, sessions, rate limiting
src/tenancy.js       accounts and companies: validation, starter game, upgrade from one company
src/storage/         postgres.js (production) and file.js (local JSON) backends
src/xlsx.js          Excel export writer
src/defaults.js      starter wheel + logo palette
public/              player game (index.html, js/app.js, css/game.css)
public/admin/        a company's admin console (js/admin.js, css/admin.css)
public/home.html, login.html, account.html   landing, sign in / sign up, My companies (js/*.js, css/site.css)
public/js/wheel.js   shared SVG wheel used by both
public/assets/       PharmKulen logo and icon (cropped only, not resized or recoloured)
scripts/             set-password.js, migrate-to-postgres.js
Dockerfile, render.yaml, docker-compose.yml   hosting
test/                node:test suites
```
