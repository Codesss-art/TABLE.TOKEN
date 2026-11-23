'use strict';

require('dotenv').config();

const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const path = require('path');
const os = require('os');
const db = require('./db');
const SQLiteSessionStore = require('./session-store');

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'tabletoken-super-secret-key-production-ready-998877';
const BASE_URL_CONFIG = (process.env.BASE_URL || '').replace(/\/$/, '');

// Enable trust proxy for Render / Railway / reverse proxies
app.set('trust proxy', 1);

// Security Headers with Helmet
// contentSecurityPolicy is set to allow inline scripts and CDN Chart.js
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

// Body parsers
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Express Session with SQLite store
app.use(session({
  store: new SQLiteSessionStore(db.db),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  name: 'tabletoken.sid',
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 12 * 60 * 60 * 1000 // 12 hours
  }
}));

// Serve static assets from public
app.use(express.static(path.join(__dirname, 'public')));

// --- RATE LIMITERS ---
const scanLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60,
  message: { success: false, error: 'Too many QR scan requests. Please wait a moment.' },
  standardHeaders: true,
  legacyHeaders: false
});

const customerAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30,
  message: { success: false, error: 'Too many login attempts. Please try again after a few minutes.' },
  standardHeaders: true,
  legacyHeaders: false
});

const ownerAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  message: { success: false, error: 'Too many owner login attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false
});

// --- SERVER-SENT EVENTS (SSE) CLIENT POOL ---
let sseClients = [];

function broadcast(eventType, data = {}) {
  const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  for (let i = sseClients.length - 1; i >= 0; i--) {
    const client = sseClients[i];
    try {
      client.res.write(payload);
    } catch (err) {
      sseClients.splice(i, 1);
    }
  }
}

// SSE keep-alive heartbeat
setInterval(() => {
  for (let i = sseClients.length - 1; i >= 0; i--) {
    const client = sseClients[i];
    try {
      client.res.write(': keepalive\n\n');
    } catch (err) {
      sseClients.splice(i, 1);
    }
  }
}, 20000);

// SSE endpoint
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  const clientId = Date.now() + Math.random().toString(36).substring(2);
  const newClient = { id: clientId, res };
  sseClients.push(newClient);

  res.write(`event: connected\ndata: ${JSON.stringify({ clientId, timestamp: new Date().toISOString() })}\n\n`);

  req.on('close', () => {
    sseClients = sseClients.filter(c => c.id !== clientId);
  });
});

// Helper: Determine effective Base URL for table QR codes
function getBaseUrl(req) {
  if (BASE_URL_CONFIG) {
    return BASE_URL_CONFIG;
  }
  const host = req.get('host') || `localhost:${PORT}`;
  const protocol = req.protocol || 'http';
  return `${protocol}://${host}`;
}

// Helper: Network info for local Wi-Fi testing
function getLocalIpAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push(iface.address);
      }
    }
  }
  return addresses;
}

// --- MIDDLEWARES FOR ACCESS CONTROL ---

// Check table session and verify expiration
function getValidTableSession(req) {
  if (!req.session || !req.session.table) {
    return null;
  }
  const table = req.session.table;
  const durationHours = parseFloat(db.getSetting(table.restaurant_id || 1, 'session_duration_hours', '3')) || 3;
  const maxAgeMs = durationHours * 60 * 60 * 1000;

  if (Date.now() - table.scannedAt > maxAgeMs) {
    delete req.session.table;
    return null;
  }
  return table;
}

// Table session guard (Customer can ONLY see menu/order after scanning valid table QR)
function requireTableSession(req, res, next) {
  const table = getValidTableSession(req);
  if (!table) {
    if (req.accepts('html') && !req.xhr && !req.path.startsWith('/api/')) {
      return res.redirect('/scan-error?reason=missing_qr');
    }
    return res.status(403).json({
      success: false,
      error: 'Please scan the QR code at your table.'
    });
  }
  next();
}

// Customer login guard
function requireCustomer(req, res, next) {
  const table = getValidTableSession(req);
  if (!table) {
    if (req.accepts('html') && !req.xhr && !req.path.startsWith('/api/')) {
      return res.redirect('/scan-error?reason=missing_qr');
    }
    return res.status(403).json({
      success: false,
      error: 'Please scan the QR code at your table.'
    });
  }

  if (!req.session || !req.session.customer) {
    if (req.accepts('html') && !req.xhr && !req.path.startsWith('/api/')) {
      return res.redirect('/customer/login');
    }
    return res.status(401).json({
      success: false,
      error: 'Please sign in with your name and phone number to continue.'
    });
  }

  next();
}

// Owner auth guard
function requireOwner(req, res, next) {
  if (!req.session || !req.session.owner) {
    if (req.accepts('html') && !req.xhr && !req.path.startsWith('/api/')) {
      return res.redirect('/owner/login');
    }
    return res.status(401).json({
      success: false,
      error: 'Unauthorized: Owner login required.'
    });
  }
  next();
}

// --- 1. QR CODE SCAN ROUTE ---
app.get('/scan/:token', scanLimiter, (req, res) => {
  const { token } = req.params;
  const table = db.getTableByToken(token);

  if (!table) {
    return res.redirect('/scan-error?reason=invalid_token');
  }

  // Save table in session
  req.session.table = {
    id: table.id,
    number: table.table_number,
    restaurant_id: table.restaurant_id,
    restaurant_name: table.restaurant_name,
    token: table.qr_token,
    scannedAt: Date.now()
  };

  // If customer is already signed in, go directly to menu; otherwise send to sign-in
  if (req.session.customer) {
    return res.redirect('/menu');
  }
  res.redirect('/customer/login');
});

// --- 2. CUSTOMER SIGN-IN & SESSION ROUTES ---
app.get('/customer/login', (req, res) => {
  const table = getValidTableSession(req);
  if (!table) {
    return res.redirect('/scan-error?reason=missing_qr');
  }
  if (req.session.customer) {
    return res.redirect('/menu');
  }
  res.sendFile(path.join(__dirname, 'public', 'customer-login.html'));
});

app.post('/api/customer/login', customerAuthLimiter, (req, res, next) => {
  try {
    const table = getValidTableSession(req);
    if (!table) {
      return res.status(403).json({
        success: false,
        error: 'Please scan the QR code at your table.'
      });
    }

    const { phone, name } = req.body;
    if (!phone || !name) {
      return res.status(400).json({ success: false, error: 'Name and phone number are required.' });
    }

    const customer = db.findOrCreateCustomer(phone, name);

    req.session.customer = {
      id: customer.id,
      phone: customer.phone,
      name: customer.name
    };

    res.json({
      success: true,
      data: {
        customer: req.session.customer,
        table: { number: table.number, id: table.id }
      },
      redirect: '/menu'
    });
  } catch (err) {
    next(err);
  }
});

app.post('/api/customer/logout', (req, res) => {
  delete req.session.customer;
  res.json({ success: true, message: 'Logged out successfully.' });
});

app.get('/api/customer/me', (req, res) => {
  const table = getValidTableSession(req);
  res.json({
    success: true,
    data: {
      customer: req.session.customer || null,
      table: table ? { id: table.id, number: table.number, restaurant_name: table.restaurant_name } : null
    }
  });
});

// --- 3. CUSTOMER MENU & ORDERING ---
app.get('/menu', requireTableSession, (req, res) => {
  if (!req.session.customer) {
    return res.redirect('/customer/login');
  }
  res.sendFile(path.join(__dirname, 'public', 'menu.html'));
});

// Menu endpoint (requires valid table session)
app.get('/api/menu', requireTableSession, (req, res, next) => {
  try {
    const table = req.session.table;
    const items = db.getMenu(table.restaurant_id || 1, false);
    res.json({ success: true, data: items });
  } catch (err) {
    next(err);
  }
});

// Place Order
app.post('/api/orders', requireCustomer, (req, res, next) => {
  try {
    const table = req.session.table;
    const customer = req.session.customer;
    const { items, notes } = req.body;

    const orderResult = db.createOrder({
      restaurant_id: table.restaurant_id || 1,
      customer_id: customer.id,
      table_id: table.id,
      table_number: table.number,
      customer_name: customer.name,
      customer_phone: customer.phone,
      items,
      notes
    });

    const fullOrder = db.getOrderById(orderResult.orderId);

    // Broadcast live event to Kitchen Dashboard & TV Display
    broadcast('order_created', { order: fullOrder });
    broadcast('queue_updated', { activeOrders: db.getActiveOrders(table.restaurant_id || 1) });

    res.status(201).json({
      success: true,
      data: orderResult
    });
  } catch (err) {
    next(err);
  }
});

// Customer can view ONLY their own orders
app.get('/api/orders/my-orders', requireCustomer, (req, res, next) => {
  try {
    const orders = db.getOrdersByCustomer(req.session.customer.id);
    res.json({ success: true, data: orders });
  } catch (err) {
    next(err);
  }
});

// Customer order tracker
app.get('/api/orders/track/:token', requireCustomer, (req, res, next) => {
  try {
    const token = parseInt(req.params.token, 10);
    const table = req.session.table;
    const date = req.query.date || db.getTodayDateString();
    const trackingInfo = db.getTrackingInfo(token, date, table.restaurant_id || 1);

    if (!trackingInfo) {
      return res.status(404).json({
        success: false,
        error: `Order token #${token} for today was not found.`
      });
    }

    // Security: customer can only track their own order or an order at their table
    if (trackingInfo.order.customer_id !== req.session.customer.id &&
        trackingInfo.order.table_number !== table.number) {
      return res.status(403).json({ success: false, error: 'Access denied: You can only view your own orders.' });
    }

    res.json({ success: true, data: trackingInfo });
  } catch (err) {
    next(err);
  }
});

// Customer cancel order (ONLY while status is Received)
app.post('/api/orders/:id/cancel', requireCustomer, (req, res, next) => {
  try {
    const orderId = parseInt(req.params.id, 10);
    const { reason } = req.body;
    const updated = db.cancelCustomerOrder(orderId, req.session.customer.id, reason || 'Cancelled by customer');

    broadcast('order_status_updated', {
      orderId: updated.id,
      tokenNumber: updated.token_number,
      status: updated.status,
      order: updated
    });
    broadcast('queue_updated', { activeOrders: db.getActiveOrders(updated.restaurant_id) });

    res.json({ success: true, data: updated, message: 'Order cancelled successfully.' });
  } catch (err) {
    next(err);
  }
});

// --- 4. OWNER AUTH & SETUP ---
app.get('/owner/setup', (req, res) => {
  const ownersCount = db.getTotalOwnersCount();
  if (ownersCount > 0) {
    return res.redirect('/owner/login');
  }
  res.sendFile(path.join(__dirname, 'public', 'owner-setup.html'));
});

app.post('/api/owner/setup', ownerAuthLimiter, async (req, res, next) => {
  try {
    const ownersCount = db.getTotalOwnersCount();
    if (ownersCount > 0) {
      return res.status(400).json({ success: false, error: 'Owner account is already configured. Please log in.' });
    }

    const { phone, password, full_name, restaurant_name } = req.body;
    if (!phone || !password || !full_name) {
      return res.status(400).json({ success: false, error: 'Phone number, password, and owner name are required.' });
    }

    const cleanedPhone = String(phone).replace(/\D/g, '').slice(-10);
    if (!/^[6-9]\d{9}$/.test(cleanedPhone)) {
      return res.status(400).json({ success: false, error: 'Please enter a valid 10-digit Indian phone number.' });
    }

    if (password.length < 6) {
      return res.status(400).json({ success: false, error: 'Password must be at least 6 characters long.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const owner = db.createOwner({
      restaurant_id: 1,
      phone: cleanedPhone,
      password_hash: passwordHash,
      full_name: full_name.trim(),
      restaurant_name: restaurant_name ? restaurant_name.trim() : 'The Royal Spice Table'
    });

    req.session.owner = {
      id: owner.id,
      phone: owner.phone,
      full_name: owner.full_name,
      restaurant_id: owner.restaurant_id
    };

    res.status(201).json({
      success: true,
      data: req.session.owner,
      redirect: '/owner',
      message: 'Owner account created successfully!'
    });
  } catch (err) {
    next(err);
  }
});

app.get('/owner/login', (req, res) => {
  const ownersCount = db.getTotalOwnersCount();
  if (ownersCount === 0) {
    return res.redirect('/owner/setup');
  }
  if (req.session.owner) {
    return res.redirect('/owner');
  }
  res.sendFile(path.join(__dirname, 'public', 'owner-login.html'));
});

app.post('/api/owner/login', ownerAuthLimiter, async (req, res, next) => {
  try {
    const { phone, password } = req.body;
    if (!phone || !password) {
      return res.status(400).json({ success: false, error: 'Phone number and password are required.' });
    }

    const cleanedPhone = String(phone).replace(/\D/g, '').slice(-10);
    const owner = db.getOwnerByPhone(cleanedPhone);
    if (!owner) {
      return res.status(401).json({ success: false, error: 'Invalid phone number or password.' });
    }

    const match = await bcrypt.compare(password, owner.password_hash);
    if (!match) {
      return res.status(401).json({ success: false, error: 'Invalid phone number or password.' });
    }

    req.session.owner = {
      id: owner.id,
      phone: owner.phone,
      full_name: owner.full_name,
      restaurant_id: owner.restaurant_id
    };

    res.json({
      success: true,
      data: req.session.owner,
      redirect: '/owner'
    });
  } catch (err) {
    next(err);
  }
});

app.post('/api/owner/logout', (req, res) => {
  delete req.session.owner;
  res.json({ success: true, message: 'Logged out successfully.' });
});

app.get('/owner', requireOwner, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'owner.html'));
});

// --- 5. OWNER DASHBOARD APIS (requireOwner) ---

// Active kitchen board orders
app.get('/api/owner/orders/active', requireOwner, (req, res, next) => {
  try {
    const active = db.getActiveOrders(req.session.owner.restaurant_id);
    res.json({ success: true, data: active });
  } catch (err) {
    next(err);
  }
});

// All orders with optional date filter
app.get('/api/owner/orders', requireOwner, (req, res, next) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 100;
    const date = req.query.date || null;
    const orders = db.getAllOrders(req.session.owner.restaurant_id, limit, date);
    res.json({ success: true, data: orders });
  } catch (err) {
    next(err);
  }
});

// Update order status (Received -> Preparing -> Ready -> Picked up / Cancelled with reason)
app.put('/api/owner/orders/:id/status', requireOwner, (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { status, cancel_reason } = req.body;
    if (!status) {
      return res.status(400).json({ success: false, error: 'Target status is required.' });
    }

    const updated = db.updateOrderStatus(id, status, cancel_reason);

    broadcast('order_status_updated', {
      orderId: updated.id,
      tokenNumber: updated.token_number,
      status: updated.status,
      order: updated
    });
    broadcast('queue_updated', { activeOrders: db.getActiveOrders(req.session.owner.restaurant_id) });

    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});

// Update payment status (Unpaid / Paid cash / Paid UPI)
app.put('/api/owner/orders/:id/payment', requireOwner, (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { payment_status } = req.body;
    const updated = db.updateOrderPaymentStatus(id, payment_status);

    broadcast('order_status_updated', {
      orderId: updated.id,
      tokenNumber: updated.token_number,
      payment_status: updated.payment_status,
      order: updated
    });

    res.json({ success: true, data: updated });
  } catch (err) {
    next(err);
  }
});

// Export Orders to CSV for any date
app.get('/api/owner/orders/export-csv', requireOwner, (req, res, next) => {
  try {
    const date = req.query.date || db.getTodayDateString();
    const rows = db.getOrdersForCsv(date, req.session.owner.restaurant_id);

    // Escape helper for CSV RFC 4180
    const csvEscape = (val) => {
      if (val === null || val === undefined) return '""';
      const str = String(val).replace(/"/g, '""');
      return `"${str}"`;
    };

    const headers = [
      'Order ID',
      'Token Number',
      'Order Date',
      'Time Created',
      'Table Number',
      'Customer Name',
      'Customer Phone',
      'Status',
      'Payment Status',
      'Total Amount (₹)',
      'Items Ordered',
      'Customer Notes',
      'Cancel Reason'
    ];

    const lines = [headers.join(',')];
    for (const r of rows) {
      lines.push([
        csvEscape(r.order_id),
        csvEscape(r.token_number),
        csvEscape(r.order_date),
        csvEscape(r.created_at),
        csvEscape(r.table_number),
        csvEscape(r.customer_name),
        csvEscape(r.customer_phone || 'N/A'),
        csvEscape(r.status),
        csvEscape(r.payment_status),
        csvEscape(r.total_amount),
        csvEscape(r.items_summary || ''),
        csvEscape(r.notes || ''),
        csvEscape(r.cancel_reason || '')
      ].join(','));
    }

    const csvContent = lines.join('\r\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="tabletoken-orders-${date}.csv"`);
    res.send(csvContent);
  } catch (err) {
    next(err);
  }
});

// Menu Management
app.get('/api/owner/menu', requireOwner, (req, res, next) => {
  try {
    const items = db.getMenu(req.session.owner.restaurant_id, true);
    res.json({ success: true, data: items });
  } catch (err) {
    next(err);
  }
});

app.post('/api/owner/menu', requireOwner, (req, res, next) => {
  try {
    const { name, category, price, description, is_veg, is_available, image_emoji } = req.body;
    if (!name || !category || price === undefined || price === null) {
      return res.status(400).json({ success: false, error: 'Name, category, and price are required.' });
    }
    const item = db.addMenuItem({
      restaurant_id: req.session.owner.restaurant_id,
      name,
      category,
      price: parseFloat(price),
      description,
      is_veg: is_veg === true || is_veg === 1 || is_veg === '1',
      is_available: is_available === true || is_available === 1 || is_available === '1',
      image_emoji
    });
    broadcast('menu_updated', { action: 'add', item });
    res.status(201).json({ success: true, data: item });
  } catch (err) {
    next(err);
  }
});

app.put('/api/owner/menu/:id', requireOwner, (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const item = db.updateMenuItem(id, req.body);
    if (!item) {
      return res.status(404).json({ success: false, error: 'Menu item not found.' });
    }
    broadcast('menu_updated', { action: 'update', item });
    res.json({ success: true, data: item });
  } catch (err) {
    next(err);
  }
});

app.put('/api/owner/menu/:id/toggle', requireOwner, (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { is_available } = req.body;
    const item = db.toggleItemAvailability(id, is_available);
    if (!item) {
      return res.status(404).json({ success: false, error: 'Menu item not found.' });
    }
    broadcast('menu_updated', { action: 'toggle', item });
    res.json({ success: true, data: item });
  } catch (err) {
    next(err);
  }
});

app.delete('/api/owner/menu/:id', requireOwner, (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const deleted = db.deleteMenuItem(id);
    if (!deleted) {
      return res.status(404).json({ success: false, error: 'Menu item not found.' });
    }
    broadcast('menu_updated', { action: 'delete', id });
    res.json({ success: true, message: 'Item deleted.' });
  } catch (err) {
    next(err);
  }
});

// Table Management
app.get('/api/owner/tables', requireOwner, (req, res, next) => {
  try {
    const baseUrl = getBaseUrl(req);
    const tables = db.getTables(req.session.owner.restaurant_id).map(t => ({
      ...t,
      scan_url: `${baseUrl}/scan/${t.qr_token}`
    }));
    res.json({ success: true, data: tables, baseUrl });
  } catch (err) {
    next(err);
  }
});

app.post('/api/owner/tables', requireOwner, (req, res, next) => {
  try {
    const { table_number } = req.body;
    const table = db.addTable(req.session.owner.restaurant_id, table_number);
    const baseUrl = getBaseUrl(req);
    res.status(201).json({
      success: true,
      data: {
        ...table,
        scan_url: `${baseUrl}/scan/${table.qr_token}`
      }
    });
  } catch (err) {
    next(err);
  }
});

app.delete('/api/owner/tables/:id', requireOwner, (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    db.deleteTable(req.session.owner.restaurant_id, id);
    res.json({ success: true, message: 'Table removed.' });
  } catch (err) {
    next(err);
  }
});

app.post('/api/owner/tables/:id/regenerate-qr', requireOwner, (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const updated = db.regenerateTableToken(req.session.owner.restaurant_id, id);
    if (!updated) {
      return res.status(404).json({ success: false, error: 'Table not found.' });
    }
    const baseUrl = getBaseUrl(req);
    res.json({
      success: true,
      data: {
        ...updated,
        scan_url: `${baseUrl}/scan/${updated.qr_token}`
      },
      message: 'QR Token regenerated successfully.'
    });
  } catch (err) {
    next(err);
  }
});

// Customer Directory
app.get('/api/owner/customers', requireOwner, (req, res, next) => {
  try {
    const customers = db.getAllCustomers(req.session.owner.restaurant_id);
    res.json({ success: true, data: customers });
  } catch (err) {
    next(err);
  }
});

// Settings
app.get('/api/owner/settings', requireOwner, (req, res, next) => {
  try {
    const settings = db.getSettings(req.session.owner.restaurant_id);
    res.json({ success: true, data: settings });
  } catch (err) {
    next(err);
  }
});

app.put('/api/owner/settings', requireOwner, (req, res, next) => {
  try {
    const updated = db.updateSettings(req.session.owner.restaurant_id, req.body);
    res.json({ success: true, data: updated, message: 'Settings saved successfully.' });
  } catch (err) {
    next(err);
  }
});

// Analytics
app.get('/api/owner/analytics', requireOwner, (req, res, next) => {
  try {
    const date = req.query.date || db.getTodayDateString();
    const analytics = db.getAnalytics(date, req.session.owner.restaurant_id);
    res.json({ success: true, data: analytics });
  } catch (err) {
    next(err);
  }
});

// --- 6. TV DISPLAY SCREEN (No login, Token numbers & status ONLY) ---
app.get('/display', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'display.html'));
});

app.get('/api/display/tokens', (req, res, next) => {
  try {
    const date = req.query.date || db.getTodayDateString();
    const displayData = db.getDisplayTokens(date, 1);
    res.json({ success: true, data: displayData });
  } catch (err) {
    next(err);
  }
});

// Backward-compatible endpoint for existing display client
app.get('/api/orders/display', (req, res, next) => {
  try {
    const date = req.query.date || db.getTodayDateString();
    const displayData = db.getDisplayTokens(date, 1);
    res.json({ success: true, data: displayData });
  } catch (err) {
    next(err);
  }
});

// --- 7. HELPER & ERROR PAGES ---
app.get('/scan-error', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'scan-error.html'));
});

app.get('/api/network-info', (req, res) => {
  const ips = getLocalIpAddresses();
  const primaryIp = ips[0] || 'localhost';
  const baseUrl = getBaseUrl(req);

  res.json({
    port: PORT,
    ips,
    baseUrl,
    displayUrl: `${baseUrl}/display`,
    ownerUrl: `${baseUrl}/owner/login`
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Centralized Error Handler
app.use((err, req, res, next) => {
  console.error('Server error:', err.message);
  res.status(err.status || 400).json({
    success: false,
    error: err.message || 'An unexpected error occurred. Please try again.'
  });
});

// Start Server
if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    const localIps = getLocalIpAddresses();
    console.log(`=======================================================`);
    console.log(`🚀 TableToken Restaurant Server running on port ${PORT}!`);
    console.log(`-------------------------------------------------------`);
    console.log(`💻 Local access:`);
    console.log(`   Home / Portal:    http://localhost:${PORT}`);
    console.log(`   TV Display:       http://localhost:${PORT}/display`);
    console.log(`   Owner Dashboard:  http://localhost:${PORT}/owner/login`);
    console.log(`-------------------------------------------------------`);
    if (localIps.length > 0) {
      console.log(`📱 Local Wi-Fi Access:`);
      localIps.forEach(ip => {
        console.log(`   http://${ip}:${PORT}`);
      });
    }
    console.log(`=======================================================`);
  });
}

module.exports = app;
