# 🍽️ TableToken - Smart QR Table Ordering System

TableToken is a real, production-ready QR table-ordering and kitchen token operating system designed for small restaurants, cafes, and food stalls.

It eliminates long waiter queues, prevents kitchen confusion, and lets lone chefs operate at peak efficiency. Customers scan their assigned table's secret QR code, browse a live menu, order food, and track their preparation token in real time on their phone and the counter TV.

---

## ✨ Features

### 1. 🔒 Security & Table Access Rule (Core Feature)
- **Zero-Guessing QR Tokens**: Each table has a unique, cryptographically random secret token (`/scan/<token>`). No guessable links like `?table=7`.
- **Mandatory QR Gate**: Customers **must** scan the table QR code and sign in to access the menu and place orders. Accessing `/menu` directly shows a friendly message: *"Please scan the QR code at your table."*
- **Expiring Table Sessions**: Table sessions expire after 3 hours (configurable by the owner).
- **Leaked Token Revocation**: The owner can regenerate any table's QR token with one click if a QR code is compromised.
- **Server-Side Price Validation**: Cart totals and order pricing are calculated exclusively on the server from the SQLite database. Client-tampered prices are strictly ignored.
- **Transaction Safety**: All orders and item records are created inside atomic database transactions.
- **Rate Limiting & Helmet**: Built-in rate limiters on QR scans, customer logins, and owner logins; strict HTTP headers with Helmet.

### 2. 📱 Customer Experience (Mobile-First)
- **Fast Sign-In**: Enter name and 10-digit Indian phone number (`^[6-9]\d{9}$`). Existing customer records are reused automatically.
- **Menu Browsing**: Search dishes instantly, filter by category (*Starters, Mains, Drinks, Desserts*), and diet (*Pure Veg 🟢 / Non-Veg 🔴*).
- **Out-of-Stock Protection**: Unavailable dishes are clearly badged and cannot be added to cart.
- **Live Token Tracker**:
  - Step-by-step status progress: `Received` &rarr; `Preparing` &rarr; `Ready` &rarr; `Picked up`.
  - Queue visibility: View how many orders are ahead and estimated wait time in minutes.
  - Celebratory audio chime when food is marked **Ready**.
- **Customer Cancellation**: Customers can cancel an order **only** while its status is `Received`. Once kitchen preparation starts, cancellation is locked.
- **Order History**: Customers can review all past orders placed today.

### 3. 👨‍🍳 Owner & Kitchen Dashboard (`/owner/login`)
- **Bcrypt Security**: Master passwords hashed with bcrypt (no default PIN like 1234).
- **One-Time Setup Flow**: On first run, a dedicated setup page (`/owner/setup`) allows the owner to create their administrator account and configure the restaurant name.
- **Real-Time Kitchen Board**:
  - 3-column kanban board: `New Orders`, `Now Preparing`, `Ready for Pickup`.
  - Audio doorbell chime and pulsating visual alert on every incoming order.
  - One-click progression buttons (`Start Preparing`, `Mark Ready`, `Complete / Picked Up`).
  - Order cancellation with customizable reason.
- **Payment Status Tracking**: Mark each order as `Unpaid`, `Paid cash`, or `Paid UPI` without third-party payment gateways.
- **Menu Management**: Add, edit, delete dishes, adjust prices, change categories, and toggle *In Stock / Out of Stock* in real time.
- **Table Management**: View tables, add/remove tables, regenerate leaked QR tokens, and print ready-to-use table QR placards.
- **Customer Directory**: View registered customer names, phone numbers, total visits, and lifetime spending.
- **Business Sales & Analytics**:
  - Filter analytics by any date.
  - Total sales, orders volume, payment split (Cash vs UPI), and average preparation speed.
  - Interactive Chart.js charts: *Sales by Hour* and *Top 5 Dishes*.
  - **CSV Export**: Download complete order history for any date in clean CSV format.

### 4. 📺 Counter TV Display (`/display`)
- High-contrast, dark mode screen designed for wall-mounted TVs at the pickup counter.
- Shows large glowing token numbers for **Now Preparing** and **Ready for Pickup**.
- **Zero Customer PII**: Strictly token numbers and table numbers only—no customer names or phone numbers are exposed.
- Audio arpeggio chime when orders move to Ready.
- Real-time SSE updates + automatic polling fallback.

---

## 🚀 Quick Start (Development & Local Run)

### 1. Prerequisites
- [Node.js](https://nodejs.org) (v18, v20, v22, or v26)
- npm

### 2. Install & Start
```bash
# Clone the repository and enter the directory
cd TableToken_Real

# Install dependencies
npm install

# Start the application
npm start
```

### 3. First-Time Setup
1. Open your browser and visit:
   `http://localhost:3000`
2. Click **Owner & Kitchen Board** (or go to `http://localhost:3000/owner/login`).
3. You will be greeted by the **One-Time Administrator Setup** page (`/owner/setup`).
4. Enter your restaurant name, manager name, 10-digit mobile number, and password.
5. In the dashboard, click **🔲 Table QR Codes** to test scanning Table 1 to 10 or click **🖨️ Print QR Codes**.

---

## 🧪 Running Automated Tests

Run the full end-to-end integration and security test suite:
```bash
npm test
```
The test suite validates:
- ✅ Blocked access without table QR scan
- ✅ QR token validation & session binding
- ✅ Customer phone number validation
- ✅ Server-side price calculation (client tamper resistance)
- ✅ Out-of-stock dish rejection
- ✅ Customer order cancellation rules
- ✅ Kitchen status flow (`Received` &rarr; `Preparing` &rarr; `Ready` &rarr; `Picked up`)
- ✅ Owner-only route protection with bcrypt
- ✅ TV display privacy (zero customer PII)
- ✅ Analytics calculation & CSV export
- ✅ Table QR token revocation & regeneration

---

## 📂 Project Structure

```
TableToken_Real/
├── .env.example             # Environment variables template
├── .env                     # Local environment configuration
├── DEPLOY.md                # Production guide for Render & Railway (Persistent Disks)
├── LOCAL_AT_RESTAURANT.md   # Guide for running on a laptop in the restaurant over Wi-Fi
├── README.MD                # System documentation
├── package.json             # Node dependencies and scripts
├── server.js                # Express app, security middleware, SSE & API routes
├── db.js                    # SQLite database schema, transactions & prepared queries
├── sqlite-adapter.js        # Fallback adapter for better-sqlite3 across all platforms
├── session-store.js         # SQLite session store for express-session
├── test/
│   └── test-flow.js         # Automated end-to-end test suite
└── public/
    ├── index.html           # Landing portal & quick table simulator
    ├── customer-login.html  # Mobile phone customer sign-in screen
    ├── scan-error.html      # Friendly QR scan instruction screen
    ├── menu.html            # Customer dining menu & live token tracker
    ├── owner-setup.html     # One-time owner administrator registration
    ├── owner-login.html     # Owner sign-in screen (phone + bcrypt password)
    ├── owner.html           # Live kitchen board, menu manager & analytics
    ├── display.html         # High-contrast counter TV status board
    ├── css/
    │   └── style.css        # Responsive styling & printable QR placard sheet
    └── js/
        ├── common.js        # Web Audio chimes, SSE client & formatters
        └── qrcode.min.js    # Client-side QR code generator
```

---

## ⚙️ Environment Variables

Copy `.env.example` to `.env`:

```env
PORT=3000
NODE_ENV=production
SESSION_SECRET=your-random-32-character-session-secret-here
DB_PATH=./tabletoken.db
BASE_URL=http://localhost:3000
```

- `BASE_URL`: The URL embedded into table QR codes. When deploying to Render or Railway, set this to your public HTTPS address (e.g. `https://myrestaurant.onrender.com`). When running over local Wi-Fi, set this to your laptop's IP address (e.g. `http://192.168.1.50:3000`).

---

## 📖 Day-to-Day Owner Workflow

1. **Morning Opening**: Start the server or open `https://your-domain.com`.
2. **Kitchen Setup**: Log into `/owner` on the kitchen tablet or billing laptop. Keep sound enabled so the doorbell chime rings when new orders arrive.
3. **Counter TV**: Open `/display` on the counter TV browser and press Fullscreen (`F11`).
4. **Orders Flow**:
   - Customer sits at Table 4 and scans the QR code.
   - Customer signs in with their mobile number and places their order.
   - Kitchen hears the chime and sees the card under **New Orders**.
   - Chef clicks **Start Preparing** &rarr; TV display and customer's phone show "Now Preparing".
   - Chef clicks **Mark Ready** &rarr; Celebratory chime plays on customer's phone and TV flashes green.
   - Customer collects tray &rarr; Staff clicks **Complete / Picked Up**.
5. **Night Closing**: Navigate to **📊 Sales & Analytics** &rarr; Click **📥 Export CSV** to download today's sales report.
