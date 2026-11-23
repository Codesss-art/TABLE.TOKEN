# Running TableToken Locally on a Laptop in the Restaurant over Wi-Fi

You can run TableToken directly on a laptop placed at the billing counter or kitchen without any cloud hosting or internet fees. Customers seated at tables and the counter TV screen connect over your restaurant's local Wi-Fi router.

---

## 1. Quick Requirements
- A laptop (Windows, Mac, or Linux) with Node.js installed.
- A Wi-Fi router in the restaurant (internet connection is **not** even required after `npm install`).
- Customers' smartphones connected to the same Wi-Fi network.

---

## 2. Step-by-Step Setup

### Step 1: Find your Laptop's Wi-Fi IP Address
1. Open terminal or PowerShell on your laptop:
   - **Windows**: Run `ipconfig`. Look for `IPv4 Address` under your Wi-Fi adapter (e.g., `192.168.1.45`).
   - **Mac / Linux**: Run `ifconfig` or `ip a` (e.g., `192.168.1.45`).

### Step 2: Set the `BASE_URL` in `.env`
Open the `.env` file in the TableToken folder and set `BASE_URL` with your laptop's IP:
```env
PORT=3000
NODE_ENV=production
SESSION_SECRET=local-restaurant-wifi-secret-key-32chars
DB_PATH=./tabletoken.db
BASE_URL=http://192.168.1.45:3000
```
*(Replace `192.168.1.45` with your actual laptop IP).*

> **Tip**: In your Wi-Fi router admin settings, assign a **DHCP Static Reservation** for your laptop's MAC address so its IP address never changes when restarted.

### Step 3: Start the TableToken Server
```bash
npm install
npm start
```
The server will start listening on `0.0.0.0:3000`.

### Step 4: Allow Port 3000 Through Windows Firewall (One-Time)
If customers' phones cannot open the menu on Wi-Fi, Windows Defender Firewall might be blocking incoming connections to port 3000.
1. Press `Windows Key + R`, type `wf.msc`, and press Enter.
2. Click **Inbound Rules** &rarr; **New Rule...**.
3. Choose **Port** &rarr; **TCP** &rarr; Specific local ports: `3000`.
4. Select **Allow the connection** &rarr; Check **Private** &rarr; Name it `TableToken Server`.
5. Click **Finish**.

---

## 3. Printing Table QR Codes for Dining Tables

1. Open your browser on the laptop and visit:
   `http://localhost:3000/owner/login`
2. Complete the one-time owner setup (or log in).
3. Navigate to the **🔲 Table QR Codes** tab.
4. Verify that the URL underneath each table card displays your laptop's Wi-Fi address (e.g., `http://192.168.1.45:3000/scan/...`).
5. Click **🖨️ Print QR Codes** to print placards for all your tables!
6. Laminate or place the printed cards inside acrylic table stands on Tables 1 through 10.

---

## 4. Setting Up the Counter TV Display

1. Connect your Smart TV (or TV with Chromecast / Firestick / Mini PC) to the same restaurant Wi-Fi.
2. Open the TV's web browser and go to:
   `http://192.168.1.45:3000/display`
3. Press `F11` (or your TV browser's Fullscreen button).
4. The display will automatically show live tokens under **Now Preparing** and **Ready for Pickup** with audio chimes. No login or keyboard needed!

---

## 5. Daily Routine for Restaurant Staff

- **Morning Opening**: Turn on laptop, open terminal, run `npm start`.
- **Kitchen Tablet / Counter PC**: Open `http://localhost:3000/owner` to view incoming orders and hear the bell alert.
- **Evening Closing**: In the Owner Dashboard, navigate to **📊 Sales & Analytics** and click **📥 Export CSV** to save today's sales report to Excel or Google Sheets.
