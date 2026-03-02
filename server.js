import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const PORT = Number(process.env.PORT || 4173);
const ROOT = process.cwd();
const db = new DatabaseSync(join(ROOT, "novapos.db"));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml"
};

function json(res, code, payload) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

async function parseBody(req) {
  let data = "";
  for await (const chunk of req) data += chunk;
  return data ? JSON.parse(data) : {};
}

function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT UNIQUE, password TEXT, role TEXT);
    CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY, name TEXT, sku TEXT UNIQUE, price REAL, stock INTEGER);
    CREATE TABLE IF NOT EXISTS sales (
      id INTEGER PRIMARY KEY,
      receipt_no TEXT UNIQUE,
      timestamp TEXT,
      cashier TEXT,
      payment_method TEXT,
      subtotal REAL,
      discount REAL,
      tax REAL,
      total REAL,
      received REAL,
      change_amount REAL,
      currency TEXT
    );
    CREATE TABLE IF NOT EXISTS sale_items (
      id INTEGER PRIMARY KEY,
      sale_id INTEGER,
      product_id TEXT,
      name TEXT,
      price REAL,
      qty INTEGER
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
  `);

  db.prepare("INSERT OR IGNORE INTO users (username, password, role) VALUES (?, ?, ?)").run("admin", "admin123", "admin");
  db.prepare("INSERT OR IGNORE INTO users (username, password, role) VALUES (?, ?, ?)").run("cashier", "cash123", "user");

  const count = db.prepare("SELECT COUNT(*) c FROM products").get().c;
  if (!count) {
    const ins = db.prepare("INSERT INTO products (id, name, sku, price, stock) VALUES (?, ?, ?, ?, ?)");
    [
      [crypto.randomUUID(), "Coffee 250g", "CF-250", 8.5, 42],
      [crypto.randomUUID(), "Milk 1L", "MLK-1L", 2.2, 25],
      [crypto.randomUUID(), "Bread Loaf", "BR-LOAF", 1.8, 14],
      [crypto.randomUUID(), "Chocolate Bar", "CH-80", 1.25, 8],
      [crypto.randomUUID(), "Orange Juice", "OJ-1L", 3.9, 12]
    ].forEach((row) => ins.run(...row));
  }

  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('currency', 'USD')").run();
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('theme', 'light')").run();
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('cashierName', '')").run();
}

function bootstrapPayload() {
  const products = db.prepare("SELECT id, name, sku, price, stock FROM products ORDER BY name").all();
  const sales = db.prepare("SELECT * FROM sales ORDER BY id DESC").all();
  const itemStmt = db.prepare("SELECT product_id as productId, name, price, qty FROM sale_items WHERE sale_id=?");
  const history = sales.map((s) => ({
    receiptNo: s.receipt_no,
    timestamp: s.timestamp,
    cashier: s.cashier,
    paymentMethod: s.payment_method,
    subtotal: s.subtotal,
    discount: s.discount,
    tax: s.tax,
    total: s.total,
    received: s.received,
    change: s.change_amount,
    currency: s.currency,
    items: itemStmt.all(s.id)
  }));
  const settings = Object.fromEntries(db.prepare("SELECT key, value FROM settings").all().map((x) => [x.key, x.value]));
  return { products, history, settings };
}

async function handleApi(req, res, pathname) {
  if (pathname === "/api/health") return json(res, 200, { ok: true });
  if (pathname === "/api/bootstrap") return json(res, 200, bootstrapPayload());

  if (pathname === "/api/login" && req.method === "POST") {
    const { username, password, role } = await parseBody(req);
    const user = db.prepare("SELECT username, role FROM users WHERE lower(username)=lower(?) AND password=? AND role=?").get(username, password, role);
    if (!user) return json(res, 401, { error: "Invalid credentials." });
    return json(res, 200, { user });
  }

  if (pathname === "/api/products" && req.method === "POST") {
    const { name, sku, price, stock } = await parseBody(req);
    if (!name || !sku || Number(price) < 0 || Number(stock) < 0) return json(res, 400, { error: "Invalid product payload." });
    try {
      db.prepare("INSERT INTO products (id, name, sku, price, stock) VALUES (?, ?, ?, ?, ?)").run(crypto.randomUUID(), name.trim(), sku.trim(), Number(price), Number(stock));
      return json(res, 200, { ok: true });
    } catch {
      return json(res, 409, { error: "SKU already exists." });
    }
  }

  if (pathname.startsWith("/api/products/") && pathname.endsWith("/price") && req.method === "PATCH") {
    const sku = decodeURIComponent(pathname.replace("/api/products/", "").replace("/price", ""));
    const { price } = await parseBody(req);
    const result = db.prepare("UPDATE products SET price=? WHERE lower(sku)=lower(?)").run(Number(price), sku);
    if (!result.changes) return json(res, 404, { error: "Product not found." });
    return json(res, 200, { ok: true });
  }

  if (pathname === "/api/sales" && req.method === "POST") {
    const sale = await parseBody(req);
    if (!Array.isArray(sale.items) || !sale.items.length) return json(res, 400, { error: "Cart is empty." });

    const tx = db.createSession ? null : null; // no-op to keep compatibility
    try {
      db.exec("BEGIN");
      for (const line of sale.items) {
        const product = db.prepare("SELECT id, stock FROM products WHERE id=?").get(line.productId);
        if (!product || product.stock < line.qty) throw new Error(`Insufficient stock for ${line.name}`);
      }
      for (const line of sale.items) {
        db.prepare("UPDATE products SET stock = stock - ? WHERE id = ?").run(line.qty, line.productId);
      }
      const receiptNo = `R-${String((db.prepare("SELECT COUNT(*) c FROM sales").get().c || 0) + 1).padStart(5, "0")}`;
      const timestamp = new Date().toISOString();
      const info = db.prepare(`INSERT INTO sales (receipt_no, timestamp, cashier, payment_method, subtotal, discount, tax, total, received, change_amount, currency)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(receiptNo, timestamp, sale.cashier || "", sale.paymentMethod, sale.subtotal, sale.discount, sale.tax, sale.total, sale.received, sale.change, sale.currency || "USD");
      const insertItem = db.prepare("INSERT INTO sale_items (sale_id, product_id, name, price, qty) VALUES (?, ?, ?, ?, ?)");
      sale.items.forEach((line) => insertItem.run(info.lastInsertRowid, line.productId, line.name, line.price, line.qty));
      db.exec("COMMIT");
      return json(res, 200, { ok: true, receiptNo, timestamp });
    } catch (e) {
      db.exec("ROLLBACK");
      return json(res, 400, { error: e.message || "Could not complete sale." });
    }
  }

  if (pathname === "/api/history" && req.method === "DELETE") {
    db.prepare("DELETE FROM sale_items").run();
    db.prepare("DELETE FROM sales").run();
    return json(res, 200, { ok: true });
  }

  if (pathname === "/api/settings" && req.method === "PUT") {
    const body = await parseBody(req);
    const stmt = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value");
    ["currency", "theme", "cashierName"].forEach((key) => {
      if (body[key] !== undefined) stmt.run(key, String(body[key]));
    });
    return json(res, 200, { ok: true });
  }

  return false;
}

async function serveStatic(res, pathname) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const filePath = join(ROOT, requested);
  try {
    const content = await readFile(filePath);
    res.writeHead(200, { "Content-Type": MIME[extname(filePath)] || "text/plain; charset=utf-8" });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

initDb();

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith("/api/")) {
    const handled = await handleApi(req, res, url.pathname);
    if (handled === false) json(res, 404, { error: "Not found" });
    return;
  }
  await serveStatic(res, url.pathname);
}).listen(PORT, () => {
  console.log(`NovaPOS backend running on http://localhost:${PORT}`);
});
