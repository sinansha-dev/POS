// ============================================================
//  NovaPOS  –  Secure Backend with Supabase
// ============================================================
//  ENV VARS to set in Render → Environment:
//
//  SUPABASE_URL     = https://xxxx.supabase.co
//  SUPABASE_KEY     = your service_role key (Settings → API)
//  JWT_SECRET       = any long random string
//  ALLOWED_ORIGIN   = https://pos-4nqm.onrender.com
//  PORT             = 4173 (Render sets this automatically)
// ============================================================
//
//  ── SUPABASE MIGRATION (run in SQL Editor after upgrade) ───
//
//  ALTER TABLE products   ADD COLUMN IF NOT EXISTS cost_price      REAL DEFAULT 0;
//  ALTER TABLE sales      ADD COLUMN IF NOT EXISTS cogs            REAL DEFAULT 0;
//  ALTER TABLE sales      ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
//  ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS unit_cost       REAL DEFAULT 0;
//  ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS cogs            REAL DEFAULT 0;
//
//  CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_idempotency
//    ON sales(idempotency_key) WHERE idempotency_key IS NOT NULL;
//
//  CREATE TABLE IF NOT EXISTS audit_log (
//    id            BIGSERIAL PRIMARY KEY,
//    timestamp     TEXT NOT NULL,
//    actor         TEXT NOT NULL,
//    action        TEXT NOT NULL,
//    entity_type   TEXT NOT NULL,
//    entity_id     TEXT,
//    before_value  TEXT,
//    after_value   TEXT,
//    note          TEXT
//  );
//
//  CREATE TABLE IF NOT EXISTS z_reports (
//    id                BIGSERIAL PRIMARY KEY,
//    report_date       TEXT NOT NULL,
//    closed_at         TEXT NOT NULL,
//    cashier           TEXT NOT NULL,
//    opening_cash      REAL DEFAULT 0,
//    closing_cash      REAL DEFAULT 0,
//    cash_sales        REAL DEFAULT 0,
//    card_sales        REAL DEFAULT 0,
//    mobile_sales      REAL DEFAULT 0,
//    split_sales       REAL DEFAULT 0,
//    total_sales       REAL DEFAULT 0,
//    total_tax         REAL DEFAULT 0,
//    total_refunds     REAL DEFAULT 0,
//    transaction_count INTEGER DEFAULT 0,
//    notes             TEXT,
//    status            TEXT DEFAULT 'closed'
//  );
//
//  CREATE TABLE IF NOT EXISTS cost_batches (
//    id             BIGSERIAL PRIMARY KEY,
//    product_id     UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
//    unit_cost      REAL NOT NULL,
//    qty_remaining  INTEGER NOT NULL,
//    created_at     TEXT NOT NULL
//  );
//
//  -- Enable RLS
//  ALTER TABLE audit_log    ENABLE ROW LEVEL SECURITY;
//  ALTER TABLE z_reports    ENABLE ROW LEVEL SECURITY;
//  ALTER TABLE cost_batches ENABLE ROW LEVEL SECURITY;
// ============================================================

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import crypto from "node:crypto";

const PORT         = Number(process.env.PORT || 4173);
const ROOT         = process.cwd();
const JWT_SECRET   = process.env.JWT_SECRET || "CHANGE_THIS_SECRET";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const DEFAULT_TAX_CODES = [
  { id: "GST_5", name: "GST 5%", gst_rate: 5, cess_rate: 0 },
  { id: "GST_12", name: "GST 12%", gst_rate: 12, cess_rate: 0 },
  { id: "GST_18", name: "GST 18%", gst_rate: 18, cess_rate: 0 },
  { id: "GST_28", name: "GST 28%", gst_rate: 28, cess_rate: 0 },
  { id: "GST_28_CESS12", name: "GST 28% + Cess 12%", gst_rate: 28, cess_rate: 12 },
];

if (JWT_SECRET === "CHANGE_THIS_SECRET") {
  console.warn("⚠️  WARNING: Set JWT_SECRET in your environment variables!");
}
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.warn("⚠️  WARNING: SUPABASE_URL or SUPABASE_KEY not set. Using local SQLite fallback.");
}

// ── MIME TYPES ───────────────────────────────────────────────
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg":  "image/svg+xml"
};

// ── BLOCKED FILES ────────────────────────────────────────────
const BLOCKED_FILES = [
  "server.js", "novapos.db", ".env",
  "package.json", "package-lock.json", ".git"
];

// ── RATE LIMITER ─────────────────────────────────────────────
const rateLimitMap = new Map();
const RATE_LIMIT_MAX    = 10;
const RATE_LIMIT_WINDOW = 60_000;

function isRateLimited(ip) {
  const now   = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    return false;
  }
  if (entry.count >= RATE_LIMIT_MAX) return true;
  entry.count++;
  return false;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of rateLimitMap) if (now > e.resetAt) rateLimitMap.delete(ip);
}, 300_000);

// ── PASSWORD HASHING ─────────────────────────────────────────
function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.createHmac("sha256", salt).update(password).digest("hex");
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  const [salt] = stored.split(":");
  return hashPassword(password, salt) === stored;
}

// ── JWT ──────────────────────────────────────────────────────
function b64url(str) {
  return Buffer.from(str).toString("base64")
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function createToken(payload) {
  const h   = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const b   = b64url(JSON.stringify({ ...payload, iat: Date.now(), exp: Date.now() + 8 * 3600_000 }));
  const sig = crypto.createHmac("sha256", JWT_SECRET).update(`${h}.${b}`).digest("base64")
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${h}.${b}.${sig}`;
}
function verifyToken(token) {
  try {
    const [h, b, sig] = token.split(".");
    const expected = crypto.createHmac("sha256", JWT_SECRET).update(`${h}.${b}`).digest("base64")
      .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    if (sig !== expected) return null;
    const payload = JSON.parse(Buffer.from(b, "base64").toString());
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}
function requireAuth(req) {
  const h = req.headers["authorization"];
  if (!h?.startsWith("Bearer ")) return null;
  return verifyToken(h.split(" ")[1]);
}
function requireAdmin(req) {
  const u = requireAuth(req);
  return u?.role === "admin" ? u : null;
}

// ── HELPERS ──────────────────────────────────────────────────
function json(res, code, payload) {
  res.writeHead(code, {
    "Content-Type":              "application/json; charset=utf-8",
    "X-Content-Type-Options":   "nosniff",
    "X-Frame-Options":           "DENY",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  });
  res.end(JSON.stringify(payload));
}
async function parseBody(req) {
  let data = "";
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 100_000) throw new Error("Request too large.");
  }
  return data ? JSON.parse(data) : {};
}
function getIp(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress || "unknown";
}

// ── SUPABASE CLIENT ──────────────────────────────────────────
// Thin fetch-based client — no npm package needed!
async function sbQuery(table, method = "GET", body = null, filters = "") {
  const url = `${SUPABASE_URL}/rest/v1/${table}${filters}`;
  const res = await fetch(url, {
    method,
    headers: {
      "apikey":        SUPABASE_KEY,
      "Authorization": `Bearer ${SUPABASE_KEY}`,
      "Content-Type":  "application/json",
      "Prefer":        method === "POST" ? "return=representation" : "return=minimal",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase error: ${err}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// Supabase RPC for raw SQL (used for seeding)
async function sbRpc(fn, params = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      "apikey":        SUPABASE_KEY,
      "Authorization": `Bearer ${SUPABASE_KEY}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify(params),
  });
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ── SQLITE FALLBACK (when no Supabase) ──────────────────────
let db = null;
function getDb() {
  return db; // db is initialized by initSqlite() at startup
}

// ── DB ABSTRACTION ───────────────────────────────────────────
// Unified interface — uses Supabase if env vars set, else SQLite
const DB = {
  async getUser(username, role) {
    if (SUPABASE_URL) {
      const rows = await sbQuery("users", "GET", null,
        `?select=username,password,role&username=ilike.${encodeURIComponent(username)}&role=eq.${role}&limit=1`);
      return rows?.[0] || null;
    }
    return getDb().prepare("SELECT username, password, role FROM users WHERE lower(username)=lower(?) AND role=?").get(username, role);
  },

  async updatePassword(username, hashedPassword) {
    if (SUPABASE_URL) {
      await sbQuery("users", "PATCH", { password: hashedPassword }, `?username=eq.${username}`);
    } else {
      getDb().prepare("UPDATE users SET password=? WHERE username=?").run(hashedPassword, username);
    }
  },

  async getProducts() {
    if (SUPABASE_URL) {
      try {
        return await sbQuery("products", "GET", null, "?select=id,name,sku,barcode,price,retail_price,wholesale_price,mrp,stock,hsn_code,gst_rate,cess_rate,tax_code,category_id&order=name");
      } catch {
        const rows = await sbQuery("products", "GET", null, "?select=id,name,sku,price,stock,hsn_code,gst_rate,category_id&order=name");
        return (rows || []).map((p) => ({
          ...p,
          barcode: p.sku,
          retail_price: p.price,
          wholesale_price: +((Number(p.price || 0)) / (1 + Number(p.gst_rate || 0) / 100)).toFixed(2),
          mrp: p.price,
          cess_rate: 0,
          tax_code: null,
        }));
      }
    }
    return getDb().prepare("SELECT id, name, sku, barcode, price, retail_price, wholesale_price, mrp, stock, hsn_code, gst_rate, cess_rate, tax_code, category_id FROM products ORDER BY name").all();
  },

  async addProduct(id, payload) {
    const {
      name,
      sku,
      barcode,
      wholesalePrice,
      retailPrice,
      mrp,
      stock,
      hsnCode,
      gstRate,
      cessRate,
      taxCode,
      categoryId,
    } = payload;
    if (SUPABASE_URL) {
      const body = {
        id,
        name,
        sku,
        barcode,
        price: retailPrice,
        wholesale_price: wholesalePrice,
        retail_price: retailPrice,
        mrp,
        stock,
        hsn_code: hsnCode || null,
        gst_rate: Number(gstRate || 0),
        cess_rate: Number(cessRate || 0),
        tax_code: taxCode || null,
        category_id: categoryId || null,
      };
      try {
        await sbQuery("products", "POST", body);
      } catch {
        await sbQuery("products", "POST", {
          id,
          name,
          sku,
          price: retailPrice,
          stock,
          hsn_code: hsnCode || null,
          gst_rate: Number(gstRate || 0),
          category_id: categoryId || null,
        });
      }
    } else {
      getDb().prepare("INSERT INTO products (id, name, sku, barcode, price, wholesale_price, retail_price, mrp, stock, hsn_code, gst_rate, cess_rate, tax_code, category_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(
          id,
          name,
          sku,
          barcode,
          retailPrice,
          wholesalePrice,
          retailPrice,
          mrp,
          stock,
          hsnCode || null,
          Number(gstRate || 0),
          Number(cessRate || 0),
          taxCode || null,
          categoryId || null
        );
    }
  },

  async getTaxCodes() {
    if (SUPABASE_URL) {
      try {
        return await sbQuery("tax_codes", "GET", null, "?select=id,name,gst_rate,cess_rate&order=id");
      } catch {
        return DEFAULT_TAX_CODES;
      }
    }
    return getDb().prepare("SELECT id, name, gst_rate, cess_rate FROM tax_codes ORDER BY id").all();
  },

  async updatePrice(sku, price) {
    if (SUPABASE_URL) {
      const result = await sbQuery("products", "PATCH", { price, retail_price: price }, `?sku=ilike.${encodeURIComponent(sku)}`);
      return result?.length > 0 || true;
    }
    const r = getDb().prepare("UPDATE products SET price=?, retail_price=? WHERE lower(sku)=lower(?)").run(price, price, sku);
    return r.changes > 0;
  },

  async getProductById(id) {
    if (SUPABASE_URL) {
      const rows = await sbQuery("products", "GET", null, `?id=eq.${id}&limit=1`);
      return rows?.[0] || null;
    }
    return getDb().prepare("SELECT id, stock FROM products WHERE id=?").get(id);
  },

  async decrementStock(id, qty) {
    if (SUPABASE_URL) {
      // Optimistic CAS loop to avoid oversell under concurrent checkouts.
      for (let attempt = 0; attempt < 3; attempt++) {
        const rows = await sbQuery("products", "GET", null, `?id=eq.${id}&select=id,stock&limit=1`);
        const current = Number(rows?.[0]?.stock || 0);
        if (current < qty) throw new Error(`Insufficient stock for product ${id}.`);
        const newStock = current - qty;

        const patchRes = await fetch(`${SUPABASE_URL}/rest/v1/products?id=eq.${id}&stock=eq.${current}`, {
          method: "PATCH",
          headers: {
            "apikey":        SUPABASE_KEY,
            "Authorization": `Bearer ${SUPABASE_KEY}`,
            "Content-Type":  "application/json",
            "Prefer":        "return=representation",
          },
          body: JSON.stringify({ stock: newStock }),
        });
        if (!patchRes.ok) throw new Error(`Stock update failed for product ${id}: ${await patchRes.text()}`);
        const updated = await patchRes.json().catch(() => []);
        if (Array.isArray(updated) && updated.length) return;
      }
      throw new Error(`Concurrent stock update detected for product ${id}. Please retry.`);
    } else {
      getDb().prepare("UPDATE products SET stock = stock - ? WHERE id = ?").run(qty, id);
    }
  },

  async getSalesCount() {
    if (SUPABASE_URL) {
      const rows = await sbQuery("sales", "GET", null, "?select=id&limit=1&order=id.desc");
      // Get count via head request
      const res = await fetch(`${SUPABASE_URL}/rest/v1/sales?select=id`, {
        method: "HEAD",
        headers: {
          "apikey": SUPABASE_KEY,
          "Authorization": `Bearer ${SUPABASE_KEY}`,
          "Prefer": "count=exact",
        },
      });
      return Number(res.headers.get("content-range")?.split("/")[1] || 0);
    }
    return getDb().prepare("SELECT COUNT(*) c FROM sales").get().c || 0;
  },

  async insertSale(sale) {
    if (SUPABASE_URL) {
      const rows = await sbQuery("sales", "POST", sale);
      return rows?.[0]?.id;
    }
    const info = getDb().prepare(`
      INSERT INTO sales (receipt_no, timestamp, cashier, payment_method, subtotal, discount, tax, total, received, change_amount, currency, cogs, idempotency_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(sale.receipt_no, sale.timestamp, sale.cashier, sale.payment_method,
           sale.subtotal, sale.discount, sale.tax, sale.total, sale.received, sale.change_amount,
           sale.currency, sale.cogs ?? 0, sale.idempotency_key ?? null);
    return info.lastInsertRowid;
  },

  async insertSaleItem(item) {
    if (SUPABASE_URL) {
      await sbQuery("sale_items", "POST", item);
    } else {
      getDb().prepare("INSERT INTO sale_items (sale_id, product_id, name, price, qty, hsn_code, gst_rate, unit_cost, cogs) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(item.sale_id, item.product_id, item.name, item.price, item.qty,
             item.hsn_code||null, item.gst_rate||0, item.unit_cost||0, item.cogs||0);
    }
  },

  async getAllSales() {
    if (SUPABASE_URL) {
      return await sbQuery("sales", "GET", null, "?order=id.desc");
    }
    return getDb().prepare("SELECT * FROM sales ORDER BY id DESC").all();
  },

  async getSaleItems(saleId) {
    if (SUPABASE_URL) {
      return await sbQuery("sale_items", "GET", null,
        `?sale_id=eq.${saleId}&select=product_id,name,price,qty,hsn_code,gst_rate`);
    }
    return getDb().prepare("SELECT product_id as productId, name, price, qty, hsn_code, gst_rate FROM sale_items WHERE sale_id=?").all(saleId);
  },

  async clearHistory() {
    if (SUPABASE_URL) {
      await sbQuery("sale_items", "DELETE", null, "?id=gt.0");
      await sbQuery("sales",      "DELETE", null, "?id=gt.0");
    } else {
      getDb().prepare("DELETE FROM sale_items").run();
      getDb().prepare("DELETE FROM sales").run();
    }
  },

  async getSettings() {
    if (SUPABASE_URL) {
      const rows = await sbQuery("settings", "GET", null, "?select=key,value");
      return Object.fromEntries((rows || []).map((x) => [x.key, x.value]));
    }
    return Object.fromEntries(
      getDb().prepare("SELECT key, value FROM settings").all().map((x) => [x.key, x.value])
    );
  },

  async updateSetting(key, value) {
    if (SUPABASE_URL) {
      await fetch(`${SUPABASE_URL}/rest/v1/settings`, {
        method: "POST",
        headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`,
          "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({ key, value }),
      });
    } else {
      getDb().prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run(key, value);
    }
  },

  // ── AUDIT LOG ────────────────────────────────────────────────
  async writeAudit({ actor, action, entityType, entityId = null, before = null, after = null, note = null }) {
    const row = {
      timestamp:    new Date().toISOString(),
      actor:        String(actor),
      action:       String(action),
      entity_type:  String(entityType),
      entity_id:    entityId ? String(entityId) : null,
      before_value: before  !== null ? JSON.stringify(before)  : null,
      after_value:  after   !== null ? JSON.stringify(after)   : null,
      note:         note    ? String(note).slice(0, 500)       : null,
    };
    if (SUPABASE_URL) {
      await sbQuery("audit_log", "POST", row).catch(e => console.warn("Audit log write failed:", e.message));
    } else {
      try {
        getDb().prepare(
          "INSERT INTO audit_log (timestamp, actor, action, entity_type, entity_id, before_value, after_value, note) VALUES (?,?,?,?,?,?,?,?)"
        ).run(row.timestamp, row.actor, row.action, row.entity_type, row.entity_id, row.before_value, row.after_value, row.note);
      } catch (e) { console.warn("Audit log write failed:", e.message); }
    }
  },

  // ── PRODUCT FULL (for server-side price computation) ─────────
  async getProductFull(id) {
    if (SUPABASE_URL) {
      const rows = await sbQuery("products", "GET", null,
        `?id=eq.${id}&select=id,name,sku,price,retail_price,wholesale_price,gst_rate,cess_rate,hsn_code,stock,cost_price&limit=1`);
      return rows?.[0] || null;
    }
    return getDb().prepare(
      "SELECT id, name, sku, price, retail_price, wholesale_price, gst_rate, cess_rate, hsn_code, stock, cost_price FROM products WHERE id=?"
    ).get(id);
  },

  // ── COST BATCHES (FIFO) ──────────────────────────────────────
  async insertCostBatch(productId, unitCost, qty) {
    const row = { product_id: productId, unit_cost: unitCost, qty_remaining: qty, created_at: new Date().toISOString() };
    if (SUPABASE_URL) {
      await sbQuery("cost_batches", "POST", row).catch(() => {});
    } else {
      getDb().prepare("INSERT INTO cost_batches (product_id, unit_cost, qty_remaining, created_at) VALUES (?,?,?,?)")
        .run(productId, unitCost, qty, row.created_at);
    }
  },

  // Returns { totalCogs } and updates batch qty_remaining in SQLite.
  // For Supabase returns best-effort COGS from product.cost_price.
  async consumeFifoCogs(productId, qtyNeeded, fallbackCost) {
    if (SUPABASE_URL) {
      // Supabase: use product cost_price as FIFO approximation
      return +(fallbackCost * qtyNeeded).toFixed(2);
    }
    const dbx = getDb();
    const batches = dbx.prepare(
      "SELECT id, unit_cost, qty_remaining FROM cost_batches WHERE product_id=? AND qty_remaining > 0 ORDER BY created_at ASC, id ASC"
    ).all(productId);
    let remaining = qtyNeeded;
    let totalCogs = 0;
    for (const batch of batches) {
      if (remaining <= 0) break;
      const use = Math.min(remaining, batch.qty_remaining);
      totalCogs += use * batch.unit_cost;
      dbx.prepare("UPDATE cost_batches SET qty_remaining = qty_remaining - ? WHERE id=?").run(use, batch.id);
      remaining -= use;
    }
    // If no batches, fall back to cost_price column
    if (remaining > 0) totalCogs += remaining * fallbackCost;
    return +totalCogs.toFixed(2);
  },

  // ── Z-REPORT ─────────────────────────────────────────────────
  async getLastZReport() {
    if (SUPABASE_URL) {
      const rows = await sbQuery("z_reports", "GET", null, "?order=id.desc&limit=1").catch(() => []);
      return rows?.[0] || null;
    }
    return getDb().prepare("SELECT * FROM z_reports ORDER BY id DESC LIMIT 1").get() || null;
  },

  async insertZReport(row) {
    if (SUPABASE_URL) {
      return await sbQuery("z_reports", "POST", row);
    }
    const info = getDb().prepare(`
      INSERT INTO z_reports (report_date, closed_at, cashier, opening_cash, closing_cash,
        cash_sales, card_sales, mobile_sales, split_sales, total_sales, total_tax,
        total_refunds, transaction_count, notes, status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(row.report_date, row.closed_at, row.cashier, row.opening_cash, row.closing_cash,
           row.cash_sales, row.card_sales, row.mobile_sales, row.split_sales,
           row.total_sales, row.total_tax, row.total_refunds, row.transaction_count,
           row.notes || null, "closed");
    return info.lastInsertRowid;
  },

  async listZReports(limit = 30) {
    if (SUPABASE_URL) {
      return await sbQuery("z_reports", "GET", null, `?order=id.desc&limit=${limit}`).catch(() => []) || [];
    }
    return getDb().prepare("SELECT * FROM z_reports ORDER BY id DESC LIMIT ?").all(limit);
  },

  // Sales since a given timestamp (for Z-report computation)
  async getSalesSince(since) {
    if (SUPABASE_URL) {
      return await sbQuery("sales", "GET", null,
        `?timestamp=gte.${encodeURIComponent(since)}&order=id.asc`) || [];
    }
    return getDb().prepare("SELECT * FROM sales WHERE timestamp >= ? ORDER BY id ASC").all(since);
  },
};

function sqliteFeatureData() {
  if (SUPABASE_URL) {
    return { suppliers: [], purchaseOrders: [], stockTransfers: [], stockBatches: [], customers: [], reports: {} };
  }
  const dbx = getDb();
  const suppliers = dbx.prepare("SELECT id, name, phone, email FROM suppliers ORDER BY name").all();
  const purchaseOrders = dbx.prepare("SELECT id, supplier_id as supplierId, po_number as poNumber, status, total, created_at as createdAt FROM purchase_orders ORDER BY id DESC").all();
  const stockTransfers = dbx.prepare("SELECT id, sku, qty, from_store as fromStore, to_store as toStore, created_at as createdAt FROM stock_transfers ORDER BY id DESC").all();
  const stockBatches = dbx.prepare("SELECT id, sku, batch_no as batchNo, expiry_date as expiryDate, qty FROM stock_batches ORDER BY expiry_date ASC").all();
  const customers = dbx.prepare("SELECT id, name, phone, loyalty_points as loyaltyPoints, member_discount as memberDiscount, credit_balance as creditBalance FROM customers ORDER BY name").all();

  const dailySales = dbx.prepare("SELECT date(timestamp) as day, round(sum(total),2) as revenue, count(*) as transactions FROM sales WHERE payment_method != 'REFUND' GROUP BY date(timestamp) ORDER BY day DESC LIMIT 14").all();
  const monthlyRevenue = dbx.prepare("SELECT substr(timestamp,1,7) as month, round(sum(total),2) as revenue FROM sales WHERE payment_method != 'REFUND' GROUP BY substr(timestamp,1,7) ORDER BY month DESC LIMIT 12").all();
  const bestSelling = dbx.prepare("SELECT si.name, sum(si.qty) as qty, round(sum(si.cogs),2) as cogs FROM sale_items si JOIN sales s ON s.id=si.sale_id WHERE s.payment_method != 'REFUND' GROUP BY si.name ORDER BY qty DESC LIMIT 10").all();
  const slowMoving = dbx.prepare("SELECT p.name, p.sku, p.stock, coalesce(sum(si.qty),0) as qty FROM products p LEFT JOIN sale_items si ON si.product_id = p.id AND si.sale_id IN (SELECT id FROM sales WHERE payment_method != 'REFUND') WHERE p.stock > 0 GROUP BY p.id ORDER BY qty ASC, p.stock DESC LIMIT 10").all();
  const taxReport = dbx.prepare("SELECT date(timestamp) as day, round(sum(tax),2) as gst FROM sales WHERE payment_method != 'REFUND' GROUP BY date(timestamp) ORDER BY day DESC LIMIT 14").all();
  const cashSummary = dbx.prepare("SELECT payment_method as method, round(sum(total),2) as amount, count(*) as count FROM sales WHERE payment_method != 'REFUND' GROUP BY payment_method ORDER BY amount DESC").all();
  const stockValue = dbx.prepare("SELECT round(sum(price * stock),2) as value FROM products").get()?.value || 0;
  const revenue = dbx.prepare("SELECT round(sum(total),2) as v FROM sales WHERE payment_method != 'REFUND'").get()?.v || 0;
  const cogs = dbx.prepare("SELECT round(sum(cogs),2) as v FROM sale_items").get()?.v || 0;

  return {
    suppliers, purchaseOrders, stockTransfers, stockBatches, customers,
    reports: {
      dailySales,
      monthlyRevenue,
      bestSelling,
      slowMoving,
      taxReport,
      cashSummary,
      profitLoss: { revenue, cogs, grossProfit: Number((revenue - cogs).toFixed(2)), stockValue }
    }
  };
}

// ── SERVER-SIDE SALE COMPUTATION ─────────────────────────────
// Fetches live prices from DB — client totals are IGNORED.
async function computeSaleTotals(rawItems, discountPct = 0) {
  const enriched = [];
  let subtotal = 0;
  let totalTax  = 0;

  for (const item of rawItems) {
    if (!item.productId) throw new Error(`Missing productId in cart item.`);
    const qty = Math.floor(Number(item.qty));
    if (!qty || qty < 1) throw new Error(`Invalid qty for item.`);

    const p = await DB.getProductFull(item.productId);
    if (!p) throw new Error(`Product not found: ${item.productId}`);
    if (p.stock < qty) throw new Error(`Insufficient stock for "${p.name}" (have ${p.stock}, need ${qty}).`);

    // Determine unit price: wholesale flag from client, but prices come from server
    const useWholesale = item.saleType === "wholesale";
    const unitPrice = useWholesale
      ? +(Number(p.wholesale_price || p.price)).toFixed(2)
      : +(Number(p.retail_price   || p.price)).toFixed(2);

    const taxRate   = Number(p.gst_rate || 0) + Number(p.cess_rate || 0);
    const lineTotal = +(unitPrice * qty).toFixed(2);

    // Tax is embedded in retail_price (inclusive); extract it
    const lineTax   = taxRate > 0 ? +(lineTotal * taxRate / (100 + taxRate)).toFixed(2) : 0;

    subtotal  += lineTotal;
    totalTax  += lineTax;

    enriched.push({
      productId:   p.id,
      name:        p.name,
      price:       unitPrice,
      qty,
      hsnCode:     p.hsn_code   || "",
      gstRate:     p.gst_rate   || 0,
      cessRate:    p.cess_rate  || 0,
      costPrice:   Number(p.cost_price || p.wholesale_price || 0),
    });
  }

  subtotal = +subtotal.toFixed(2);
  totalTax = +totalTax.toFixed(2);

  const discountAmt = discountPct > 0 ? +(subtotal * Math.min(discountPct, 100) / 100).toFixed(2) : 0;
  const total       = +(subtotal - discountAmt).toFixed(2);

  return { subtotal, tax: totalTax, discount: discountAmt, total, enrichedItems: enriched };
}

// ── BOOTSTRAP PAYLOAD ────────────────────────────────────────
async function bootstrapPayload() {
  const products  = await DB.getProducts();
  const sales     = await DB.getAllSales();
  const history   = await Promise.all(sales.map(async (s) => {
    const items = await DB.getSaleItems(s.id);
    return {
      receiptNo:     s.receipt_no,
      timestamp:     s.timestamp,
      cashier:       s.cashier,
      paymentMethod: s.payment_method,
      subtotal:      s.subtotal,
      discount:      s.discount,
      tax:           s.tax,
      total:         s.total,
      received:      s.received,
      change:        s.change_amount,
      currency:      s.currency,
      items: SUPABASE_URL
        ? items.map(i => ({ productId: i.product_id, name: i.name, price: i.price, qty: i.qty, hsnCode: i.hsn_code||null, gstRate: i.gst_rate||0 }))
        : items,
    };
  }));
  const settings = await DB.getSettings();
  const taxCodesRaw = await DB.getTaxCodes().catch(() => []);
  const taxCodes = (taxCodesRaw || []).map((t) => ({
    id: t.id,
    name: t.name,
    gst_rate: Number(t.gst_rate || 0),
    cess_rate: Number(t.cess_rate || 0),
  }));
  // For Supabase: load extra features directly
  if (SUPABASE_URL) {
    const suppliersRaw = await sbQuery("suppliers","GET",null,"?select=id,name,phone,email&order=name").catch(()=>[]) || [];
    const customersRaw = await sbQuery("customers","GET",null,"?select=id,name,phone,loyalty_points,member_discount,credit_balance&order=name").catch(()=>[]) || [];
    const customers = customersRaw.map(c=>({ id:c.id, name:c.name, phone:c.phone, loyaltyPoints:c.loyalty_points, memberDiscount:c.member_discount, creditBalance:c.credit_balance }));
    const catsRaw = await sbQuery("categories","GET",null,"?select=id,name,hsn_code,gst_rate&order=name").catch(()=>[]) || [];
    return { products, history, settings, taxCodes, suppliers: suppliersRaw, customers, categories: catsRaw, purchaseOrders:[], stockTransfers:[], stockBatches:[], reports:{} };
  }
  const sqliteCats = !SUPABASE_URL ? (() => { try { return getDb()?.prepare("SELECT id,name,hsn_code,gst_rate FROM categories ORDER BY name").all() || []; } catch { return []; } })() : [];
  return { products, history, settings, taxCodes, categories: sqliteCats, ...sqliteFeatureData() };
}

// ── API HANDLERS ─────────────────────────────────────────────
async function handleApi(req, res, pathname) {

  if (pathname === "/api/health") return json(res, 200, { ok: true });

  // ── LOGIN ────────────────────────────────────────────────────
  if (pathname === "/api/login" && req.method === "POST") {
    if (isRateLimited(getIp(req))) return json(res, 429, { error: "Too many attempts. Wait 1 minute." });

    const { username, password, role } = await parseBody(req);
    if (!username || !password || !role) return json(res, 400, { error: "Missing fields." });
    if (typeof username !== "string" || username.length > 50) return json(res, 400, { error: "Invalid username." });

    const user = await DB.getUser(username, role);
    if (!user || !verifyPassword(password, user.password)) {
      return json(res, 401, { error: "Invalid credentials." });
    }

    const token = createToken({ username: user.username, role: user.role });
    return json(res, 200, { user: { username: user.username, role: user.role }, token });
  }

  // ── All routes below require auth ────────────────────────────
  if (pathname === "/api/bootstrap") {
    if (!requireAuth(req)) return json(res, 401, { error: "Login required." });
    return json(res, 200, await bootstrapPayload());
  }

  if (pathname === "/api/products" && req.method === "POST") {
    if (!requireAdmin(req)) return json(res, 403, { error: "Admin only." });
    const body = await parseBody(req);
    const { name, sku, barcode, wholesalePrice, retailPrice: rawRetail, mrp, stock, hsnCode, gstRate, cessRate, categoryId } = body;
    if (!name || !sku || isNaN(Number(wholesalePrice)) || isNaN(Number(mrp)) || isNaN(Number(stock))) return json(res, 400, { error: "Invalid product." });
    if (name.length > 100 || sku.length > 50) return json(res, 400, { error: "Input too long." });
    const wholesale = Number(wholesalePrice);
    const gst = Number(gstRate || 0);
    const cess = Number(cessRate || 0);
    // Use retailPrice from frontend (user-editable); fallback to auto-calc
    const retailPrice = rawRetail ? Number(rawRetail) : +(wholesale + (wholesale * (gst + cess) / 100)).toFixed(2);
    const mrpVal = Number(mrp);
    // MRP of 0 means user didn't set it — default to retail. Otherwise retail must be <= MRP.
    const finalMrp = mrpVal <= 0 ? retailPrice : mrpVal;
    if (retailPrice > finalMrp) return json(res, 400, { error: "Retail price cannot exceed MRP." });
    if (retailPrice < wholesale) return json(res, 400, { error: "Retail price must be >= wholesale price." });
    try {
      await DB.addProduct(crypto.randomUUID(), {
        name: name.trim(),
        sku: sku.trim(),
        barcode: String(barcode || sku).trim(),
        wholesalePrice: wholesale,
        retailPrice,
        mrp: finalMrp,
        stock: Number(stock),
        hsnCode: String(hsnCode || "").trim(),
        gstRate: gst,
        cessRate: cess,
        taxCode: null,
        categoryId: categoryId || null,
      });
      return json(res, 200, { ok: true });
    } catch (e) { return json(res, 409, { error: "SKU already exists." }); }
  }

  if (pathname === "/api/tax-codes" && req.method === "GET") {
    if (!requireAuth(req)) return json(res, 401, { error: "Login required." });
    return json(res, 200, { taxCodes: await DB.getTaxCodes() });
  }

  if (pathname.startsWith("/api/products/") && pathname.endsWith("/price") && req.method === "PATCH") {
    if (!requireAdmin(req)) return json(res, 403, { error: "Admin only." });
    const admin = requireAdmin(req);
    const sku = decodeURIComponent(pathname.replace("/api/products/", "").replace("/price", ""));
    const { price, reason } = await parseBody(req);
    if (isNaN(Number(price)) || Number(price) < 0) return json(res, 400, { error: "Invalid price." });

    // Fetch old price for audit
    let oldPrice = null;
    if (SUPABASE_URL) {
      const rows = await sbQuery("products","GET",null,`?sku=ilike.${encodeURIComponent(sku)}&select=price&limit=1`).catch(()=>null);
      oldPrice = rows?.[0]?.price ?? null;
    } else {
      oldPrice = getDb().prepare("SELECT price FROM products WHERE lower(sku)=lower(?)").get(sku)?.price ?? null;
    }

    const updated = await DB.updatePrice(sku, Number(price));
    if (!updated) return json(res, 404, { error: "Product not found." });

    await DB.writeAudit({ actor: admin.username, action: "PRICE_UPDATE", entityType: "product",
      entityId: sku, before: { price: oldPrice }, after: { price: Number(price) }, note: reason||null });
    return json(res, 200, { ok: true });
  }

  if (pathname === "/api/sales" && req.method === "POST") {
    const user = requireAuth(req);
    if (!user) return json(res, 401, { error: "Login required." });
    const sale = await parseBody(req);
    if (!Array.isArray(sale.items) || !sale.items.length) return json(res, 400, { error: "Cart is empty." });

    // ── Idempotency guard ────────────────────────────────────
    const idempotencyKey = sale.idempotencyKey
      ? String(sale.idempotencyKey).slice(0, 128)
      : null;

    if (idempotencyKey) {
      // Check if this sale was already processed (client retry / double-submit)
      if (SUPABASE_URL) {
        const existing = await sbQuery("sales", "GET", null,
          `?idempotency_key=eq.${encodeURIComponent(idempotencyKey)}&select=receipt_no,timestamp&limit=1`);
        if (existing && existing.length) {
          return json(res, 200, { ok: true, receiptNo: existing[0].receipt_no, timestamp: existing[0].timestamp, idempotent: true });
        }
      } else {
        const existing = getDb().prepare("SELECT receipt_no, timestamp FROM sales WHERE idempotency_key=?").get(idempotencyKey);
        if (existing) {
          return json(res, 200, { ok: true, receiptNo: existing.receipt_no, timestamp: existing.timestamp, idempotent: true });
        }
      }
    }

    // ── Server-side price + tax computation ──────────────────
    let computed;
    try {
      computed = await computeSaleTotals(sale.items, Number(sale.discountPct || 0));
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
    const { subtotal, tax, discount, total, enrichedItems } = computed;

    const paymentMethod = String(sale.paymentMethod || "Cash");
    if (!["Cash", "Card", "Mobile Wallet", "Split"].includes(paymentMethod)) {
      return json(res, 400, { error: "Invalid payment method." });
    }

    const received     = Number(sale.received ?? total);
    const changeAmount = +(received - total).toFixed(2);
    if (!Number.isFinite(received) || received < 0) return json(res, 400, { error: "Invalid received amount." });
    if (["Card", "Mobile Wallet", "Split"].includes(paymentMethod) && Math.abs(received - total) > 0.01) {
      return json(res, 400, { error: "Non-cash payments must match total exactly." });
    }
    if (received < total - 0.01) return json(res, 400, { error: "Received amount is less than total." });

    const timestamp = new Date().toISOString();

    // ── SQLite: fully atomic transaction ─────────────────────
    if (!SUPABASE_URL) {
      const dbx = getDb();
      // Never `return` inside the try block — use result/error variables instead.
      // This guarantees ROLLBACK is always reached if something goes wrong.
      let txResult  = null;
      let txUserErr = null;

      dbx.exec("BEGIN IMMEDIATE");
      try {
        // Atomic stock decrement — WHERE stock >= qty is the race guard
        for (const item of enrichedItems) {
          const changed = dbx.prepare(
            "UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?"
          ).run(item.qty, item.productId, item.qty);
          if (changed.changes === 0) {
            const cur = dbx.prepare("SELECT stock FROM products WHERE id=?").get(item.productId);
            txUserErr = `Not enough stock for "${item.name}" (have ${cur?.stock ?? 0}, need ${item.qty}).`;
            break;
          }
        }

        if (!txUserErr) {
          const count = dbx.prepare("SELECT COUNT(*) c FROM sales").get().c || 0;
          const receiptNo = `R-${String(count + 1).padStart(5, "0")}`;
          let totalCogs = 0;

          const saleInfo = dbx.prepare(`
            INSERT INTO sales (receipt_no, timestamp, cashier, payment_method,
              subtotal, discount, tax, total, received, change_amount, currency, cogs, idempotency_key)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
          `).run(receiptNo, timestamp, user.username, paymentMethod,
                 subtotal, discount, tax, total, received, changeAmount,
                 sale.currency || "INR", 0, idempotencyKey);
          const saleId = saleInfo.lastInsertRowid;

          for (const item of enrichedItems) {
            // FIFO COGS: oldest batches first, fall back to cost_price
            let rem = item.qty, itemCogs = 0;
            const batches = dbx.prepare(
              "SELECT id, unit_cost, qty_remaining FROM cost_batches WHERE product_id=? AND qty_remaining > 0 ORDER BY created_at ASC, id ASC"
            ).all(item.productId);
            for (const b of batches) {
              if (rem <= 0) break;
              const use = Math.min(rem, b.qty_remaining);
              itemCogs += use * b.unit_cost;
              dbx.prepare("UPDATE cost_batches SET qty_remaining = qty_remaining - ? WHERE id=?").run(use, b.id);
              rem -= use;
            }
            if (rem > 0) itemCogs += rem * item.costPrice;
            itemCogs   = +itemCogs.toFixed(2);
            totalCogs += itemCogs;

            dbx.prepare(
              "INSERT INTO sale_items (sale_id, product_id, name, price, qty, hsn_code, gst_rate, unit_cost, cogs) VALUES (?,?,?,?,?,?,?,?,?)"
            ).run(saleId, item.productId, item.name, item.price, item.qty,
                  item.hsnCode || null, item.gstRate || 0, item.costPrice, itemCogs);
          }

          dbx.prepare("UPDATE sales SET cogs=? WHERE id=?").run(+totalCogs.toFixed(2), saleId);
          txResult = { ok: true, receiptNo, timestamp, subtotal, tax, discount, total, paymentMethod, items: enrichedItems };
        }

        // Commit only if no user error; rollback undoes stock decrements if needed
        if (txUserErr) dbx.exec("ROLLBACK");
        else           dbx.exec("COMMIT");

      } catch (e) {
        try { dbx.exec("ROLLBACK"); } catch {}
        return json(res, 500, { error: e.message });
      }

      if (txUserErr) return json(res, 400, { error: txUserErr });
      return json(res, 200, txResult);
    }

    // ── Supabase path (best-effort atomicity) ─────────────────
    // Re-validate stock (no true transaction — unique constraint on receipt_no is final guard)
    for (const item of enrichedItems) {
      const product = await DB.getProductById(item.productId);
      if (!product || product.stock < item.qty) {
        return json(res, 400, { error: `Insufficient stock for "${item.name}".` });
      }
    }
    for (const item of enrichedItems) await DB.decrementStock(item.productId, item.qty);

    const count     = await DB.getSalesCount();
    const receiptNo = `R-${String(count + 1).padStart(5, "0")}`;

    // Compute COGS via cost_price fallback
    let totalCogs = 0;
    for (const item of enrichedItems) totalCogs += item.costPrice * item.qty;
    totalCogs = +totalCogs.toFixed(2);

    const saleId = await DB.insertSale({
      receipt_no:     receiptNo,
      timestamp,
      cashier:        user.username,
      payment_method: paymentMethod,
      subtotal, discount, tax, total, received,
      change_amount:  changeAmount,
      currency:       sale.currency || "INR",
      cogs:           totalCogs,
      idempotency_key: idempotencyKey,
    });

    for (const item of enrichedItems) {
      const itemCogs = +(item.costPrice * item.qty).toFixed(2);
      await DB.insertSaleItem({
        sale_id:    saleId,
        product_id: item.productId,
        name:       item.name,
        price:      item.price,
        qty:        item.qty,
        hsn_code:   item.hsnCode || null,
        gst_rate:   item.gstRate || 0,
        unit_cost:  item.costPrice,
        cogs:       itemCogs,
      });
    }

    return json(res, 200, { ok: true, receiptNo, timestamp, subtotal, tax, discount, total, paymentMethod, items: enrichedItems });
  }

  if (pathname === "/api/history" && req.method === "DELETE") {
    if (!requireAdmin(req)) return json(res, 403, { error: "Admin only." });
    await DB.clearHistory();
    return json(res, 200, { ok: true });
  }

  if (pathname === "/api/settings" && req.method === "PUT") {
    if (!requireAdmin(req)) return json(res, 403, { error: "Admin only." });
    const body = await parseBody(req);
    for (const key of ["currency", "theme", "cashierName"]) {
      if (body[key] !== undefined) await DB.updateSetting(key, String(body[key]).slice(0, 100));
    }
    return json(res, 200, { ok: true });
  }

  if (pathname === "/api/suppliers" && req.method === "GET") {
    if (!requireAuth(req)) return json(res, 401, { error: "Login required." });
    if (SUPABASE_URL) {
      const suppliers = await sbQuery("suppliers", "GET", null, "?select=id,name,phone,email&order=name") || [];
      return json(res, 200, { suppliers });
    }
    const suppliers = getDb().prepare("SELECT id, name, phone, email FROM suppliers ORDER BY name").all();
    return json(res, 200, { suppliers });
  }

  if (pathname === "/api/suppliers" && req.method === "POST") {
    if (!requireAdmin(req)) return json(res, 403, { error: "Admin only." });
    const { name, phone, email } = await parseBody(req);
    if (!name) return json(res, 400, { error: "Supplier name required." });
    if (SUPABASE_URL) {
      await sbQuery("suppliers", "POST", { name: String(name).trim(), phone: String(phone||"").trim(), email: String(email||"").trim() });
      return json(res, 200, { ok: true });
    }
    getDb().prepare("INSERT INTO suppliers (name, phone, email) VALUES (?, ?, ?)").run(String(name).trim(), String(phone||"").trim(), String(email||"").trim());
    return json(res, 200, { ok: true });
  }

  if (pathname === "/api/purchase-orders" && req.method === "POST") {
    if (!requireAdmin(req)) return json(res, 403, { error: "Admin only." });
    const { supplierId, sku, qty } = await parseBody(req);
    if (!sku || Number(qty) <= 0) return json(res, 400, { error: "Invalid purchase order." });
    const poNumber = `PO-${Date.now()}`;
    if (SUPABASE_URL) {
      // Try SKU first, then name
      let products = await sbQuery("products", "GET", null, `?sku=ilike.${encodeURIComponent(sku.trim())}&select=id,stock&limit=1`);
      if (!products || !products.length) {
        products = await sbQuery("products", "GET", null, `?name=ilike.${encodeURIComponent(sku.trim())}&select=id,stock&limit=1`);
      }
      if (!products || !products.length) return json(res, 404, { error: `Product "${sku}" not found. Check SKU or name.` });
      const product = products[0];
      const newStock = (Number(product.stock) || 0) + Number(qty);
      // Update stock first (most important)
      await fetch(`${SUPABASE_URL}/rest/v1/products?id=eq.${product.id}`, {
        method: "PATCH",
        headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", "Prefer": "return=minimal" },
        body: JSON.stringify({ stock: newStock })
      });
      // Record PO — skip gracefully if table missing or FK error
      try {
        await sbQuery("purchase_orders", "POST", {
          supplier_id: supplierId ? Number(supplierId) : null,
          po_number: poNumber, status: "Received", total: 0,
          created_at: new Date().toISOString()
        });
      } catch (e) { console.warn("PO record insert skipped:", e.message); }
      return json(res, 200, { ok: true, poNumber, newStock });
    }
    const dbx = getDb();
    // Try SKU first, then name
    let product = dbx.prepare("SELECT id, stock FROM products WHERE lower(sku)=lower(?)").get(sku.trim());
    if (!product) product = dbx.prepare("SELECT id, stock FROM products WHERE lower(name)=lower(?)").get(sku.trim());
    if (!product) return json(res, 404, { error: `Product "${sku}" not found.` });
    const newStock = (Number(product.stock) || 0) + Number(qty);
    dbx.prepare("UPDATE products SET stock = ? WHERE id=?").run(newStock, product.id);
    try { dbx.prepare("INSERT INTO purchase_orders (supplier_id, po_number, status, total, created_at) VALUES (?, ?, 'Received', 0, ?)").run(supplierId ? Number(supplierId) : null, poNumber, new Date().toISOString()); } catch {}
    // Seed a FIFO cost batch if product has a cost_price set
    const cpRow = dbx.prepare("SELECT cost_price FROM products WHERE id=?").get(product.id);
    if (cpRow?.cost_price > 0) await DB.insertCostBatch(product.id, cpRow.cost_price, Number(qty));
    return json(res, 200, { ok: true, poNumber, newStock });
  }

  if (pathname === "/api/stock-transfer" && req.method === "POST") {
    if (!requireAdmin(req)) return json(res, 403, { error: "Admin only." });
    const { sku, qty, fromStore, toStore } = await parseBody(req);
    const amount = Number(qty);
    if (!sku || amount <= 0 || !fromStore || !toStore) return json(res, 400, { error: "Invalid transfer payload." });
    if (SUPABASE_URL) {
      // Try SKU first, then name
      let products = await sbQuery("products", "GET", null, `?sku=ilike.${encodeURIComponent(sku.trim())}&select=id,sku,stock&limit=1`);
      if (!products || !products.length) {
        products = await sbQuery("products", "GET", null, `?name=ilike.${encodeURIComponent(sku.trim())}&select=id,sku,stock&limit=1`);
      }
      if (!products || !products.length) return json(res, 404, { error: `Product "${sku}" not found.` });
      const product = products[0];
      if ((Number(product.stock) || 0) < amount) return json(res, 400, { error: `Insufficient stock. Available: ${product.stock}` });
      const newStock = (Number(product.stock) || 0) - amount;
      await fetch(`${SUPABASE_URL}/rest/v1/products?id=eq.${product.id}`, {
        method: "PATCH",
        headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", "Prefer": "return=minimal" },
        body: JSON.stringify({ stock: newStock })
      });
      await sbQuery("stock_transfers", "POST", { sku: product.sku, qty: amount, from_store: String(fromStore).trim(), to_store: String(toStore).trim(), created_at: new Date().toISOString() });
      return json(res, 200, { ok: true, newStock });
    }
    const dbx = getDb();
    // Try SKU first, then name
    let product = dbx.prepare("SELECT id, sku, stock FROM products WHERE lower(sku)=lower(?)").get(sku.trim());
    if (!product) product = dbx.prepare("SELECT id, sku, stock FROM products WHERE lower(name)=lower(?)").get(sku.trim());
    if (!product) return json(res, 404, { error: `Product "${sku}" not found.` });
    if ((Number(product.stock) || 0) < amount) return json(res, 400, { error: `Insufficient stock. Available: ${product.stock}` });
    const newStock = (Number(product.stock) || 0) - amount;
    dbx.prepare("UPDATE products SET stock = ? WHERE id=?").run(newStock, product.id);
    dbx.prepare("INSERT INTO stock_transfers (sku, qty, from_store, to_store, created_at) VALUES (?, ?, ?, ?, ?)").run(product.sku, amount, String(fromStore).trim(), String(toStore).trim(), new Date().toISOString());
    return json(res, 200, { ok: true, newStock });
  }

  if (pathname === "/api/stock-batches" && req.method === "POST") {
    if (!requireAdmin(req)) return json(res, 403, { error: "Admin only." });
    const { sku, batchNo, expiryDate, qty } = await parseBody(req);
    if (!sku || !batchNo || !expiryDate || Number(qty) <= 0) return json(res, 400, { error: "Invalid batch payload." });
    if (SUPABASE_URL) {
      await sbQuery("stock_batches", "POST", { sku: String(sku).trim(), batch_no: String(batchNo).trim(), expiry_date: String(expiryDate), qty: Number(qty) });
      return json(res, 200, { ok: true });
    }
    getDb().prepare("INSERT INTO stock_batches (sku, batch_no, expiry_date, qty) VALUES (?, ?, ?, ?)").run(String(sku).trim(), String(batchNo).trim(), String(expiryDate), Number(qty));
    return json(res, 200, { ok: true });
  }

  if (pathname === "/api/customers" && req.method === "GET") {
    if (!requireAuth(req)) return json(res, 401, { error: "Login required." });
    if (SUPABASE_URL) {
      const rows = await sbQuery("customers", "GET", null, "?select=id,name,phone,loyalty_points,member_discount,credit_balance&order=name") || [];
      const customers = rows.map(c => ({ id: c.id, name: c.name, phone: c.phone, loyaltyPoints: c.loyalty_points, memberDiscount: c.member_discount, creditBalance: c.credit_balance }));
      return json(res, 200, { customers });
    }
    const customers = getDb().prepare("SELECT id, name, phone, loyalty_points as loyaltyPoints, member_discount as memberDiscount, credit_balance as creditBalance FROM customers ORDER BY name").all();
    return json(res, 200, { customers });
  }

  if (pathname === "/api/customers" && req.method === "POST") {
    if (!requireAdmin(req)) return json(res, 403, { error: "Admin only." });
    const { name, phone, memberDiscount, creditBalance } = await parseBody(req);
    if (!name || !phone) return json(res, 400, { error: "Name and phone required." });
    if (SUPABASE_URL) {
      await sbQuery("customers", "POST", { name: String(name).trim(), phone: String(phone).trim(), loyalty_points: 0, member_discount: Number(memberDiscount||0), credit_balance: Number(creditBalance||0) });
      return json(res, 200, { ok: true });
    }
    getDb().prepare("INSERT INTO customers (name, phone, loyalty_points, member_discount, credit_balance) VALUES (?, ?, 0, ?, ?)").run(String(name).trim(), String(phone).trim(), Number(memberDiscount||0), Number(creditBalance||0));
    return json(res, 200, { ok: true });
  }

  if (pathname === "/api/change-password" && req.method === "POST") {
    const user = requireAuth(req);
    if (!user) return json(res, 401, { error: "Login required." });
    const { currentPassword, newPassword } = await parseBody(req);
    if (!currentPassword || !newPassword || newPassword.length < 8) {
      return json(res, 400, { error: "New password must be at least 8 characters." });
    }
    const dbUser = await DB.getUser(user.username, user.role);
    if (!verifyPassword(currentPassword, dbUser.password)) return json(res, 401, { error: "Wrong current password." });
    await DB.updatePassword(user.username, hashPassword(newPassword));
    return json(res, 200, { ok: true });
  }


  // ── REFUND ────────────────────────────────────────────────────
  if (pathname === "/api/refund" && req.method === "POST") {
    const user = requireAuth(req);
    if (!user) return json(res, 401, { error: "Login required." });
    const { receiptNo, reason } = await parseBody(req);
    if (!receiptNo) return json(res, 400, { error: "Receipt number required." });
    const refundNo = `REF-${receiptNo}`;

    if (SUPABASE_URL) {
      const sales = await sbQuery("sales","GET",null,`?receipt_no=eq.${encodeURIComponent(receiptNo)}&limit=1`);
      if (!sales || !sales.length) return json(res, 404, { error: "Receipt not found." });
      const sale = sales[0];
      const existing = await sbQuery("sales","GET",null,`?receipt_no=eq.${encodeURIComponent(refundNo)}&limit=1`);
      if (existing && existing.length) return json(res, 409, { error: "Already refunded." });
      const items = await sbQuery("sale_items","GET",null,`?sale_id=eq.${sale.id}&select=product_id,qty`) || [];
      for (const item of items) {
        const prod = await sbQuery("products","GET",null,`?id=eq.${item.product_id}&select=id,stock&limit=1`);
        if (prod && prod[0]) {
          await fetch(`${SUPABASE_URL}/rest/v1/products?id=eq.${item.product_id}`, {
            method: "PATCH",
            headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", "Prefer": "return=minimal" },
            body: JSON.stringify({ stock: (prod[0].stock || 0) + item.qty })
          });
        }
      }
      await sbQuery("sales","POST",{ receipt_no:refundNo, timestamp:new Date().toISOString(), cashier:user.username, payment_method:"REFUND", subtotal:-(sale.subtotal||0), discount:0, tax:-(sale.tax||0), total:-(sale.total||0), received:0, change_amount:sale.total||0, currency:sale.currency||"INR" });
      await DB.writeAudit({ actor: user.username, action: "REFUND", entityType: "sale",
        entityId: receiptNo, after: { refundNo, amount: sale.total, reason: reason||null },
        note: reason || null });
      return json(res, 200, { ok:true, refundNo, amount: sale.total||0 });
    }

    const dbx  = getDb();
    const sale = dbx.prepare("SELECT * FROM sales WHERE receipt_no=?").get(receiptNo);
    if (!sale) return json(res, 404, { error: "Receipt not found." });
    if (dbx.prepare("SELECT id FROM sales WHERE receipt_no=?").get(refundNo)) return json(res, 409, { error: "Already refunded." });
    const items = dbx.prepare("SELECT product_id, qty FROM sale_items WHERE sale_id=?").all(sale.id);
    for (const item of items) dbx.prepare("UPDATE products SET stock=stock+? WHERE id=?").run(item.qty, item.product_id);
    dbx.prepare("INSERT INTO sales (receipt_no,timestamp,cashier,payment_method,subtotal,discount,tax,total,received,change_amount,currency) VALUES(?,?,?,'REFUND',?,0,?,?,0,?,?)").run(refundNo, new Date().toISOString(), user.username, -(sale.subtotal||0), -(sale.tax||0), -(sale.total||0), sale.total||0, sale.currency||"INR");
    await DB.writeAudit({ actor: user.username, action: "REFUND", entityType: "sale",
      entityId: receiptNo, after: { refundNo, amount: sale.total, reason: reason||null },
      note: reason || null });
    return json(res, 200, { ok:true, refundNo, amount: sale.total||0 });
  }

  // ── REPORTS ───────────────────────────────────────────────────
  if (pathname === "/api/reports" && req.method === "GET") {
    if (!requireAuth(req)) return json(res, 401, { error: "Login required." });

    const urlObj = new URL(req.url, `http://${req.headers.host}`);
    const fromDate = urlObj.searchParams.get("from") || null;   // YYYY-MM-DD
    const toDate   = urlObj.searchParams.get("to")   || null;   // YYYY-MM-DD

    // ── SQLite path ─────────────────────────────────────────────
    if (!SUPABASE_URL) {
      const dbx  = getDb();
      const args = [];
      let   whr  = "WHERE payment_method != 'REFUND'";
      if (fromDate) { whr += " AND date(timestamp) >= ?"; args.push(fromDate); }
      if (toDate)   { whr += " AND date(timestamp) <= ?"; args.push(toDate);   }

      const dailySales     = dbx.prepare(`SELECT date(timestamp) as day, round(sum(total),2) as revenue, count(*) as transactions FROM sales ${whr} GROUP BY date(timestamp) ORDER BY day DESC LIMIT 14`).all(...args);
      const monthlyRevenue = dbx.prepare(`SELECT substr(timestamp,1,7) as month, round(sum(total),2) as revenue FROM sales ${whr} GROUP BY substr(timestamp,1,7) ORDER BY month DESC LIMIT 12`).all(...args);
      const taxReport      = dbx.prepare(`SELECT date(timestamp) as day, round(sum(tax),2) as gst FROM sales ${whr} GROUP BY date(timestamp) ORDER BY day DESC LIMIT 14`).all(...args);
      const cashSummary    = dbx.prepare(`SELECT payment_method as method, round(sum(total),2) as amount, count(*) as count FROM sales ${whr} GROUP BY payment_method ORDER BY amount DESC`).all(...args);

      // COGS from actual sale_items (FIFO consumed values)
      const itemArgs = [...args];
      let   itemWhr  = "si.sale_id IN (SELECT id FROM sales " + whr + ")";
      const bestSelling = dbx.prepare(`SELECT si.name, sum(si.qty) as qty, round(sum(si.cogs),2) as cogs FROM sale_items si WHERE ${itemWhr} GROUP BY si.name ORDER BY qty DESC LIMIT 10`).all(...itemArgs);
      const slowMoving  = dbx.prepare(`SELECT p.name, p.sku, p.stock, coalesce(sum(si.qty),0) as qty FROM products p LEFT JOIN sale_items si ON si.product_id = p.id AND si.sale_id IN (SELECT id FROM sales ${whr}) WHERE p.stock > 0 GROUP BY p.id ORDER BY qty ASC, p.stock DESC LIMIT 10`).all(...args);

      const revenue    = dbx.prepare(`SELECT round(sum(total),2) as v FROM sales ${whr}`).get(...args)?.v || 0;
      const cogs       = dbx.prepare(`SELECT round(sum(si.cogs),2) as v FROM sale_items si WHERE ${itemWhr}`).get(...itemArgs)?.v || 0;
      const stockValue = dbx.prepare("SELECT round(sum(cost_price * stock),2) as v FROM products WHERE cost_price > 0").get()?.v
                      || dbx.prepare("SELECT round(sum(wholesale_price * stock),2) as v FROM products").get()?.v || 0;

      return json(res, 200, { reports: {
        dailySales, monthlyRevenue, bestSelling, slowMoving, taxReport, cashSummary,
        profitLoss: { revenue, cogs, grossProfit: +((revenue||0)-(cogs||0)).toFixed(2), stockValue },
        range: { from: fromDate, to: toDate },
      }});
    }

    // ── Supabase path ────────────────────────────────────────────
    let salesFilter = "?select=timestamp,total,tax,payment_method,subtotal,cogs&order=timestamp.desc";
    if (fromDate) salesFilter += `&timestamp=gte.${fromDate}T00:00:00`;
    if (toDate)   salesFilter += `&timestamp=lte.${toDate}T23:59:59`;

    const sales    = await sbQuery("sales",    "GET", null, salesFilter) || [];
    const items    = await sbQuery("sale_items","GET",null,"?select=name,qty,price,product_id,cogs,sales(timestamp,payment_method,total)") || [];
    const products = await sbQuery("products",  "GET",null,"?select=id,name,sku,stock,price,cost_price,wholesale_price") || [];

    const cutoff30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0,10);
    const dailyMap={}, monthMap={}, taxMap={}, cashMap={}, itemMap={};

    for (const s of sales) {
      if ((s.total||0) < 0 || s.payment_method === "REFUND") continue;
      const day=s.timestamp?.slice(0,10), month=s.timestamp?.slice(0,7);
      if (!day) continue;
      if (!dailyMap[day])   dailyMap[day]  ={day,   revenue:0, transactions:0};
      if (!monthMap[month]) monthMap[month]={month, revenue:0};
      if (!taxMap[day])     taxMap[day]    ={day,   gst:0};
      const m=s.payment_method||"Other";
      if (!cashMap[m])      cashMap[m]     ={method:m, amount:0, count:0};
      dailyMap[day].revenue      =+((dailyMap[day].revenue||0)  +(s.total||0)).toFixed(2);
      dailyMap[day].transactions++;
      monthMap[month].revenue    =+((monthMap[month].revenue||0)+(s.total||0)).toFixed(2);
      taxMap[day].gst            =+((taxMap[day].gst||0)        +(s.tax||0)).toFixed(2);
      cashMap[m].amount          =+((cashMap[m].amount||0)      +(s.total||0)).toFixed(2);
      cashMap[m].count++;
    }

    for (const i of items) {
      const st = i.sales?.timestamp?.slice(0,10);
      const isRefund = i.sales?.payment_method === "REFUND" || (i.sales?.total || 0) < 0;
      if (isRefund) continue;
      if (fromDate && st && st < fromDate) continue;
      if (toDate && st && st > toDate) continue;
      if (!itemMap[i.name]) itemMap[i.name]={name:i.name, qty:0, cogs:0};
      itemMap[i.name].qty  += i.qty||0;
      itemMap[i.name].cogs += i.cogs||0;
    }
    const allItems = Object.values(itemMap);

    // Slow moving — 30-day window
    const sold30Map = {};
    const recentItems = await sbQuery("sale_items","GET",null,
      `?select=name,qty,sales(timestamp,payment_method,total)&sales.timestamp=gte.${cutoff30}T00:00:00`) || [];
    for (const i of recentItems) {
      const ts = i.sales?.timestamp;
      const isRefund = i.sales?.payment_method === "REFUND" || (i.sales?.total || 0) < 0;
      if (!ts || ts.slice(0,10) < cutoff30 || isRefund) continue;
      sold30Map[i.name] = (sold30Map[i.name]||0) + (i.qty||0);
    }
    const slowMoving = products
      .filter(p => p.stock > 0)
      .map(p => ({ name: p.name, sku: p.sku, stock: p.stock, qty: sold30Map[p.name] || 0 }))
      .sort((a,b) => a.qty !== b.qty ? a.qty - b.qty : b.stock - a.stock)
      .slice(0, 10);

    const revenue    = +sales.filter(s=>(s.total||0)>0 && s.payment_method !== "REFUND").reduce((a,s)=>a+(s.total||0),0).toFixed(2);
    const cogs       = +sales.filter(s=>(s.total||0)>=0 && s.payment_method !== "REFUND").reduce((a,s)=>a+(s.cogs||0),0).toFixed(2);
    const stockValue = +products.reduce((a,p)=>a+((p.cost_price||p.wholesale_price||p.price||0)*(p.stock||0)),0).toFixed(2);

    return json(res, 200, { reports: {
      dailySales:     Object.values(dailyMap).sort((a,b)=>b.day.localeCompare(a.day)).slice(0,14),
      monthlyRevenue: Object.values(monthMap).sort((a,b)=>b.month.localeCompare(a.month)).slice(0,12),
      bestSelling:    [...allItems].sort((a,b)=>b.qty-a.qty).slice(0,10),
      slowMoving,
      taxReport:      Object.values(taxMap).sort((a,b)=>b.day.localeCompare(a.day)).slice(0,14),
      cashSummary:    Object.values(cashMap).sort((a,b)=>b.amount-a.amount),
      profitLoss:     { revenue, cogs, grossProfit:+(revenue-cogs).toFixed(2), stockValue },
      range:          { from: fromDate, to: toDate },
    }});
  }


  // ── GET USERS (admin only) ────────────────────────────────────
  if (pathname === "/api/users" && req.method === "GET") {
    if (!requireAdmin(req)) return json(res, 403, { error: "Admin only." });
    if (SUPABASE_URL) {
      const rows = await sbQuery("users", "GET", null, "?select=id,username,role&order=username") || [];
      return json(res, 200, { users: rows });
    }
    const users = getDb().prepare("SELECT id, username, role FROM users ORDER BY username").all();
    return json(res, 200, { users });
  }

  // ── CREATE USER (admin only) ──────────────────────────────────
  if (pathname === "/api/users" && req.method === "POST") {
    if (!requireAdmin(req)) return json(res, 403, { error: "Admin only." });
    const { username, password, role } = await parseBody(req);
    if (!username || !password || !role) return json(res, 400, { error: "All fields required." });
    if (username.length < 3 || username.length > 50) return json(res, 400, { error: "Username must be 3-50 chars." });
    if (password.length < 6) return json(res, 400, { error: "Password must be at least 6 characters." });
    if (!["admin","user"].includes(role)) return json(res, 400, { error: "Role must be admin or user." });
    const hashed = hashPassword(password);
    if (SUPABASE_URL) {
      try {
        await sbQuery("users", "POST", { username: username.trim(), password: hashed, role });
        return json(res, 200, { ok: true });
      } catch (e) {
        if (String(e.message).includes("duplicate") || String(e.message).includes("unique")) return json(res, 409, { error: "Username already exists." });
        throw e;
      }
    }
    try {
      getDb().prepare("INSERT INTO users (username, password, role) VALUES (?, ?, ?)").run(username.trim(), hashed, role);
      return json(res, 200, { ok: true });
    } catch (e) {
      return json(res, 409, { error: "Username already exists." });
    }
  }

  // ── DELETE USER (admin only) ──────────────────────────────────
  if (pathname.startsWith("/api/users/") && req.method === "DELETE") {
    const admin = requireAdmin(req);
    if (!admin) return json(res, 403, { error: "Admin only." });
    const targetUsername = decodeURIComponent(pathname.replace("/api/users/", ""));
    if (targetUsername === admin.username) return json(res, 400, { error: "Cannot delete your own account." });
    if (SUPABASE_URL) {
      await sbQuery("users", "DELETE", null, `?username=eq.${encodeURIComponent(targetUsername)}`);
      return json(res, 200, { ok: true });
    }
    getDb().prepare("DELETE FROM users WHERE username=? AND username != ?").run(targetUsername, admin.username);
    return json(res, 200, { ok: true });
  }

  // ── RESET USER PASSWORD (admin only) ─────────────────────────
  if (pathname.startsWith("/api/users/") && pathname.endsWith("/reset-password") && req.method === "POST") {
    if (!requireAdmin(req)) return json(res, 403, { error: "Admin only." });
    const targetUsername = decodeURIComponent(pathname.replace("/api/users/","").replace("/reset-password",""));
    const { newPassword } = await parseBody(req);
    if (!newPassword || newPassword.length < 6) return json(res, 400, { error: "Password must be at least 6 characters." });
    const hashed = hashPassword(newPassword);
    if (SUPABASE_URL) {
      await sbQuery("users", "PATCH", { password: hashed }, `?username=eq.${encodeURIComponent(targetUsername)}`);
      return json(res, 200, { ok: true });
    }
    getDb().prepare("UPDATE users SET password=? WHERE username=?").run(hashed, targetUsername);
    return json(res, 200, { ok: true });
  }


  // ── SKU SUGGESTIONS (autocomplete) ───────────────────────────
  if (pathname === "/api/sku-suggest" && req.method === "GET") {
    if (!requireAuth(req)) return json(res, 401, { error: "Login required." });
    const q = new URL("http://x" + req.url).searchParams.get("q") || "";
    if (SUPABASE_URL) {
      const rows = await sbQuery("products","GET",null,
        `?select=name,sku,stock,price&or=(sku.ilike.*${q}*,name.ilike.*${q}*)&limit=8`) || [];
      return json(res, 200, { suggestions: rows });
    }
    const rows = getDb().prepare(
      "SELECT name, sku, stock, price FROM products WHERE sku LIKE ? OR name LIKE ? LIMIT 8"
    ).all(`%${q}%`, `%${q}%`);
    return json(res, 200, { suggestions: rows });
  }


  // ── STOCK ADJUSTMENT (admin only) ────────────────────────────
  if (pathname.startsWith("/api/products/") && pathname.endsWith("/stock") && req.method === "PATCH") {
    const admin = requireAdmin(req);
    if (!admin) return json(res, 403, { error: "Admin only." });
    const sku = decodeURIComponent(pathname.split("/")[3]);
    const { stock, reason } = await parseBody(req);
    if (stock === undefined || stock < 0) return json(res, 400, { error: "Invalid stock value." });

    // Fetch old stock for audit
    let oldStock = null;
    let productId = null;
    if (SUPABASE_URL) {
      const rows = await sbQuery("products","GET",null,`?sku=eq.${encodeURIComponent(sku)}&select=id,stock&limit=1`).catch(()=>null);
      oldStock  = rows?.[0]?.stock ?? null;
      productId = rows?.[0]?.id   ?? null;
      await sbQuery("products", "PATCH", { stock }, `?sku=eq.${encodeURIComponent(sku)}`);
    } else {
      const row = getDb().prepare("SELECT id, stock FROM products WHERE sku=?").get(sku);
      oldStock  = row?.stock ?? null;
      productId = row?.id   ?? null;
      getDb().prepare("UPDATE products SET stock=? WHERE sku=?").run(stock, sku);
    }

    await DB.writeAudit({ actor: admin.username, action: "STOCK_ADJUST", entityType: "product",
      entityId: sku, before: { stock: oldStock }, after: { stock: Number(stock) }, note: reason||null });

    // Seed a cost batch if stock went up and cost_price is set
    if (oldStock !== null && Number(stock) > oldStock) {
      const addedQty = Number(stock) - oldStock;
      let costPrice = 0;
      if (SUPABASE_URL) {
        const p = await sbQuery("products","GET",null,`?id=eq.${productId}&select=cost_price&limit=1`).catch(()=>null);
        costPrice = p?.[0]?.cost_price || 0;
      } else {
        costPrice = getDb().prepare("SELECT cost_price FROM products WHERE id=?").get(productId)?.cost_price || 0;
      }
      if (costPrice > 0 && productId) await DB.insertCostBatch(productId, costPrice, addedQty);
    }

    return json(res, 200, { ok: true });
  }


  // ── GET /api/categories ────────────────────────────────────────
  if (pathname === "/api/categories" && req.method === "GET") {
    if (!requireAuth(req)) return json(res, 401, { error: "Login required." });
    if (SUPABASE_URL) {
      const cats = await sbQuery("categories","GET",null,"?select=id,name,hsn_code,gst_rate&order=name") || [];
      return json(res, 200, { categories: cats });
    }
    return json(res, 200, { categories: getDb().prepare("SELECT id,name,hsn_code,gst_rate FROM categories ORDER BY name").all() });
  }

  // ── POST /api/categories ───────────────────────────────────────
  if (pathname === "/api/categories" && req.method === "POST") {
    if (!requireAdmin(req)) return json(res, 403, { error: "Admin only." });
    const { name, hsnCode, gstRate } = await parseBody(req);
    if (!name || !hsnCode) return json(res, 400, { error: "Name and HSN code required." });
    if (![0,3,5,12,18,28].includes(Number(gstRate))) return json(res, 400, { error: "GST rate must be 0, 3, 5, 12, 18 or 28." });
    if (SUPABASE_URL) {
      try {
        const rows = await sbQuery("categories","POST",{ name:name.trim(), hsn_code:hsnCode.trim(), gst_rate:Number(gstRate) });
        return json(res, 200, { ok:true, category:rows?.[0] });
      } catch(e) {
        if (e.message.includes("duplicate")||e.message.includes("unique")) return json(res, 409, { error:"Category already exists." });
        throw e;
      }
    }
    try {
      const info = getDb().prepare("INSERT INTO categories(name,hsn_code,gst_rate) VALUES(?,?,?)").run(name.trim(),hsnCode.trim(),Number(gstRate));
      return json(res, 200, { ok:true, category:{id:info.lastInsertRowid,name:name.trim(),hsn_code:hsnCode.trim(),gst_rate:Number(gstRate)} });
    } catch(e) { return json(res, 409, { error:"Category already exists." }); }
  }

  // ── DELETE PRODUCT (admin only) ───────────────────────────────
  if (pathname.startsWith("/api/products/") && req.method === "DELETE") {
    if (!requireAdmin(req)) return json(res, 403, { error: "Admin only." });
    const productId = decodeURIComponent(pathname.replace("/api/products/", ""));
    if (!productId) return json(res, 400, { error: "Product ID required." });
    if (SUPABASE_URL) {
      await sbQuery("products", "DELETE", null, `?id=eq.${encodeURIComponent(productId)}`);
      return json(res, 200, { ok: true });
    }
    getDb().prepare("DELETE FROM products WHERE id=?").run(productId);
    return json(res, 200, { ok: true });
  }

  // ── EOD Z-REPORT ──────────────────────────────────────────────
  if (pathname === "/api/z-report" && req.method === "GET") {
    if (!requireAdmin(req)) return json(res, 403, { error: "Admin only." });
    const reports = await DB.listZReports(30);
    return json(res, 200, { zReports: reports });
  }

  if (pathname === "/api/z-report" && req.method === "POST") {
    const admin = requireAdmin(req);
    if (!admin) return json(res, 403, { error: "Admin only." });
    const { openingCash = 0, closingCash = 0, notes = "" } = await parseBody(req);

    const lastZ   = await DB.getLastZReport();
    const since   = lastZ?.closed_at || new Date().toISOString().slice(0, 10) + "T00:00:00.000Z";
    const allSales = await DB.getSalesSince(since);

    const today    = new Date().toISOString().slice(0, 10);
    const closedAt = new Date().toISOString();
    let cashSales = 0, cardSales = 0, mobileSales = 0, splitSales = 0;
    let totalSales = 0, totalTax = 0, totalRefunds = 0, txCount = 0;

    for (const s of allSales) {
      const t      = s.total || 0;
      const method = (s.payment_method || "").toLowerCase();
      if (method === "refund") { totalRefunds += Math.abs(t); continue; }
      if (t <= 0) continue;
      totalSales += t; totalTax += s.tax || 0; txCount++;
      if      (method === "cash")                                        cashSales   += t;
      else if (method === "card")                                        cardSales   += t;
      else if (method.includes("mobile") || method.includes("wallet"))  mobileSales += t;
      else                                                               splitSales  += t;
    }

    const row = {
      report_date: today, closed_at: closedAt, cashier: admin.username,
      opening_cash: +Number(openingCash).toFixed(2), closing_cash: +Number(closingCash).toFixed(2),
      cash_sales: +cashSales.toFixed(2), card_sales: +cardSales.toFixed(2),
      mobile_sales: +mobileSales.toFixed(2), split_sales: +splitSales.toFixed(2),
      total_sales: +totalSales.toFixed(2), total_tax: +totalTax.toFixed(2),
      total_refunds: +totalRefunds.toFixed(2), transaction_count: txCount,
      notes: String(notes || "").slice(0, 500), status: "closed",
    };

    await DB.insertZReport(row);
    await DB.writeAudit({ actor: admin.username, action: "Z_REPORT", entityType: "z_report",
      entityId: today, after: row });
    return json(res, 200, { ok: true, zReport: row });
  }

  // ── AUDIT LOG ─────────────────────────────────────────────────
  if (pathname === "/api/audit-log" && req.method === "GET") {
    if (!requireAdmin(req)) return json(res, 403, { error: "Admin only." });
    const urlObj   = new URL(req.url, `http://${req.headers.host}`);
    const limitVal = Math.min(Number(urlObj.searchParams.get("limit") || 100), 500);
    const entity   = urlObj.searchParams.get("entity") || null;
    if (SUPABASE_URL) {
      let filter = `?order=id.desc&limit=${limitVal}`;
      if (entity) filter += `&entity_type=eq.${encodeURIComponent(entity)}`;
      const rows = await sbQuery("audit_log", "GET", null, filter).catch(() => []) || [];
      return json(res, 200, { auditLog: rows });
    }
    const rows = entity
      ? getDb().prepare("SELECT * FROM audit_log WHERE entity_type=? ORDER BY id DESC LIMIT ?").all(entity, limitVal)
      : getDb().prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?").all(limitVal);
    return json(res, 200, { auditLog: rows });
  }

  // ── COST PRICE UPDATE ─────────────────────────────────────────
  if (pathname.startsWith("/api/products/") && pathname.endsWith("/cost") && req.method === "PATCH") {
    const admin = requireAdmin(req);
    if (!admin) return json(res, 403, { error: "Admin only." });
    const sku = decodeURIComponent(pathname.replace("/api/products/", "").replace("/cost", ""));
    const { costPrice, qty, reason } = await parseBody(req);
    if (isNaN(Number(costPrice)) || Number(costPrice) < 0) return json(res, 400, { error: "Invalid cost price." });
    if (SUPABASE_URL) {
      await sbQuery("products", "PATCH", { cost_price: Number(costPrice) }, `?sku=ilike.${encodeURIComponent(sku)}`);
      const rows = await sbQuery("products","GET",null,`?sku=ilike.${encodeURIComponent(sku)}&select=id&limit=1`).catch(()=>null);
      const productId = rows?.[0]?.id;
      if (productId && Number(qty) > 0) await DB.insertCostBatch(productId, Number(costPrice), Number(qty));
    } else {
      getDb().prepare("UPDATE products SET cost_price=? WHERE lower(sku)=lower(?)").run(Number(costPrice), sku);
      if (Number(qty) > 0) {
        const row = getDb().prepare("SELECT id FROM products WHERE lower(sku)=lower(?)").get(sku);
        if (row) await DB.insertCostBatch(row.id, Number(costPrice), Number(qty));
      }
    }
    await DB.writeAudit({ actor: admin.username, action: "COST_UPDATE", entityType: "product",
      entityId: sku, after: { costPrice: Number(costPrice), qty: Number(qty||0) }, note: reason||null });
    return json(res, 200, { ok: true });
  }

  return false;
}

// ── STATIC FILE SERVER ────────────────────────────────────────
async function serveStatic(res, pathname) {
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const safePath  = normalize(requested).replace(/^\.{2,}(\/|\\|$)/, "");

  if (BLOCKED_FILES.some((f) => safePath === f || safePath.startsWith(f + "/"))) {
    res.writeHead(403, { "X-Content-Type-Options": "nosniff" });
    res.end("Forbidden");
    return;
  }

  // Serve only from /public folder
  const filePath = join(ROOT, "public", safePath);
  if (!filePath.startsWith(join(ROOT, "public"))) {
    res.writeHead(403); res.end("Forbidden"); return;
  }

  try {
    const content = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type":           MIME[extname(filePath)] || "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options":         "DENY",
    });
    res.end(content);
  } catch {
    res.writeHead(404); res.end("Not found");
  }
}

// ── SQLITE INIT (fallback only) ──────────────────────────────
async function initSqlite() {
  if (SUPABASE_URL) return; // skip if using Supabase
  const { DatabaseSync } = await import("node:sqlite");
  db = new DatabaseSync(join(ROOT, "novapos.db"));

  // Step 1: Minimal CREATE TABLE — no complex columns so it never conflicts with old DBs
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT UNIQUE, password TEXT, role TEXT);
    CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL);
    CREATE TABLE IF NOT EXISTS tax_codes (id TEXT PRIMARY KEY, name TEXT NOT NULL, gst_rate REAL DEFAULT 0, cess_rate REAL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY, name TEXT, sku TEXT UNIQUE, price REAL, stock INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS sales (id INTEGER PRIMARY KEY, receipt_no TEXT UNIQUE, timestamp TEXT, cashier TEXT, payment_method TEXT, subtotal REAL, discount REAL, tax REAL, total REAL, received REAL, change_amount REAL, currency TEXT DEFAULT 'INR');
    CREATE TABLE IF NOT EXISTS sale_items (id INTEGER PRIMARY KEY, sale_id INTEGER, product_id TEXT, name TEXT, price REAL, qty INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS suppliers (id INTEGER PRIMARY KEY, name TEXT, phone TEXT, email TEXT);
    CREATE TABLE IF NOT EXISTS purchase_orders (id INTEGER PRIMARY KEY, supplier_id INTEGER, po_number TEXT, status TEXT, total REAL, created_at TEXT);
    CREATE TABLE IF NOT EXISTS stock_transfers (id INTEGER PRIMARY KEY, sku TEXT, qty INTEGER, from_store TEXT, to_store TEXT, created_at TEXT);
    CREATE TABLE IF NOT EXISTS stock_batches (id INTEGER PRIMARY KEY, sku TEXT, batch_no TEXT, expiry_date TEXT, qty INTEGER);
    CREATE TABLE IF NOT EXISTS customers    (id INTEGER PRIMARY KEY, name TEXT, phone TEXT UNIQUE, loyalty_points INTEGER DEFAULT 0, member_discount REAL DEFAULT 0, credit_balance REAL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS audit_log    (id INTEGER PRIMARY KEY, timestamp TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT, before_value TEXT, after_value TEXT, note TEXT);
    CREATE TABLE IF NOT EXISTS z_reports    (id INTEGER PRIMARY KEY, report_date TEXT NOT NULL, closed_at TEXT NOT NULL, cashier TEXT NOT NULL, opening_cash REAL DEFAULT 0, closing_cash REAL DEFAULT 0, cash_sales REAL DEFAULT 0, card_sales REAL DEFAULT 0, mobile_sales REAL DEFAULT 0, split_sales REAL DEFAULT 0, total_sales REAL DEFAULT 0, total_tax REAL DEFAULT 0, total_refunds REAL DEFAULT 0, transaction_count INTEGER DEFAULT 0, notes TEXT, status TEXT DEFAULT 'closed');
    CREATE TABLE IF NOT EXISTS cost_batches (id INTEGER PRIMARY KEY, product_id TEXT NOT NULL, unit_cost REAL NOT NULL, qty_remaining INTEGER NOT NULL, created_at TEXT NOT NULL);
  `);

  // Step 2: Add every column that may be missing from old schemas (silent no-op if already exists)
  const ensureCol = (sql) => { try { db.exec(sql); } catch {} };
  ensureCol("ALTER TABLE categories ADD COLUMN hsn_code TEXT NOT NULL DEFAULT ''");
  ensureCol("ALTER TABLE categories ADD COLUMN gst_rate  REAL DEFAULT 0");
  ensureCol("ALTER TABLE products   ADD COLUMN barcode         TEXT");
  ensureCol("ALTER TABLE products   ADD COLUMN wholesale_price REAL DEFAULT 0");
  ensureCol("ALTER TABLE products   ADD COLUMN retail_price    REAL DEFAULT 0");
  ensureCol("ALTER TABLE products   ADD COLUMN mrp             REAL DEFAULT 0");
  ensureCol("ALTER TABLE products   ADD COLUMN cess_rate       REAL DEFAULT 0");
  ensureCol("ALTER TABLE products   ADD COLUMN tax_code        TEXT");
  ensureCol("ALTER TABLE products   ADD COLUMN hsn_code        TEXT DEFAULT ''");
  ensureCol("ALTER TABLE products   ADD COLUMN gst_rate        REAL DEFAULT 0");
  ensureCol("ALTER TABLE products   ADD COLUMN category_id     INTEGER");
  ensureCol("ALTER TABLE sale_items ADD COLUMN hsn_code        TEXT DEFAULT ''");
  ensureCol("ALTER TABLE sale_items ADD COLUMN gst_rate        REAL DEFAULT 0");
  ensureCol("ALTER TABLE sale_items ADD COLUMN unit_cost       REAL DEFAULT 0");
  ensureCol("ALTER TABLE sale_items ADD COLUMN cogs            REAL DEFAULT 0");
  ensureCol("ALTER TABLE sales      ADD COLUMN idempotency_key TEXT");
  ensureCol("ALTER TABLE sales      ADD COLUMN cogs            REAL DEFAULT 0");
  ensureCol("ALTER TABLE products   ADD COLUMN cost_price      REAL DEFAULT 0");
  try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_idempotency ON sales(idempotency_key) WHERE idempotency_key IS NOT NULL"); } catch {}

  // Step 3: Backfill NULLs so all rows are usable
  db.exec("UPDATE products  SET barcode         = sku   WHERE barcode         IS NULL OR barcode         = ''");
  db.exec("UPDATE products  SET hsn_code        = ''    WHERE hsn_code        IS NULL");
  db.exec("UPDATE products  SET gst_rate        = 0     WHERE gst_rate        IS NULL");
  db.exec("UPDATE products  SET cess_rate       = 0     WHERE cess_rate       IS NULL");
  db.exec("UPDATE products  SET retail_price    = price WHERE retail_price    IS NULL OR retail_price    = 0");
  db.exec("UPDATE products  SET wholesale_price = ROUND(price / 1.18, 2) WHERE wholesale_price IS NULL OR wholesale_price = 0");
  db.exec("UPDATE products  SET mrp             = price WHERE mrp             IS NULL OR mrp             = 0");
  db.exec("UPDATE sale_items SET hsn_code = '' WHERE hsn_code IS NULL");
  db.exec("UPDATE sale_items SET gst_rate = 0  WHERE gst_rate IS NULL");
  db.exec("UPDATE categories SET hsn_code = '' WHERE hsn_code IS NULL");
  db.exec("UPDATE categories SET gst_rate = 0  WHERE gst_rate IS NULL");

  for (const t of DEFAULT_TAX_CODES) {
    db.prepare("INSERT OR IGNORE INTO tax_codes (id, name, gst_rate, cess_rate) VALUES (?, ?, ?, ?)").run(t.id, t.name, t.gst_rate, t.cess_rate);
  }
  const adminExists = db.prepare("SELECT id FROM users WHERE username='admin'").get();
  if (!adminExists) {
    db.prepare("INSERT OR IGNORE INTO users (username, password, role) VALUES (?, ?, ?)").run("admin",   hashPassword("admin123"),  "admin");
    db.prepare("INSERT OR IGNORE INTO users (username, password, role) VALUES (?, ?, ?)").run("cashier", hashPassword("cash123"),   "user");
    console.log("⚠️  Default users created. Change passwords after first login!");
  }
  const count = db.prepare("SELECT COUNT(*) c FROM products").get().c;
  if (!count) {
    // Seed GST categories first
    const CAT_DATA = [
      [1,"Biscuits & Bakery","1905",18],[2,"Beverages","2202",18],[3,"Dairy Products","0401",5],
      [4,"Soap & Detergent","3401",18],[5,"Shampoo & Hair Care","3305",18],[6,"Mobile Phones","8517",18],
      [7,"Medicines","3004",12],[8,"Fresh Vegetables","0702",0],[9,"Branded Garments","6109",12],
      [10,"Footwear","6401",5],[11,"Packaged Food","2106",18],[12,"Coffee & Tea","2101",18],
      [13,"Edible Oil","1511",5],[14,"Cereals & Grains","1001",0],[15,"Electrical Goods","8501",18],
      [16,"Aerated Drinks","2202",28],
    ];
    CAT_DATA.forEach(([id,n,h,g]) => db.prepare("INSERT OR IGNORE INTO categories(id,name,hsn_code,gst_rate) VALUES(?,?,?,?)").run(id,n,h,g));
    const ins = db.prepare("INSERT INTO products (id,name,sku,barcode,price,wholesale_price,retail_price,mrp,stock,hsn_code,gst_rate,cess_rate,tax_code,category_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    [
      [crypto.randomUUID(),"Coffee 250g",  "CF-250",  "CF-250",  8.50,7.20,8.50,10.00,42,"2101",18,0,"GST_18",12],
      [crypto.randomUUID(),"Milk 1L",      "MLK-1L",  "MLK-1L",  2.20,2.10,2.20,2.50,25,"0401", 5,0,"GST_5",3],
      [crypto.randomUUID(),"Bread Loaf",   "BR-LOAF", "BR-LOAF", 1.80,1.53,1.80,2.00,14,"1905",18,0,"GST_18",1],
      [crypto.randomUUID(),"Chocolate Bar","CH-80",   "CH-80",   1.25,1.06,1.25,1.50, 8,"1905",18,0,"GST_18",1],
      [crypto.randomUUID(),"Orange Juice", "OJ-1L",   "OJ-1L",   3.90,3.31,3.90,4.50,12,"2202",18,0,"GST_18",2],
    ].forEach((row) => ins.run(...row));
    console.log("🌱 Sample products seeded.");
  }
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('currency', 'INR')").run();
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('theme', 'light')").run();
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('cashierName', '')").run();
  db.prepare("INSERT OR IGNORE INTO suppliers (id, name, phone, email) VALUES (1, 'Fresh Farms', '+911111111111', 'ops@freshfarms.test')").run();
  db.prepare("INSERT OR IGNORE INTO suppliers (id, name, phone, email) VALUES (2, 'City Wholesale', '+922222222222', 'supply@citywholesale.test')").run();
  db.prepare("INSERT OR IGNORE INTO customers (id, name, phone, loyalty_points, member_discount, credit_balance) VALUES (1, 'Aisha Khan', '9000000001', 120, 5, 0)").run();
  db.prepare("INSERT OR IGNORE INTO customers (id, name, phone, loyalty_points, member_discount, credit_balance) VALUES (2, 'Rahul Verma', '9000000002', 60, 2, 150)").run();
}


// ── SUPABASE SEED ─────────────────────────────────────────────
// Auto-seeds users, products, settings if Supabase tables are empty
async function initSupabase() {
  if (!SUPABASE_URL) return;
  try {
    // Seed users
    const users = await sbQuery("users", "GET", null, "?select=id&limit=1");
    if (!users || users.length === 0) {
      console.log("🌱 Seeding default users into Supabase...");
      await sbQuery("users", "POST", { username: "admin",   password: hashPassword("admin123"), role: "admin" });
      await sbQuery("users", "POST", { username: "cashier", password: hashPassword("cash123"),  role: "user"  });
      console.log("⚠️  Default users created. Change passwords after first login!");
    }
    // Seed GST categories
    const existingCats = await sbQuery("categories","GET",null,"?select=id&limit=1").catch(()=>null);
    if (!existingCats || existingCats.length === 0) {
      console.log("🌱 Seeding GST categories into Supabase...");
      const CATS = [
        {name:"Biscuits & Bakery",  hsn_code:"1905",gst_rate:18},{name:"Beverages",           hsn_code:"2202",gst_rate:18},
        {name:"Dairy Products",     hsn_code:"0401",gst_rate:5}, {name:"Soap & Detergent",    hsn_code:"3401",gst_rate:18},
        {name:"Shampoo & Hair Care",hsn_code:"3305",gst_rate:18},{name:"Mobile Phones",        hsn_code:"8517",gst_rate:18},
        {name:"Medicines",          hsn_code:"3004",gst_rate:12},{name:"Fresh Vegetables",     hsn_code:"0702",gst_rate:0},
        {name:"Branded Garments",   hsn_code:"6109",gst_rate:12},{name:"Footwear",             hsn_code:"6401",gst_rate:5},
        {name:"Packaged Food",      hsn_code:"2106",gst_rate:18},{name:"Coffee & Tea",         hsn_code:"2101",gst_rate:18},
        {name:"Edible Oil",         hsn_code:"1511",gst_rate:5}, {name:"Cereals & Grains",     hsn_code:"1001",gst_rate:0},
        {name:"Electrical Goods",   hsn_code:"8501",gst_rate:18},{name:"Aerated Drinks",       hsn_code:"2202",gst_rate:28},
      ];
      for (const c of CATS) await sbQuery("categories","POST",c).catch(()=>{});
    }
    // Seed tax codes (if table exists)
    try {
      const existingTax = await sbQuery("tax_codes", "GET", null, "?select=id&limit=1");
      if (!existingTax || existingTax.length === 0) {
        for (const t of DEFAULT_TAX_CODES) {
          await sbQuery("tax_codes", "POST", t).catch(() => {});
        }
      }
    } catch {}
    // Verify new tables exist (warn if migration not run)
    for (const tbl of ["audit_log", "z_reports", "cost_batches"]) {
      await sbQuery(tbl, "GET", null, "?select=id&limit=0").catch(() => {
        console.warn(`⚠️  Table "${tbl}" not found in Supabase. Run the migration SQL from server.js header.`);
      });
    }
    // Seed products
    const products = await sbQuery("products", "GET", null, "?select=id&limit=1");
    if (!products || products.length === 0) {
      console.log("🌱 Seeding default products into Supabase...");
      const allCats = await sbQuery("categories","GET",null,"?select=id,name").catch(()=>[]) || [];
      const cid = n => allCats.find(c=>c.name===n)?.id||null;
      const items = [
        { id:crypto.randomUUID(), name:"Coffee 250g",   sku:"CF-250",  price:8.5,  stock:42, hsn_code:"2101",gst_rate:18, category_id:cid("Coffee & Tea") },
        { id:crypto.randomUUID(), name:"Milk 1L",       sku:"MLK-1L",  price:2.2,  stock:25, hsn_code:"0401",gst_rate:5,  category_id:cid("Dairy Products") },
        { id:crypto.randomUUID(), name:"Bread Loaf",    sku:"BR-LOAF", price:1.8,  stock:14, hsn_code:"1905",gst_rate:18, category_id:cid("Biscuits & Bakery") },
        { id:crypto.randomUUID(), name:"Chocolate Bar", sku:"CH-80",   price:1.25, stock:8,  hsn_code:"1905",gst_rate:18, category_id:cid("Biscuits & Bakery") },
        { id:crypto.randomUUID(), name:"Orange Juice",  sku:"OJ-1L",   price:3.9,  stock:12, hsn_code:"2202",gst_rate:18, category_id:cid("Beverages") },
      ];
      for (const p of items) await sbQuery("products", "POST", p);
    }
    // Seed settings
    const settings = await sbQuery("settings", "GET", null, "?select=key&limit=1");
    if (!settings || settings.length === 0) {
      await sbQuery("settings", "POST", { key: "currency",    value: "INR"   });
      await sbQuery("settings", "POST", { key: "theme",       value: "light" });
      await sbQuery("settings", "POST", { key: "cashierName", value: ""      });
    }
    console.log("✅ Supabase ready!");
  } catch (err) {
    console.error("❌ Supabase seed error:", err.message);
  }
}

// ── START ─────────────────────────────────────────────────────
await initSqlite();
await initSupabase();

createServer(async (req, res) => {
  const origin = process.env.ALLOWED_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin",  origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith("/api/")) {
    try {
      const handled = await handleApi(req, res, url.pathname);
      if (handled === false) json(res, 404, { error: "Not found" });
    } catch (err) {
      console.error("API Error:", err.message);
      json(res, 500, { error: "Internal server error." });
    }
    return;
  }
  await serveStatic(res, url.pathname);
}).listen(PORT, () => {
  console.log(`✅ NovaPOS running on http://localhost:${PORT}`);
  console.log(SUPABASE_URL ? "🗄️  Using Supabase database" : "🗄️  Using local SQLite (set SUPABASE_URL to sync across devices)");
});