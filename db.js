'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let Database;
try {
  Database = require('better-sqlite3');
  const test = new Database(':memory:');
  test.close();
} catch (err) {
  Database = require('./sqlite-adapter');
}

const dbPath = process.env.DB_PATH || path.join(__dirname, 'tabletoken.db');
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(dbPath);

// Enable WAL mode & foreign keys
try {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
} catch (_) {}

function getTodayDateString() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function generateSecureToken() {
  return crypto.randomBytes(16).toString('hex');
}

function initDatabase() {
  // Check if legacy schema exists (without restaurants table or without qr_token on tables)
  let masterTables = [];
  try {
    masterTables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
  } catch (_) {}

  if (masterTables.includes('orders') && !masterTables.includes('restaurants')) {
    // Drop prototype tables to establish production normalized schema
    db.exec(`
      DROP TABLE IF EXISTS order_items;
      DROP TABLE IF EXISTS orders;
      DROP TABLE IF EXISTS menu_items;
    `);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS restaurants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      address TEXT DEFAULT 'Main Dining Hall',
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS owners (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      phone TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      full_name TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS tables (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      table_number INTEGER NOT NULL,
      qr_token TEXT UNIQUE NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      UNIQUE(restaurant_id, table_number)
    );

    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      last_visit TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS menu_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      price REAL NOT NULL,
      description TEXT,
      is_veg INTEGER NOT NULL DEFAULT 1,
      is_available INTEGER NOT NULL DEFAULT 1,
      image_emoji TEXT DEFAULT '🍽️',
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
      table_id INTEGER REFERENCES tables(id) ON DELETE SET NULL,
      table_number INTEGER NOT NULL,
      token_number INTEGER NOT NULL,
      order_date TEXT NOT NULL,
      customer_name TEXT NOT NULL,
      customer_phone TEXT,
      status TEXT NOT NULL DEFAULT 'Received',
      cancel_reason TEXT,
      total_amount REAL NOT NULL,
      payment_status TEXT NOT NULL DEFAULT 'Unpaid',
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now', 'localtime')),
      preparing_at TEXT,
      ready_at TEXT,
      picked_up_at TEXT
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      menu_item_id INTEGER NOT NULL,
      item_name TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      price REAL NOT NULL,
      is_veg INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      restaurant_id INTEGER NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      setting_key TEXT NOT NULL,
      setting_value TEXT NOT NULL,
      UNIQUE(restaurant_id, setting_key)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY,
      sess TEXT NOT NULL,
      expired INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_orders_rest_date_token ON orders(restaurant_id, order_date, token_number);
    CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id);
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_tables_token ON tables(qr_token);
    CREATE INDEX IF NOT EXISTS idx_tables_rest_num ON tables(restaurant_id, table_number);
    CREATE INDEX IF NOT EXISTS idx_menu_rest_cat ON menu_items(restaurant_id, category);
    CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);
    CREATE INDEX IF NOT EXISTS idx_sessions_expired ON sessions(expired);
  `);

  seedIfEmpty();
}

function seedIfEmpty() {
  // Check restaurants
  let restRow = db.prepare('SELECT id FROM restaurants LIMIT 1').get();
  let restaurantId = restRow ? restRow.id : null;

  if (!restaurantId) {
    const res = db.prepare('INSERT INTO restaurants (name, address) VALUES (?, ?)').run('The Royal Spice Table', 'Ground Floor, High Street');
    restaurantId = res.lastInsertRowid;
  }

  // Settings
  const insertSettingStmt = db.prepare(`
    INSERT OR IGNORE INTO settings (restaurant_id, setting_key, setting_value)
    VALUES (?, ?, ?)
  `);
  insertSettingStmt.run(restaurantId, 'restaurant_name', 'The Royal Spice Table');
  insertSettingStmt.run(restaurantId, 'session_duration_hours', '3');
  insertSettingStmt.run(restaurantId, 'average_prep_time_minutes', '12');

  // Seed 10 tables on first run
  const tableCount = db.prepare('SELECT COUNT(*) as count FROM tables WHERE restaurant_id = ?').get(restaurantId).count;
  if (tableCount === 0) {
    const insertTable = db.prepare(`
      INSERT INTO tables (restaurant_id, table_number, qr_token, is_active)
      VALUES (?, ?, ?, 1)
    `);
    const seedTablesTx = db.transaction(() => {
      for (let t = 1; t <= 10; t++) {
        insertTable.run(restaurantId, t, generateSecureToken());
      }
    });
    seedTablesTx();
  }

  // Seed 15 menu items on first run
  const menuCount = db.prepare('SELECT COUNT(*) as count FROM menu_items WHERE restaurant_id = ?').get(restaurantId).count;
  if (menuCount === 0) {
    const seedDishes = [
      // Starters
      { name: 'Paneer Tikka', category: 'Starters', price: 220, description: 'Cottage cheese cubes marinated in spiced yogurt and grilled with peppers', is_veg: 1, image_emoji: '🧀' },
      { name: 'Crispy Veg Samosa (2 pcs)', category: 'Starters', price: 80, description: 'Golden flaky pastry stuffed with spiced potatoes and green peas', is_veg: 1, image_emoji: '🥟' },
      { name: 'Chicken Seekh Kebab', category: 'Starters', price: 260, description: 'Minced spiced chicken skewers roasted in clay tandoor oven', is_veg: 0, image_emoji: '🍢' },
      { name: 'Amritsari Fish Fry', category: 'Starters', price: 310, description: 'Crisp carom-seed and gram flour battered river fish fillets', is_veg: 0, image_emoji: '🐟' },
      
      // Mains
      { name: 'Butter Chicken (Murgh Makhani)', category: 'Mains', price: 340, description: 'Tender tandoori chicken simmered in rich creamy tomato and butter gravy', is_veg: 0, image_emoji: '🍗' },
      { name: 'Paneer Butter Masala', category: 'Mains', price: 280, description: 'Fresh paneer cooked in velvety cashew, butter and aromatic tomato sauce', is_veg: 1, image_emoji: '🍛' },
      { name: 'Dal Makhani', category: 'Mains', price: 230, description: 'Slow-cooked black lentils simmered overnight with butter, cream, and ginger', is_veg: 1, image_emoji: '🍲' },
      { name: 'Hyderabadi Chicken Dum Biryani', category: 'Mains', price: 320, description: 'Fragrant basmati rice layered with marinated chicken, saffron, and mint', is_veg: 0, image_emoji: '🍚' },
      { name: 'Subz Dum Veg Biryani', category: 'Mains', price: 250, description: 'Garden fresh vegetables cooked with fragrant basmati rice and whole spices', is_veg: 1, image_emoji: '🥕' },
      { name: 'Butter Garlic Naan', category: 'Mains', price: 65, description: 'Tandoor-baked leavened flatbread brushed with fresh garlic and melted butter', is_veg: 1, image_emoji: '🫓' },

      // Drinks
      { name: 'Sweet Mango Lassi', category: 'Drinks', price: 90, description: 'Thick churned yogurt blended with Alphonso mango pulp and cardamom', is_veg: 1, image_emoji: '🥭' },
      { name: 'Masala Chaas (Spiced Buttermilk)', category: 'Drinks', price: 60, description: 'Refreshing salted buttermilk infused with roasted cumin, ginger and coriander', is_veg: 1, image_emoji: '🥛' },
      { name: 'Cutting Masala Chai', category: 'Drinks', price: 40, description: 'Traditional boiled black tea with milk, fresh ginger, and green cardamom', is_veg: 1, image_emoji: '☕' },

      // Desserts
      { name: 'Gulab Jamun with Rabri (2 pcs)', category: 'Desserts', price: 120, description: 'Warm milk dumplings soaked in saffron syrup topped with thick creamy rabri', is_veg: 1, image_emoji: '🍮' },
      { name: 'Kesar Pista Rasmalai (2 pcs)', category: 'Desserts', price: 140, description: 'Delicate cottage cheese patties soaked in saffron and pistachio milk', is_veg: 1, image_emoji: '🍨' }
    ];

    const insertDish = db.prepare(`
      INSERT INTO menu_items (restaurant_id, name, category, price, description, is_veg, is_available, image_emoji)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?)
    `);

    const seedMenuTx = db.transaction(() => {
      for (const d of seedDishes) {
        insertDish.run(restaurantId, d.name, d.category, d.price, d.description, d.is_veg, d.image_emoji);
      }
    });
    seedMenuTx();
  }
}

// Restaurant Queries
function getDefaultRestaurant() {
  return db.prepare('SELECT * FROM restaurants ORDER BY id ASC LIMIT 1').get();
}

function getRestaurantById(id) {
  return db.prepare('SELECT * FROM restaurants WHERE id = ?').get(id);
}

function updateRestaurantName(id, name) {
  db.prepare('UPDATE restaurants SET name = ? WHERE id = ?').run(name.trim(), id);
  db.prepare('INSERT OR REPLACE INTO settings (restaurant_id, setting_key, setting_value) VALUES (?, ?, ?)')
    .run(id, 'restaurant_name', name.trim());
  return getRestaurantById(id);
}

// Owner Accounts
function getOwnersCount(restaurantId = 1) {
  const row = db.prepare('SELECT COUNT(*) as count FROM owners WHERE restaurant_id = ?').get(restaurantId);
  return row ? row.count : 0;
}

function getTotalOwnersCount() {
  const row = db.prepare('SELECT COUNT(*) as count FROM owners').get();
  return row ? row.count : 0;
}

function getOwnerByPhone(phone) {
  return db.prepare('SELECT * FROM owners WHERE phone = ?').get(phone.trim());
}

function getOwnerById(id) {
  return db.prepare('SELECT id, restaurant_id, phone, full_name, created_at FROM owners WHERE id = ?').get(id);
}

function createOwner({ restaurant_id = 1, phone, password_hash, full_name, restaurant_name }) {
  if (restaurant_name && restaurant_name.trim()) {
    updateRestaurantName(restaurant_id, restaurant_name.trim());
  }
  const stmt = db.prepare(`
    INSERT INTO owners (restaurant_id, phone, password_hash, full_name)
    VALUES (?, ?, ?, ?)
  `);
  const result = stmt.run(restaurant_id, phone.trim(), password_hash, full_name.trim());
  return getOwnerById(result.lastInsertRowid);
}

// Settings
function getSettings(restaurantId = 1) {
  const rows = db.prepare('SELECT setting_key, setting_value FROM settings WHERE restaurant_id = ?').all(restaurantId);
  const settingsObj = {};
  for (const r of rows) {
    settingsObj[r.setting_key] = r.setting_value;
  }
  return settingsObj;
}

function getSetting(restaurantId = 1, key, defaultValue = '') {
  const row = db.prepare('SELECT setting_value FROM settings WHERE restaurant_id = ? AND setting_key = ?').get(restaurantId, key);
  return row ? row.setting_value : defaultValue;
}

function updateSettings(restaurantId = 1, settingsObj = {}) {
  const stmt = db.prepare(`
    INSERT INTO settings (restaurant_id, setting_key, setting_value)
    VALUES (?, ?, ?)
    ON CONFLICT(restaurant_id, setting_key) DO UPDATE SET setting_value = excluded.setting_value
  `);
  const tx = db.transaction(() => {
    for (const [k, v] of Object.entries(settingsObj)) {
      if (v !== undefined && v !== null) {
        stmt.run(restaurantId, k, String(v).trim());
      }
    }
    if (settingsObj.restaurant_name) {
      db.prepare('UPDATE restaurants SET name = ? WHERE id = ?').run(settingsObj.restaurant_name.trim(), restaurantId);
    }
  });
  tx();
  return getSettings(restaurantId);
}

// Table Management
function getTables(restaurantId = 1) {
  return db.prepare(`
    SELECT * FROM tables
    WHERE restaurant_id = ? AND is_active = 1
    ORDER BY table_number ASC
  `).all(restaurantId);
}

function getTableByToken(token) {
  if (!token) return null;
  return db.prepare(`
    SELECT t.*, r.name as restaurant_name
    FROM tables t
    JOIN restaurants r ON r.id = t.restaurant_id
    WHERE t.qr_token = ? AND t.is_active = 1
  `).get(token.trim());
}

function getTableById(id) {
  return db.prepare('SELECT * FROM tables WHERE id = ?').get(id);
}

function addTable(restaurantId = 1, tableNumber) {
  const num = parseInt(tableNumber, 10);
  if (!num || num < 1 || num > 500) {
    throw new Error('Please enter a valid table number (1 - 500).');
  }
  const existing = db.prepare('SELECT * FROM tables WHERE restaurant_id = ? AND table_number = ?').get(restaurantId, num);
  if (existing) {
    if (existing.is_active === 0) {
      db.prepare('UPDATE tables SET is_active = 1 WHERE id = ?').run(existing.id);
      return getTableById(existing.id);
    }
    throw new Error(`Table #${num} already exists.`);
  }
  const token = generateSecureToken();
  const res = db.prepare(`
    INSERT INTO tables (restaurant_id, table_number, qr_token, is_active)
    VALUES (?, ?, ?, 1)
  `).run(restaurantId, num, token);
  return getTableById(res.lastInsertRowid);
}

function deleteTable(restaurantId = 1, id) {
  const res = db.prepare('UPDATE tables SET is_active = 0 WHERE id = ? AND restaurant_id = ?').run(id, restaurantId);
  return res.changes > 0;
}

function regenerateTableToken(restaurantId = 1, id) {
  const newToken = generateSecureToken();
  const res = db.prepare('UPDATE tables SET qr_token = ? WHERE id = ? AND restaurant_id = ?').run(newToken, id, restaurantId);
  if (res.changes === 0) return null;
  return getTableById(id);
}

// Customer Management
function findOrCreateCustomer(phone, name) {
  const cleanedPhone = String(phone).replace(/\D/g, '').slice(-10);
  if (!/^[6-9]\d{9}$/.test(cleanedPhone)) {
    throw new Error('Please provide a valid 10-digit Indian mobile number.');
  }
  const cleanedName = (name || 'Guest').trim();
  if (!cleanedName) {
    throw new Error('Please provide your name.');
  }

  let customer = db.prepare('SELECT * FROM customers WHERE phone = ?').get(cleanedPhone);
  if (customer) {
    db.prepare("UPDATE customers SET name = ?, last_visit = datetime('now', 'localtime') WHERE id = ?")
      .run(cleanedName, customer.id);
    return db.prepare('SELECT * FROM customers WHERE id = ?').get(customer.id);
  }

  const res = db.prepare(`
    INSERT INTO customers (phone, name)
    VALUES (?, ?)
  `).run(cleanedPhone, cleanedName);
  return db.prepare('SELECT * FROM customers WHERE id = ?').get(res.lastInsertRowid);
}

function getCustomerById(id) {
  return db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
}

function getAllCustomers(restaurantId = 1) {
  return db.prepare(`
    SELECT 
      c.id,
      c.name,
      c.phone,
      c.last_visit,
      COUNT(o.id) as total_orders,
      COALESCE(SUM(o.total_amount), 0) as total_spent
    FROM customers c
    LEFT JOIN orders o ON o.customer_id = c.id AND o.status != 'Cancelled'
    GROUP BY c.id
    ORDER BY c.last_visit DESC
  `).all();
}

// Menu Queries
function getMenu(restaurantId = 1, includeUnavailable = true) {
  if (includeUnavailable) {
    return db.prepare('SELECT * FROM menu_items WHERE restaurant_id = ? ORDER BY category, id').all(restaurantId);
  }
  return db.prepare('SELECT * FROM menu_items WHERE restaurant_id = ? AND is_available = 1 ORDER BY category, id').all(restaurantId);
}

function getMenuItem(id) {
  return db.prepare('SELECT * FROM menu_items WHERE id = ?').get(id);
}

function addMenuItem({ restaurant_id = 1, name, category, price, description = '', is_veg = 1, is_available = 1, image_emoji = '🍽️' }) {
  const stmt = db.prepare(`
    INSERT INTO menu_items (restaurant_id, name, category, price, description, is_veg, is_available, image_emoji)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    restaurant_id,
    name.trim(),
    category.trim(),
    Number(price),
    description ? description.trim() : '',
    is_veg ? 1 : 0,
    is_available ? 1 : 0,
    image_emoji || '🍽️'
  );
  return getMenuItem(result.lastInsertRowid);
}

function updateMenuItem(id, { name, category, price, description, is_veg, is_available, image_emoji }) {
  const current = getMenuItem(id);
  if (!current) return null;

  const stmt = db.prepare(`
    UPDATE menu_items
    SET name = ?, category = ?, price = ?, description = ?, is_veg = ?, is_available = ?, image_emoji = ?
    WHERE id = ?
  `);

  stmt.run(
    name !== undefined ? name.trim() : current.name,
    category !== undefined ? category.trim() : current.category,
    price !== undefined ? Number(price) : current.price,
    description !== undefined ? description.trim() : current.description,
    is_veg !== undefined ? (is_veg ? 1 : 0) : current.is_veg,
    is_available !== undefined ? (is_available ? 1 : 0) : current.is_available,
    image_emoji !== undefined ? image_emoji : current.image_emoji,
    id
  );
  return getMenuItem(id);
}

function deleteMenuItem(id) {
  const res = db.prepare('DELETE FROM menu_items WHERE id = ?').run(id);
  return res.changes > 0;
}

function toggleItemAvailability(id, is_available) {
  db.prepare('UPDATE menu_items SET is_available = ? WHERE id = ?').run(is_available ? 1 : 0, id);
  return getMenuItem(id);
}

// Token Generation - Starts at 1 each day per restaurant
function getNextTokenNumber(restaurantId = 1, dateStr = getTodayDateString()) {
  const row = db.prepare('SELECT MAX(token_number) as max_token FROM orders WHERE restaurant_id = ? AND order_date = ?')
    .get(restaurantId, dateStr);
  return (row && row.max_token) ? row.max_token + 1 : 1;
}

// Create Order Transaction - Server calculates price strictly from DB
function createOrder({ restaurant_id = 1, customer_id = null, table_id = null, table_number, customer_name, customer_phone, items = [], notes = '' }) {
  const tableNum = parseInt(table_number, 10);
  if (!tableNum || tableNum < 1 || tableNum > 500) {
    throw new Error('Invalid table number.');
  }

  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('Your cart is empty. Please add items before placing an order.');
  }

  const today = getTodayDateString();

  const placeOrderTx = db.transaction(() => {
    // Validate every item against DB
    const itemIds = items.map(i => parseInt(i.id || i.menu_item_id, 10)).filter(Boolean);
    if (itemIds.length === 0) {
      throw new Error('Cart does not contain valid menu items.');
    }
    const placeholders = itemIds.map(() => '?').join(',');
    const foundRows = db.prepare(`SELECT * FROM menu_items WHERE id IN (${placeholders}) AND restaurant_id = ?`).all(...itemIds, restaurant_id);
    const itemMap = new Map();
    for (const r of foundRows) itemMap.set(r.id, r);

    let totalAmount = 0;
    const validatedItems = [];

    for (const item of items) {
      const id = parseInt(item.id || item.menu_item_id, 10);
      const qty = parseInt(item.quantity, 10);
      if (!qty || qty <= 0) continue;

      const menuItem = itemMap.get(id);
      if (!menuItem) {
        throw new Error(`Item #${id} is not available on this restaurant menu.`);
      }
      if (menuItem.is_available === 0) {
        throw new Error(`"${menuItem.name}" is currently out of stock. Please remove it to proceed.`);
      }

      totalAmount += menuItem.price * qty;
      validatedItems.push({
        menu_item_id: menuItem.id,
        item_name: menuItem.name,
        price: menuItem.price,
        quantity: qty,
        is_veg: menuItem.is_veg
      });
    }

    if (validatedItems.length === 0) {
      throw new Error('No valid items in the cart.');
    }

    const tokenNumber = getNextTokenNumber(restaurant_id, today);

    const insertOrderStmt = db.prepare(`
      INSERT INTO orders (
        restaurant_id, customer_id, table_id, table_number, token_number,
        order_date, customer_name, customer_phone, status, total_amount, payment_status, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Received', ?, 'Unpaid', ?)
    `);

    const orderResult = insertOrderStmt.run(
      restaurant_id,
      customer_id || null,
      table_id || null,
      tableNum,
      tokenNumber,
      today,
      (customer_name || `Table ${tableNum}`).trim(),
      customer_phone ? String(customer_phone).trim() : null,
      totalAmount,
      (notes || '').trim()
    );

    const orderId = orderResult.lastInsertRowid;

    const insertOrderItemStmt = db.prepare(`
      INSERT INTO order_items (order_id, menu_item_id, item_name, quantity, price, is_veg)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const v of validatedItems) {
      insertOrderItemStmt.run(orderId, v.menu_item_id, v.item_name, v.quantity, v.price, v.is_veg);
    }

    return {
      orderId,
      tokenNumber,
      orderDate: today,
      tableNumber: tableNum,
      totalAmount,
      items: validatedItems
    };
  });

  return placeOrderTx();
}

function getOrderById(id) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  if (!order) return null;
  order.items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);
  return order;
}

function getOrderByToken(tokenNumber, orderDate = getTodayDateString(), restaurantId = 1) {
  const order = db.prepare(`
    SELECT * FROM orders
    WHERE token_number = ? AND order_date = ? AND restaurant_id = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(tokenNumber, orderDate, restaurantId);

  if (!order) return null;
  order.items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(order.id);
  return order;
}

function getActiveOrders(restaurantId = 1) {
  const orders = db.prepare(`
    SELECT * FROM orders
    WHERE restaurant_id = ? AND status IN ('Received', 'Preparing', 'Ready')
    ORDER BY
      CASE status
        WHEN 'Received' THEN 1
        WHEN 'Preparing' THEN 2
        WHEN 'Ready' THEN 3
        ELSE 4
      END,
      id ASC
  `).all(restaurantId);

  const getItemsStmt = db.prepare('SELECT * FROM order_items WHERE order_id = ?');
  for (const o of orders) {
    o.items = getItemsStmt.all(o.id);
  }
  return orders;
}

function getAllOrders(restaurantId = 1, limit = 100, date = null) {
  let query = 'SELECT * FROM orders WHERE restaurant_id = ?';
  const params = [restaurantId];
  if (date) {
    query += ' AND order_date = ?';
    params.push(date);
  }
  query += ' ORDER BY id DESC LIMIT ?';
  params.push(limit);

  const orders = db.prepare(query).all(...params);
  const getItemsStmt = db.prepare('SELECT * FROM order_items WHERE order_id = ?');
  for (const o of orders) {
    o.items = getItemsStmt.all(o.id);
  }
  return orders;
}

function getOrdersByCustomer(customerId) {
  if (!customerId) return [];
  const orders = db.prepare(`
    SELECT * FROM orders
    WHERE customer_id = ?
    ORDER BY id DESC
  `).all(customerId);

  const getItemsStmt = db.prepare('SELECT * FROM order_items WHERE order_id = ?');
  for (const o of orders) {
    o.items = getItemsStmt.all(o.id);
  }
  return orders;
}

function updateOrderStatus(id, newStatus, cancelReason = null) {
  const validStatuses = ['Received', 'Preparing', 'Ready', 'Picked up', 'Cancelled'];
  if (!validStatuses.includes(newStatus)) {
    throw new Error(`Invalid status: ${newStatus}`);
  }

  const order = getOrderById(id);
  if (!order) throw new Error('Order not found.');

  let timestampCol = '';
  if (newStatus === 'Preparing' && !order.preparing_at) {
    timestampCol = ", preparing_at = datetime('now', 'localtime')";
  } else if (newStatus === 'Ready' && !order.ready_at) {
    timestampCol = ", ready_at = datetime('now', 'localtime')";
  } else if (newStatus === 'Picked up' && !order.picked_up_at) {
    timestampCol = ", picked_up_at = datetime('now', 'localtime')";
  }

  if (newStatus === 'Cancelled') {
    db.prepare(`
      UPDATE orders
      SET status = ?, cancel_reason = ? ${timestampCol}
      WHERE id = ?
    `).run(newStatus, (cancelReason || 'Cancelled by staff').trim(), id);
  } else {
    db.prepare(`
      UPDATE orders
      SET status = ? ${timestampCol}
      WHERE id = ?
    `).run(newStatus, id);
  }

  return getOrderById(id);
}

function updateOrderPaymentStatus(id, paymentStatus) {
  const valid = ['Unpaid', 'Paid cash', 'Paid UPI'];
  if (!valid.includes(paymentStatus)) {
    throw new Error(`Invalid payment status: ${paymentStatus}`);
  }
  db.prepare('UPDATE orders SET payment_status = ? WHERE id = ?').run(paymentStatus, id);
  return getOrderById(id);
}

function cancelCustomerOrder(orderId, customerId, reason = 'Cancelled by customer') {
  const order = getOrderById(orderId);
  if (!order) throw new Error('Order not found.');
  if (order.customer_id !== customerId) {
    throw new Error('Access denied: You can only cancel your own orders.');
  }
  if (order.status !== 'Received') {
    throw new Error(`Order cannot be cancelled because it is already ${order.status.toLowerCase()}.`);
  }
  db.prepare(`
    UPDATE orders
    SET status = 'Cancelled', cancel_reason = ?
    WHERE id = ?
  `).run(reason.trim(), orderId);
  return getOrderById(orderId);
}

function getAveragePrepTimeMinutes(restaurantId = 1) {
  const configuredPrep = parseInt(getSetting(restaurantId, 'average_prep_time_minutes', '12'), 10) || 12;
  const row = db.prepare(`
    SELECT AVG((julianday(ready_at) - julianday(created_at)) * 24 * 60) as avg_mins
    FROM orders
    WHERE restaurant_id = ? AND ready_at IS NOT NULL AND status IN ('Ready', 'Picked up')
  `).get(restaurantId);

  if (row && row.avg_mins && row.avg_mins > 0) {
    return Math.max(5, Math.round(row.avg_mins));
  }
  return configuredPrep;
}

function getTrackingInfo(tokenNumber, orderDate = getTodayDateString(), restaurantId = 1) {
  const order = getOrderByToken(tokenNumber, orderDate, restaurantId);
  if (!order) return null;

  const aheadRow = db.prepare(`
    SELECT COUNT(*) as ahead_count
    FROM orders
    WHERE restaurant_id = ?
      AND order_date = ?
      AND status IN ('Received', 'Preparing')
      AND id < ?
  `).get(restaurantId, orderDate, order.id);

  const ordersAhead = aheadRow ? aheadRow.ahead_count : 0;
  const avgPrepTime = getAveragePrepTimeMinutes(restaurantId);

  let estimatedWaitMinutes = 0;
  if (order.status === 'Received') {
    estimatedWaitMinutes = (ordersAhead + 1) * avgPrepTime;
  } else if (order.status === 'Preparing') {
    estimatedWaitMinutes = Math.max(3, Math.round(avgPrepTime * 0.6));
  }

  const preparingTokens = db.prepare(`
    SELECT token_number FROM orders
    WHERE restaurant_id = ? AND order_date = ? AND status = 'Preparing'
    ORDER BY id ASC
  `).all(restaurantId, orderDate).map(r => r.token_number);

  const readyTokens = db.prepare(`
    SELECT token_number FROM orders
    WHERE restaurant_id = ? AND order_date = ? AND status = 'Ready'
    ORDER BY id ASC
  `).all(restaurantId, orderDate).map(r => r.token_number);

  return {
    order,
    ordersAhead,
    estimatedWaitMinutes,
    averagePrepTimeMinutes: avgPrepTime,
    nowPreparingTokens: preparingTokens,
    readyTokens: readyTokens
  };
}

// TV Display Tokens: strictly NO customer names or phone numbers!
function getDisplayTokens(orderDate = getTodayDateString(), restaurantId = 1) {
  const preparing = db.prepare(`
    SELECT token_number, table_number, created_at, status
    FROM orders
    WHERE restaurant_id = ? AND order_date = ? AND status = 'Preparing'
    ORDER BY id ASC
  `).all(restaurantId, orderDate);

  const ready = db.prepare(`
    SELECT token_number, table_number, ready_at, status
    FROM orders
    WHERE restaurant_id = ? AND order_date = ? AND status = 'Ready'
    ORDER BY ready_at DESC, id DESC
  `).all(restaurantId, orderDate);

  return { preparing, ready };
}

// Sales & Analytics for a specific date
function getAnalytics(dateStr = getTodayDateString(), restaurantId = 1) {
  const salesSummary = db.prepare(`
    SELECT 
      COALESCE(SUM(total_amount), 0) as total_sales,
      COUNT(*) as total_orders
    FROM orders
    WHERE restaurant_id = ? AND order_date = ? AND status != 'Cancelled'
  `).get(restaurantId, dateStr);

  const statusCounts = db.prepare(`
    SELECT status, COUNT(*) as count
    FROM orders
    WHERE restaurant_id = ? AND order_date = ?
    GROUP BY status
  `).all(restaurantId, dateStr);

  const paymentCounts = db.prepare(`
    SELECT payment_status, COUNT(*) as count, COALESCE(SUM(total_amount), 0) as total
    FROM orders
    WHERE restaurant_id = ? AND order_date = ? AND status != 'Cancelled'
    GROUP BY payment_status
  `).all(restaurantId, dateStr);

  const avgPrepRow = db.prepare(`
    SELECT AVG((julianday(ready_at) - julianday(created_at)) * 24 * 60) as avg_prep
    FROM orders
    WHERE restaurant_id = ? AND order_date = ? AND ready_at IS NOT NULL
  `).get(restaurantId, dateStr);

  const avgPrepTime = (avgPrepRow && avgPrepRow.avg_prep) 
    ? Math.round(avgPrepRow.avg_prep) 
    : getAveragePrepTimeMinutes(restaurantId);

  const topItems = db.prepare(`
    SELECT 
      oi.item_name,
      SUM(oi.quantity) as total_qty,
      SUM(oi.quantity * oi.price) as total_revenue
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    WHERE o.restaurant_id = ? AND o.order_date = ? AND o.status != 'Cancelled'
    GROUP BY oi.item_name
    ORDER BY total_qty DESC, total_revenue DESC
    LIMIT 5
  `).all(restaurantId, dateStr);

  const hourlyRows = db.prepare(`
    SELECT 
      CAST(strftime('%H', created_at) AS INTEGER) as hour,
      SUM(total_amount) as sales,
      COUNT(*) as orders_count
    FROM orders
    WHERE restaurant_id = ? AND order_date = ? AND status != 'Cancelled'
    GROUP BY hour
    ORDER BY hour ASC
  `).all(restaurantId, dateStr);

  const salesByHour = Array.from({ length: 24 }, (_, h) => {
    const found = hourlyRows.find(r => r.hour === h);
    return {
      hour: h,
      label: `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? 'AM' : 'PM'}`,
      sales: found ? found.sales : 0,
      orders: found ? found.orders_count : 0
    };
  });

  return {
    date: dateStr,
    totalSales: salesSummary.total_sales,
    totalOrders: salesSummary.total_orders,
    averagePrepTimeMinutes: avgPrepTime,
    statusCounts,
    paymentCounts,
    topItems,
    salesByHour
  };
}

// CSV Export data helper
function getOrdersForCsv(dateStr, restaurantId = 1) {
  let query = `
    SELECT 
      o.id as order_id,
      o.token_number,
      o.order_date,
      o.created_at,
      o.table_number,
      o.customer_name,
      o.customer_phone,
      o.status,
      o.cancel_reason,
      o.payment_status,
      o.total_amount,
      o.notes,
      GROUP_CONCAT(oi.item_name || ' x' || oi.quantity, ' ; ') as items_summary
    FROM orders o
    LEFT JOIN order_items oi ON oi.order_id = o.id
    WHERE o.restaurant_id = ?
  `;
  const params = [restaurantId];
  if (dateStr) {
    query += ' AND o.order_date = ?';
    params.push(dateStr);
  }
  query += ' GROUP BY o.id ORDER BY o.id ASC';
  return db.prepare(query).all(...params);
}

// Initialize on module load
initDatabase();

module.exports = {
  db,
  getTodayDateString,
  generateSecureToken,
  getDefaultRestaurant,
  getRestaurantById,
  updateRestaurantName,
  getOwnersCount,
  getTotalOwnersCount,
  getOwnerByPhone,
  getOwnerById,
  createOwner,
  getSettings,
  getSetting,
  updateSettings,
  getTables,
  getTableByToken,
  getTableById,
  addTable,
  deleteTable,
  regenerateTableToken,
  findOrCreateCustomer,
  getCustomerById,
  getAllCustomers,
  getMenu,
  getMenuItem,
  addMenuItem,
  updateMenuItem,
  deleteMenuItem,
  toggleItemAvailability,
  getNextTokenNumber,
  createOrder,
  getOrderById,
  getOrderByToken,
  getActiveOrders,
  getAllOrders,
  getOrdersByCustomer,
  updateOrderStatus,
  updateOrderPaymentStatus,
  cancelCustomerOrder,
  getAveragePrepTimeMinutes,
  getTrackingInfo,
  getDisplayTokens,
  getAnalytics,
  getOrdersForCsv
};
