# Deployment Guide: Production Deployment on Render & Railway

TableToken is built with a lightweight, high-performance stack: **Node.js + Express + SQLite (WAL mode) + SSE**.

Because SQLite stores all data in a single file (`tabletoken.db`), production deployments must use a **Persistent Disk (Volume)** to prevent data from being wiped during redeployments or container restarts.

---

## 1. Deploying on Render (Recommended)

Render offers persistent disks on web services and automatic HTTPS.

### Step 1: Create a Render Web Service
1. Push your TableToken repository to your GitHub or GitLab account.
2. Log into [Render Dashboard](https://dashboard.render.com).
3. Click **New +** &rarr; **Web Service**.
4. Connect your TableToken repository.
5. Configure the following fields:
   - **Name**: `tabletoken-restaurant` (or your restaurant's name)
   - **Environment**: `Node`
   - **Region**: Choose the region closest to your restaurant (e.g., `Singapore` or `Frankfurt`).
   - **Branch**: `main`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: `Starter` (Persistent disks require a paid tier starting at \$7/mo).

### Step 2: Attach a Persistent Disk
1. Scroll down to **Disks** &rarr; **Add Disk**.
2. Set:
   - **Name**: `tabletoken-data`
   - **Mount Path**: `/data`
   - **Size**: `1 GB` (More than enough for years of restaurant orders).
3. Click **Save Disk**.

### Step 3: Add Environment Variables
Under the **Environment** tab, add the following key-value pairs:

| Variable | Value | Description |
| :--- | :--- | :--- |
| `NODE_ENV` | `production` | Enables production cookie flags and optimizations |
| `PORT` | `10000` | Port automatically assigned by Render |
| `SESSION_SECRET` | `generate-a-strong-32-char-random-string` | Secret key used to sign session cookies |
| `DB_PATH` | `/data/tabletoken.db` | Points to the persistent disk mount path |
| `BASE_URL` | `https://tabletoken-restaurant.onrender.com` | Your public Render HTTPS URL (used in table QR codes) |

### Step 4: Deploy & Set Up Master Account
1. Click **Create Web Service**.
2. Once the build finishes and status displays **Live**, visit:
   `https://tabletoken-restaurant.onrender.com`
3. You will be redirected to the one-time owner setup screen (`/owner/setup`).
4. Enter your restaurant name, manager full name, mobile number, and password.
5. In the dashboard, click the **🔲 Table QR Codes** tab &rarr; **Print QR Codes** to print placards for your dining tables!

---

## 2. Deploying on Railway

Railway supports persistent volumes with zero setup.

### Step 1: Create a Railway Project
1. Log into [Railway.app](https://railway.app).
2. Click **New Project** &rarr; **Deploy from GitHub repo**.
3. Select your TableToken repository.

### Step 2: Add Persistent Volume
1. In the Railway canvas, click on your service.
2. Go to the **Volumes** tab &rarr; **Add Volume**.
3. Set **Mount Path** to `/data`.

### Step 3: Configure Environment Variables
In the **Variables** tab, set:
- `NODE_ENV`: `production`
- `SESSION_SECRET`: `your-secure-random-secret-key-32-chars`
- `DB_PATH`: `/data/tabletoken.db`
- `BASE_URL`: `https://${{RAILWAY_PUBLIC_DOMAIN}}` (or your custom domain)

### Step 4: Generate Domain & Deploy
1. In the **Settings** tab &rarr; **Networking**, click **Generate Domain**.
2. Visit the generated domain to complete initial owner setup.

---

## 3. Database Backups & Maintenance

### How to Take a Live Backup
Because SQLite is running in **WAL (Write-Ahead Logging)** mode, taking a backup while the server is active is safe and does not lock out customers or kitchen staff.

#### From Local Terminal / SSH:
```bash
# Using SQLite backup command:
sqlite3 /data/tabletoken.db ".backup '/data/backup-$(date +%Y%m%d).db'"
```

#### Download Database Backup from Render Shell:
1. Open your Render Web Service &rarr; Click **Shell**.
2. Run:
   ```bash
   cp /data/tabletoken.db /data/backup-today.db
   ```
3. You can also export full order histories anytime via the Owner Dashboard:
   **Owner Dashboard** &rarr; **📊 Sales & Analytics** &rarr; **📥 Export CSV**.

---

## 4. Custom Domains & SSL

If you have a domain like `order.yourrestaurant.com`:
1. In Render/Railway settings, add your custom domain.
2. In your DNS provider (e.g. GoDaddy, Cloudflare, Namecheap), add a CNAME record pointing to your Render/Railway hostname.
3. Update `BASE_URL` in your environment variables to `https://order.yourrestaurant.com`.
4. Table QR codes will automatically regenerate to use your custom domain.
