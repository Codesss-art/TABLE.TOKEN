/**
 * TableToken — 26-Test Hard Production Test Suite
 *
 * Tests:
 *  1  Security — /menu without QR → 403
 *  2  Security — /api/owner/menu without owner login → 401
 *  3  Security — customer session on owner API → 403/401
 *  4  QR token — scan valid token → table session assigned
 *  5  QR token — scan fake token → rejected
 *  6  QR token — scan revoked token after regen → rejected
 *  7  Customer login — valid Indian phone (6–9 start) → accepted
 *  8  Customer login — invalid phone (1234567890) → rejected
 *  9  Customer login — empty name → rejected
 * 10  Order — server ignores client price, uses DB price
 * 11  Order — out-of-stock item → rejected
 * 12  Order — empty cart → rejected
 * 13  Cancel — while Received → allowed
 * 14  Cancel — while Preparing → blocked
 * 15  Status flow — Received → Preparing → Ready → Picked up
 * 16  Owner auth — wrong password → 401
 * 17  Owner auth — correct password → session created
 * 18  Owner auth — brute force (21 wrong attempts) → 429 rate limited
 * 19  Menu mgmt — add new dish → appears in customer menu
 * 20  Menu mgmt — toggle out-of-stock → dish blocked from ordering
 * 21  Menu mgmt — delete dish → no longer appears
 * 22  Table mgmt — regenerate QR → old rejected, new works
 * 23  Analytics — 3 orders, completed, total sales matches
 * 24  CSV export — valid CSV with correct headers & data
 * 25  TV display — no customer name or phone in /api/display/tokens
 * 26  Session expiry — expired table session → 403 blocked
 */

'use strict';

const assert = require('assert');
const http   = require('http');
const db     = require('../db');
const app    = require('../server');

const TEST_PORT = 3199;
let serverInstance;

// ─── HTTP Client with cookie jar ───────────────────────────────────────────
class HttpClient {
  constructor(port) { this.port = port; this.cookies = []; }

  request(method, reqPath, body = null, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
      const payload = body !== null ? JSON.stringify(body) : null;
      const headers = {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...extraHeaders
      };
      if (this.cookies.length > 0) headers['Cookie'] = this.cookies.join('; ');

      const req = http.request(
        { hostname: '127.0.0.1', port: this.port, path: reqPath, method, headers },
        (res) => {
          const setCookieHeaders = res.headers['set-cookie'];
          if (setCookieHeaders) {
            for (const sc of setCookieHeaders) {
              const part = sc.split(';')[0];
              const name = part.split('=')[0];
              this.cookies = this.cookies.filter(c => !c.startsWith(`${name}=`));
              this.cookies.push(part);
            }
          }
          let raw = '';
          res.on('data', chunk => (raw += chunk));
          res.on('end', () => {
            let parsed = null;
            try { parsed = raw ? JSON.parse(raw) : null; } catch (_) { parsed = raw; }
            resolve({ status: res.statusCode, headers: res.headers, body: parsed });
          });
        }
      );
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  get(p, h)    { return this.request('GET',    p, null, h); }
  post(p, b, h){ return this.request('POST',   p, b,    h); }
  put(p, b, h) { return this.request('PUT',    p, b,    h); }
  delete(p, h) { return this.request('DELETE', p, null, h); }
}

// ─── Test runner helpers ────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function pass(n, msg) {
  passed++;
  console.log(`  ✅ PASS [Test ${n}] ${msg}`);
}

function fail(n, msg, err) {
  failed++;
  console.error(`  ❌ FAIL [Test ${n}] ${msg}`);
  if (err) console.error('      →', err.message || err);
}

async function runTest(n, label, fn) {
  process.stdout.write(`\n[Test ${n}] ${label}\n`);
  try {
    await fn();
  } catch (err) {
    fail(n, label, err);
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function runTests() {
  console.log('\n==================================================================');
  console.log('🚀  TABLETOKEN 26-TEST HARD PRODUCTION SUITE');
  console.log('==================================================================\n');

  // ── Clean slate ──────────────────────────────────────────────────────────
  try {
    db.db.prepare('DELETE FROM owners').run();
    db.db.prepare('DELETE FROM order_items').run();
    db.db.prepare('DELETE FROM orders').run();
    db.db.prepare('DELETE FROM customers').run();
    db.db.prepare('DELETE FROM sessions').run();
  } catch (_) {}

  // Start dedicated test server
  await new Promise(resolve => {
    serverInstance = app.listen(TEST_PORT, '127.0.0.1', () => {
      console.log(`[Setup] Test server: http://127.0.0.1:${TEST_PORT}`);
      resolve();
    });
  });

  // Clients
  const anon     = new HttpClient(TEST_PORT); // no session
  const customer = new HttpClient(TEST_PORT); // will get table + customer session
  const owner    = new HttpClient(TEST_PORT); // will get owner session
  const bf       = new HttpClient(TEST_PORT); // brute-force client (fresh cookies)

  // Grab tables from DB (seeded on first run)
  const tables = db.getTables(1);
  assert.ok(tables.length >= 10, 'Need at least 10 seeded tables');
  const testTable = tables.find(t => t.table_number === 7) || tables[0];

  // ════════════════════════════════════════════════════════════════════════
  // TEST 1 — /menu without QR scan → 403
  // ════════════════════════════════════════════════════════════════════════
  await runTest(1, 'Access /menu without QR scan → 403', async () => {
    const r = await anon.get('/api/menu');
    assert.strictEqual(r.status, 403, `Expected 403 got ${r.status}`);
    assert.strictEqual(r.body.success, false);
    assert.ok(r.body.error.includes('QR code'), `Error: ${r.body.error}`);
    pass(1, '/api/menu → 403 without table session');
  });

  // ════════════════════════════════════════════════════════════════════════
  // TEST 2 — /api/owner/menu without owner login → 401
  // ════════════════════════════════════════════════════════════════════════
  await runTest(2, 'Access /api/owner/menu without owner login → 401', async () => {
    const r = await anon.get('/api/owner/menu');
    assert.strictEqual(r.status, 401, `Expected 401 got ${r.status}`);
    assert.strictEqual(r.body.success, false);
    pass(2, '/api/owner/menu → 401 without owner session');
  });

  // ════════════════════════════════════════════════════════════════════════
  // TEST 3 — customer session cannot call owner APIs → 401 or 403
  // ════════════════════════════════════════════════════════════════════════
  // First give customer a valid scan+login, then try owner endpoint
  await runTest(3, 'Customer session blocked from owner API', async () => {
    // Scan table
    const scan = await customer.get(`/scan/${testTable.qr_token}`);
    assert.strictEqual(scan.status, 302);

    // Login
    const login = await customer.post('/api/customer/login', { phone: '9876543210', name: 'Ravi Kumar' });
    assert.strictEqual(login.status, 200);

    // Try owner route
    const r = await customer.get('/api/owner/orders/active');
    assert.ok(r.status === 401 || r.status === 403, `Expected 401/403 got ${r.status}`);
    pass(3, `Customer blocked from owner API (got ${r.status})`);
  });

  // ════════════════════════════════════════════════════════════════════════
  // TEST 4 — scan valid token → table session assigned
  // ════════════════════════════════════════════════════════════════════════
  await runTest(4, 'Valid QR token → table session assigned', async () => {
    const freshClient = new HttpClient(TEST_PORT);
    const r = await freshClient.get(`/scan/${testTable.qr_token}`);
    assert.strictEqual(r.status, 302, `Expected 302 redirect got ${r.status}`);
    assert.ok(
      r.headers.location.includes('/customer/login'),
      `Should redirect to /customer/login, got: ${r.headers.location}`
    );
    assert.ok(
      freshClient.cookies.some(c => c.startsWith('tabletoken.sid=')),
      'Session cookie must be issued after scan'
    );
    pass(4, `Table #${testTable.table_number} scanned → session issued`);
  });

  // ════════════════════════════════════════════════════════════════════════
  // TEST 5 — scan fake token → rejected
  // ════════════════════════════════════════════════════════════════════════
  await runTest(5, 'Fake/random QR token → rejected', async () => {
    const r = await anon.get('/scan/this-is-a-completely-fake-token-xyz-9999');
    assert.strictEqual(r.status, 302, `Expected redirect got ${r.status}`);
    assert.ok(
      r.headers.location.includes('/scan-error'),
      `Should redirect to /scan-error, got: ${r.headers.location}`
    );
    pass(5, 'Fake token rejected → redirected to /scan-error');
  });

  // ════════════════════════════════════════════════════════════════════════
  // TEST 6 — scan revoked token after regeneration → rejected
  // ════════════════════════════════════════════════════════════════════════
  await runTest(6, 'Revoked token (after regen) → rejected', async () => {
    // Create owner temporarily for this operation
    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash('temppass123', 10);
    db.createOwner({ restaurant_id: 1, phone: '9000000006', password_hash: hash, full_name: 'Temp Owner' });

    const tempOwner = new HttpClient(TEST_PORT);
    await tempOwner.post('/api/owner/login', { phone: '9000000006', password: 'temppass123' });

    const oldToken = testTable.qr_token;

    // Regenerate
    const regen = await tempOwner.post(`/api/owner/tables/${testTable.id}/regenerate-qr`);
    assert.strictEqual(regen.status, 200, `Regen failed: ${JSON.stringify(regen.body)}`);
    assert.notStrictEqual(regen.body.data.qr_token, oldToken, 'Token must change after regen');

    // Try old token
    const scanOld = await anon.get(`/scan/${oldToken}`);
    assert.ok(
      scanOld.headers.location && scanOld.headers.location.includes('/scan-error'),
      `Old token should be rejected, got: ${scanOld.headers.location}`
    );

    // New token must work
    const newToken = regen.body.data.qr_token;
    const scanNew = await anon.get(`/scan/${newToken}`);
    assert.strictEqual(scanNew.status, 302);
    assert.ok(scanNew.headers.location.includes('/customer/login'), 'New token should work');

    // Update testTable reference & customer client for subsequent tests
    testTable.qr_token = newToken;
    // Reset customer client with new valid scan
    customer.cookies = [];
    await customer.get(`/scan/${newToken}`);

    // Cleanup temp owner
    db.db.prepare('DELETE FROM owners WHERE phone = ?').run('9000000006');

    pass(6, 'Revoked token rejected; new token accepted');
  });

  // ════════════════════════════════════════════════════════════════════════
  // TEST 7 — valid Indian phone (6–9 start) → accepted
  // ════════════════════════════════════════════════════════════════════════
  await runTest(7, 'Valid 10-digit Indian phone (6–9 prefix) → accepted', async () => {
    // customer client already has a table scan from test 3 / test 6
    const r = await customer.post('/api/customer/login', { phone: '9876543210', name: 'Priya Sharma' });
    assert.strictEqual(r.status, 200, `Login failed: ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.success, true);
    assert.strictEqual(r.body.data.customer.phone, '9876543210');
    pass(7, `Valid Indian phone accepted; logged in as ${r.body.data.customer.name}`);
  });

  // ════════════════════════════════════════════════════════════════════════
  // TEST 8 — invalid phone → rejected
  // ════════════════════════════════════════════════════════════════════════
  await runTest(8, 'Invalid phone (starts with 1) → rejected', async () => {
    // Need a fresh client with a valid table scan
    const c8 = new HttpClient(TEST_PORT);
    await c8.get(`/scan/${testTable.qr_token}`);

    const r = await c8.post('/api/customer/login', { phone: '1234567890', name: 'Test' });
    assert.strictEqual(r.status, 400, `Expected 400 got ${r.status}`);
    assert.strictEqual(r.body.success, false);
    assert.ok(r.body.error.toLowerCase().includes('10-digit'), `Error: ${r.body.error}`);

    const r2 = await c8.post('/api/customer/login', { phone: '12345', name: 'Test' });
    assert.strictEqual(r2.status, 400);
    pass(8, 'Invalid phone numbers properly rejected');
  });

  // ════════════════════════════════════════════════════════════════════════
  // TEST 9 — empty name → rejected
  // ════════════════════════════════════════════════════════════════════════
  await runTest(9, 'Empty name → rejected', async () => {
    const c9 = new HttpClient(TEST_PORT);
    await c9.get(`/scan/${testTable.qr_token}`);

    const r = await c9.post('/api/customer/login', { phone: '9876543210', name: '' });
    assert.strictEqual(r.status, 400, `Expected 400 got ${r.status}`);
    assert.strictEqual(r.body.success, false);
    pass(9, 'Empty name rejected with 400');
  });

  // ════════════════════════════════════════════════════════════════════════
  // TEST 10 — server ignores client price, uses DB price
  // ════════════════════════════════════════════════════════════════════════
  await runTest(10, 'Server recalculates price from DB (ignores client price)', async () => {
    const menuRes = await customer.get('/api/menu');
    assert.strictEqual(menuRes.status, 200);
    const menu = menuRes.body.data;
    assert.ok(menu.length >= 2, `Need at least 2 menu items, got ${menu.length}`);

    const dish1 = menu[0];
    const dish2 = menu[4] || menu[1];
    const expectedTotal = (dish1.price * 2) + (dish2.price * 1);

    const orderRes = await customer.post('/api/orders', {
      items: [
        { menu_item_id: dish1.id, quantity: 2, price: 1 },   // tampered ₹1
        { menu_item_id: dish2.id, quantity: 1, price: 999 }  // tampered ₹999
      ],
      notes: 'Test order price check'
    });

    assert.strictEqual(orderRes.status, 201, `Order failed: ${JSON.stringify(orderRes.body)}`);
    assert.strictEqual(
      orderRes.body.data.totalAmount,
      expectedTotal,
      `Expected ₹${expectedTotal} but got ₹${orderRes.body.data.totalAmount}`
    );

    // Store for downstream tests
    global._testOrder1 = orderRes.body.data;
    global._testDish1  = dish1;
    global._testDish2  = dish2;
    global._testMenu   = menu;
    pass(10, `Server-calculated ₹${orderRes.body.data.totalAmount} matches expected ₹${expectedTotal}`);
  });

  // ════════════════════════════════════════════════════════════════════════
  // TEST 11 — out-of-stock item → rejected
  // ════════════════════════════════════════════════════════════════════════
  await runTest(11, 'Out-of-stock item → rejected with message', async () => {
    const dish = global._testMenu[2] || global._testMenu[1];
    db.toggleItemAvailability(dish.id, 0);  // mark out of stock

    const r = await customer.post('/api/orders', {
      items: [{ menu_item_id: dish.id, quantity: 1 }]
    });
    assert.strictEqual(r.status, 400, `Expected 400 got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(r.body.error.toLowerCase().includes('out of stock'), `Error: ${r.body.error}`);

    db.toggleItemAvailability(dish.id, 1);  // restore
    pass(11, `Out-of-stock correctly rejected: "${r.body.error}"`);
  });

  // ════════════════════════════════════════════════════════════════════════
  // TEST 12 — empty cart → rejected
  // ════════════════════════════════════════════════════════════════════════
  await runTest(12, 'Empty cart → rejected', async () => {
    const r = await customer.post('/api/orders', { items: [] });
    assert.strictEqual(r.status, 400, `Expected 400 got ${r.status}`);
    assert.strictEqual(r.body.success, false);
    pass(12, `Empty cart rejected: "${r.body.error}"`);
  });

  // ════════════════════════════════════════════════════════════════════════
  // TEST 13 — cancel while Received → allowed
  // ════════════════════════════════════════════════════════════════════════
  await runTest(13, 'Cancel while Received → allowed', async () => {
    const orderId = global._testOrder1.orderId;
    const r = await customer.post(`/api/orders/${orderId}/cancel`, { reason: 'Changed my mind' });
    assert.strictEqual(r.status, 200, `Cancel failed: ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.data.status, 'Cancelled');
    assert.strictEqual(r.body.data.cancel_reason, 'Changed my mind');
    pass(13, `Order #${global._testOrder1.tokenNumber} cancelled while Received`);
  });

  // ════════════════════════════════════════════════════════════════════════
  // TEST 14 — cancel while Preparing → blocked
  // Need an owner session first → setup owner
  // ════════════════════════════════════════════════════════════════════════
  await runTest(14, 'Cancel while Preparing → blocked (400)', async () => {
    // Setup owner
    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash('ownerpass123', 10);
    db.createOwner({ restaurant_id: 1, phone: '9100000014', password_hash: hash, full_name: 'Test Owner 14' });
    const tmpOwner = new HttpClient(TEST_PORT);
    await tmpOwner.post('/api/owner/login', { phone: '9100000014', password: 'ownerpass123' });

    // Place a new order
    const orderRes = await customer.post('/api/orders', {
      items: [{ menu_item_id: global._testDish1.id, quantity: 1 }]
    });
    assert.strictEqual(orderRes.status, 201);
    const orderId = orderRes.body.data.orderId;

    // Advance to Preparing
    const prep = await tmpOwner.put(`/api/owner/orders/${orderId}/status`, { status: 'Preparing' });
    assert.strictEqual(prep.status, 200);

    // Customer tries to cancel → should fail
    const r = await customer.post(`/api/orders/${orderId}/cancel`, { reason: 'Too late' });
    assert.strictEqual(r.status, 400, `Expected 400 got ${r.status}: ${JSON.stringify(r.body)}`);

    // Store for test 15
    global._testOrderPrep = { orderId, tmpOwner };
    db.db.prepare('DELETE FROM owners WHERE phone = ?').run('9100000014');

    pass(14, 'Cancel while Preparing correctly blocked');
  });

  // ════════════════════════════════════════════════════════════════════════
  // TEST 15 — Full status flow: Received → Preparing → Ready → Picked up
  // ════════════════════════════════════════════════════════════════════════
  await runTest(15, 'Full status flow: Received → Preparing → Ready → Picked up', async () => {
    // Create fresh owner for status test
    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash('statuspass15', 10);
    db.createOwner({ restaurant_id: 1, phone: '9100000015', password_hash: hash, full_name: 'Status Owner' });
    const statusOwner = new HttpClient(TEST_PORT);
    await statusOwner.post('/api/owner/login', { phone: '9100000015', password: 'statuspass15' });

    // Place a fresh order
    const orderRes = await customer.post('/api/orders', {
      items: [{ menu_item_id: global._testDish1.id, quantity: 1 }]
    });
    assert.strictEqual(orderRes.status, 201);
    const orderId = orderRes.body.data.orderId;

    // Received → Preparing
    let r = await statusOwner.put(`/api/owner/orders/${orderId}/status`, { status: 'Preparing' });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.data.status, 'Preparing');

    // Preparing → Ready
    r = await statusOwner.put(`/api/owner/orders/${orderId}/status`, { status: 'Ready' });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.data.status, 'Ready');

    // Ready → Picked up
    r = await statusOwner.put(`/api/owner/orders/${orderId}/status`, { status: 'Picked up' });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.data.status, 'Picked up');

    db.db.prepare('DELETE FROM owners WHERE phone = ?').run('9100000015');
    pass(15, 'Full status flow Received → Preparing → Ready → Picked up verified');
  });

  // ════════════════════════════════════════════════════════════════════════
  // TEST 16 — wrong password → 401
  // ════════════════════════════════════════════════════════════════════════
  await runTest(16, 'Wrong password → 401', async () => {
    // Create the main owner account for tests 16–24
    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash('SecurePass@2025', 10);
    db.createOwner({
      restaurant_id: 1,
      phone: '9800000016',
      password_hash: hash,
      full_name: 'Main Test Owner'
    });

    const r = await owner.post('/api/owner/login', { phone: '9800000016', password: 'wrongpassword' });
    assert.strictEqual(r.status, 401, `Expected 401 got ${r.status}`);
    assert.strictEqual(r.body.success, false);
    pass(16, 'Wrong password correctly returns 401');
  });

  // ════════════════════════════════════════════════════════════════════════
  // TEST 17 — correct password → session created
  // ════════════════════════════════════════════════════════════════════════
  await runTest(17, 'Correct password → owner session created', async () => {
    const r = await owner.post('/api/owner/login', { phone: '9800000016', password: 'SecurePass@2025' });
    assert.strictEqual(r.status, 200, `Login failed: ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.success, true);
    assert.strictEqual(r.body.data.phone, '9800000016');
    assert.ok(owner.cookies.some(c => c.startsWith('tabletoken.sid=')), 'Owner session cookie missing');
    pass(17, `Owner session created for phone 9800000016`);
  });

  // ════════════════════════════════════════════════════════════════════════
  // TEST 18 — brute force (21 wrong attempts) → rate-limited 429
  // Max is 20 per 15 min; 21st attempt should get 429
  // ════════════════════════════════════════════════════════════════════════
  await runTest(18, 'Brute force 21 wrong attempts → 429 rate limited', async () => {
    let got429 = false;
    for (let i = 0; i < 22; i++) {
      const r = await bf.post('/api/owner/login', { phone: '9800000016', password: `wrongpwd${i}` });
      if (r.status === 429) {
        got429 = true;
        break;
      }
    }
    assert.ok(got429, 'Should get 429 after exceeding the rate limit window');
    pass(18, 'Rate limit triggered → 429 after repeated wrong attempts');
  });

  // ════════════════════════════════════════════════════════════════════════
  // TEST 19 — add new dish → appears in customer menu
  // ════════════════════════════════════════════════════════════════════════
  await runTest(19, 'Add new dish → appears in customer menu', async () => {
    const r = await owner.post('/api/owner/menu', {
      name: 'Test Prawn Biryani',
      category: 'Biryani',
      price: 450,
      description: 'Spicy coastal prawn rice',
      is_veg: false,
      is_available: true,
      image_emoji: '🦐'
    });
    assert.strictEqual(r.status, 201, `Add menu failed: ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.data.name, 'Test Prawn Biryani');
    global._testNewDishId = r.body.data.id;

    const menuRes = await customer.get('/api/menu');
    const found = menuRes.body.data.find(d => d.name === 'Test Prawn Biryani');
    assert.ok(found, 'New dish not found in customer menu after adding');
    pass(19, `New dish "Test Prawn Biryani" (id=${global._testNewDishId}) appears in customer menu`);
  });

  // ════════════════════════════════════════════════════════════════════════
  // TEST 20 — toggle out-of-stock → dish blocked from ordering
  // ════════════════════════════════════════════════════════════════════════
  await runTest(20, 'Toggle out-of-stock → blocked from ordering', async () => {
    // Mark out of stock via owner API
    const toggleRes = await owner.put(`/api/owner/menu/${global._testNewDishId}/toggle`, { is_available: 0 });
    assert.strictEqual(toggleRes.status, 200, `Toggle failed: ${JSON.stringify(toggleRes.body)}`);
    assert.strictEqual(toggleRes.body.data.is_available, 0);

    // Customer tries to order it → rejected
    const orderRes = await customer.post('/api/orders', {
      items: [{ menu_item_id: global._testNewDishId, quantity: 1 }]
    });
    assert.strictEqual(orderRes.status, 400, `Expected 400 got ${orderRes.status}`);
    assert.ok(orderRes.body.error.toLowerCase().includes('out of stock'), `Error: ${orderRes.body.error}`);

    pass(20, 'Out-of-stock toggle blocks ordering immediately');
  });

  // ════════════════════════════════════════════════════════════════════════
  // TEST 21 — delete dish → no longer appears in menu
  // ════════════════════════════════════════════════════════════════════════
  await runTest(21, 'Delete dish → no longer in customer menu', async () => {
    const r = await owner.delete(`/api/owner/menu/${global._testNewDishId}`);
    assert.strictEqual(r.status, 200, `Delete failed: ${JSON.stringify(r.body)}`);

    const menuRes = await customer.get('/api/menu');
    const found = menuRes.body.data.find(d => d.id === global._testNewDishId);
    assert.strictEqual(found, undefined, 'Deleted dish still appears in customer menu!');
    pass(21, 'Deleted dish no longer in customer menu');
  });

  // ════════════════════════════════════════════════════════════════════════
  // TEST 22 — regenerate QR → old rejected, new works
  // ════════════════════════════════════════════════════════════════════════
  await runTest(22, 'Regenerate QR token → old rejected, new accepted', async () => {
    const currentToken = testTable.qr_token;
    const regen = await owner.post(`/api/owner/tables/${testTable.id}/regenerate-qr`);
    assert.strictEqual(regen.status, 200, `Regen failed: ${JSON.stringify(regen.body)}`);
    const newToken = regen.body.data.qr_token;
    assert.notStrictEqual(newToken, currentToken, 'Token must change after regeneration');

    // Old token must fail
    const oldScan = await anon.get(`/scan/${currentToken}`);
    assert.ok(oldScan.headers.location.includes('/scan-error'), `Old token should be rejected`);

    // New token must succeed
    const freshC = new HttpClient(TEST_PORT);
    const newScan = await freshC.get(`/scan/${newToken}`);
    assert.strictEqual(newScan.status, 302);
    assert.ok(newScan.headers.location.includes('/customer/login'), 'New token must work');

    testTable.qr_token = newToken;
    pass(22, 'QR token regeneration: old revoked, new accepted');
  });

  // ════════════════════════════════════════════════════════════════════════
  // TEST 23 — place 3 orders, complete them, check analytics total
  // ════════════════════════════════════════════════════════════════════════
  await runTest(23, 'Analytics: 3 completed orders → total sales matches', async () => {
    // Reset customer session with new QR token
    customer.cookies = [];
    await customer.get(`/scan/${testTable.qr_token}`);
    const login23 = await customer.post('/api/customer/login', { phone: '9876543210', name: 'Priya Sharma' });
    assert.strictEqual(login23.status, 200);

    const menuRes = await customer.get('/api/menu');
    const menu = menuRes.body.data;

    let analyticsExpectedTotal = 0;
    const orderIds = [];

    for (let i = 0; i < 3; i++) {
      const item = menu[i % menu.length];
      const qty = i + 1;
      const r = await customer.post('/api/orders', {
        items: [{ menu_item_id: item.id, quantity: qty }]
      });
      assert.strictEqual(r.status, 201, `Order ${i+1} failed: ${JSON.stringify(r.body)}`);
      analyticsExpectedTotal += item.price * qty;
      orderIds.push(r.body.data.orderId);
    }

    // Complete all 3 orders as owner
    for (const id of orderIds) {
      await owner.put(`/api/owner/orders/${id}/status`, { status: 'Preparing' });
      await owner.put(`/api/owner/orders/${id}/status`, { status: 'Ready' });
      await owner.put(`/api/owner/orders/${id}/status`, { status: 'Picked up' });
    }

    const today = db.getTodayDateString();
    const analyticsRes = await owner.get(`/api/owner/analytics?date=${today}`);
    assert.strictEqual(analyticsRes.status, 200);
    const { totalSales, totalOrders } = analyticsRes.body.data;

    // totalSales from analytics must be >= our 3 orders (may include earlier test orders)
    assert.ok(totalSales >= analyticsExpectedTotal,
      `Analytics total ₹${totalSales} should be >= placed ₹${analyticsExpectedTotal}`);
    assert.ok(totalOrders >= 3, `Expected ≥3 orders, got ${totalOrders}`);

    pass(23, `Analytics: totalSales=₹${totalSales}, totalOrders=${totalOrders} (expected ≥₹${analyticsExpectedTotal})`);
  });

  // ════════════════════════════════════════════════════════════════════════
  // TEST 24 — CSV export → valid CSV with correct headers & data
  // ════════════════════════════════════════════════════════════════════════
  await runTest(24, 'CSV export → valid format with correct headers', async () => {
    const today = db.getTodayDateString();
    const r = await owner.get(`/api/owner/orders/export-csv?date=${today}`);
    assert.strictEqual(r.status, 200, `CSV export failed: ${r.status}`);
    assert.ok(r.headers['content-type'].includes('text/csv'), `Wrong content-type: ${r.headers['content-type']}`);
    assert.ok(typeof r.body === 'string', 'CSV body should be a string');

    const lines = r.body.split('\r\n');
    const headers = lines[0];
    assert.ok(headers.includes('Order ID'), `Missing 'Order ID' in headers: ${headers}`);
    assert.ok(headers.includes('Token Number'), `Missing 'Token Number': ${headers}`);
    assert.ok(headers.includes('Customer Name'), `Missing 'Customer Name': ${headers}`);
    assert.ok(headers.includes('Total Amount'), `Missing 'Total Amount': ${headers}`);
    assert.ok(lines.length >= 2, `CSV should have at least one data row`);

    pass(24, `CSV exported ${lines.length - 1} orders with correct headers`);
  });

  // ════════════════════════════════════════════════════════════════════════
  // TEST 25 — TV display: NO customer name or phone in /api/display/tokens
  // ════════════════════════════════════════════════════════════════════════
  await runTest(25, 'TV display: no customer PII exposed', async () => {
    const r = await anon.get('/api/display/tokens');
    assert.strictEqual(r.status, 200, `Display API failed: ${r.status}`);
    assert.ok(r.body.success, 'Display response should succeed');
    assert.ok(Array.isArray(r.body.data.preparing), 'Should have preparing array');
    assert.ok(Array.isArray(r.body.data.ready), 'Should have ready array');

    const all = [...r.body.data.preparing, ...r.body.data.ready];
    for (const token of all) {
      assert.strictEqual(token.customer_name,  undefined, `customer_name exposed in display token!`);
      assert.strictEqual(token.customer_phone, undefined, `customer_phone exposed in display token!`);
      assert.strictEqual(token.notes,          undefined, `notes exposed in display token!`);
    }
    pass(25, `TV display verified: ${all.length} tokens, zero PII exposed`);
  });

  // ════════════════════════════════════════════════════════════════════════
  // TEST 26 — Expired table session → 403 blocked
  // Simulate by setting scannedAt to 4 hours ago in the session store
  // ════════════════════════════════════════════════════════════════════════
  await runTest(26, 'Expired table session → customer blocked (403)', async () => {
    // Create a fresh client and give it a valid session
    const expiredClient = new HttpClient(TEST_PORT);
    await expiredClient.get(`/scan/${testTable.qr_token}`);
    const loginR = await expiredClient.post('/api/customer/login', { phone: '9100000026', name: 'Expire Test' });
    assert.strictEqual(loginR.status, 200, `Login for expiry test failed: ${JSON.stringify(loginR.body)}`);

    // Find the session in DB and manually backdating scannedAt by 4 hours
    const fourHoursAgoMs = Date.now() - (4 * 60 * 60 * 1000);
    const sidCookie = expiredClient.cookies.find(c => c.startsWith('tabletoken.sid='));
    assert.ok(sidCookie, 'Session cookie not found for expiry test');

    // Parse the session ID from the cookie
    let rawSid = sidCookie.split('=')[1];
    // The session ID is URL-encoded and signed; extract from DB by updating all sessions
    // We'll find session by its data (more robust approach: read all and find the one with our customer)
    const sessions = db.db.prepare('SELECT sid, sess FROM sessions').all();
    let targetSid = null;
    for (const s of sessions) {
      try {
        const sessData = JSON.parse(s.sess);
        if (sessData.customer && sessData.customer.phone === '9100000026') {
          targetSid = s.sid;
          // Backdate scannedAt in the session data
          sessData.table.scannedAt = fourHoursAgoMs;
          db.db.prepare('UPDATE sessions SET sess = ? WHERE sid = ?')
            .run(JSON.stringify(sessData), s.sid);
          break;
        }
      } catch (_) {}
    }
    assert.ok(targetSid, 'Could not locate session in DB for expiry test');

    // Now the session's table.scannedAt is 4 hours ago — default session duration is 3h
    // So this request should get 403
    const r = await expiredClient.get('/api/menu');
    assert.strictEqual(r.status, 403, `Expected 403 for expired session, got ${r.status}`);
    assert.ok(r.body.error.includes('QR code'), `Error: ${r.body.error}`);

    pass(26, 'Expired table session correctly returns 403');
  });

  // ══════════════════════════════════════════════════════════════════
  // SUMMARY
  // ══════════════════════════════════════════════════════════════════
  console.log('\n==================================================================');
  console.log(`📊 RESULTS: ${passed} passed, ${failed} failed out of 26 tests`);
  console.log('==================================================================\n');

  if (failed > 0) {
    console.error('❌ SOME TESTS FAILED — see above for details.');
  } else {
    console.log('✅ ALL 26 TESTS PASSED!');
  }

  // Cleanup
  try {
    db.db.prepare('DELETE FROM owners').run();
    db.db.prepare('DELETE FROM order_items').run();
    db.db.prepare('DELETE FROM orders').run();
    db.db.prepare('DELETE FROM customers').run();
    db.db.prepare('DELETE FROM sessions').run();
  } catch (_) {}

  if (serverInstance) serverInstance.close();
  process.exit(failed > 0 ? 1 : 0);
}

if (require.main === module) {
  runTests().catch(err => {
    console.error('Fatal test runner error:', err);
    if (serverInstance) serverInstance.close();
    process.exit(1);
  });
}

module.exports = runTests;
