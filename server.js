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
      // Use RPC for atomic decrement
      await sbRpc("decrement_stock", { p_id: id, p_qty: qty });
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
      INSERT INTO sales (receipt_no, timestamp, cashier, payment_method, subtotal, discount, tax, total, received, change_amount, currency)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(sale.receipt_no, sale.timestamp, sale.cashier, sale.payment_method,
           sale.subtotal, sale.discount, sale.tax, sale.total, sale.received, sale.change_amount, sale.currency);
    return info.lastInsertRowid;
  },

  async insertSaleItem(item) {
    if (SUPABASE_URL) {
      await sbQuery("sale_items", "POST", item);
    } else {
      getDb().prepare("INSERT INTO sale_items (sale_id, product_id, name, price, qty, hsn_code, gst_rate) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(item.sale_id, item.product_id, item.name, item.price, item.qty, item.hsn_code||null, item.gst_rate||0);
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

  const dailySales = dbx.prepare("SELECT date(timestamp) as day, round(sum(total),2) as revenue, count(*) as transactions FROM sales GROUP BY date(timestamp) ORDER BY day DESC LIMIT 14").all();
  const monthlyRevenue = dbx.prepare("SELECT substr(timestamp,1,7) as month, round(sum(total),2) as revenue FROM sales GROUP BY substr(timestamp,1,7) ORDER BY month DESC LIMIT 12").all();
  const bestSelling = dbx.prepare("SELECT name, sum(qty) as qty FROM sale_items GROUP BY name ORDER BY qty DESC LIMIT 10").all();
  const slowMoving = dbx.prepare("SELECT p.name, coalesce(sum(si.qty),0) as qty FROM products p LEFT JOIN sale_items si ON si.product_id = p.id GROUP BY p.id ORDER BY qty ASC LIMIT 10").all();
  const taxReport = dbx.prepare("SELECT date(timestamp) as day, round(sum(tax),2) as gst FROM sales GROUP BY date(timestamp) ORDER BY day DESC LIMIT 14").all();
  const cashSummary = dbx.prepare("SELECT payment_method as method, round(sum(total),2) as amount, count(*) as count FROM sales GROUP BY payment_method ORDER BY amount DESC").all();
  const stockValue = dbx.prepare("SELECT round(sum(price * stock),2) as value FROM products").get()?.value || 0;
  const revenue = dbx.prepare("SELECT round(sum(total),2) as v FROM sales").get()?.v || 0;
  const cogs = dbx.prepare("SELECT round(sum(price * qty),2) as v FROM sale_items").get()?.v || 0;

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
  const sqliteCats = !SUPABASE_URL ? (getDb()?.prepare("SELECT id,name,hsn_code,gst_rate FROM categories ORDER BY name").all() || []) : [];
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
    const sku = decodeURIComponent(pathname.replace("/api/products/", "").replace("/price", ""));
    const { price } = await parseBody(req);
    if (isNaN(Number(price)) || Number(price) < 0) return json(res, 400, { error: "Invalid price." });
    const updated = await DB.updatePrice(sku, Number(price));
    if (!updated) return json(res, 404, { error: "Product not found." });
    return json(res, 200, { ok: true });
  }

  if (pathname === "/api/sales" && req.method === "POST") {
    const user = requireAuth(req);
    if (!user) return json(res, 401, { error: "Login required." });
    const sale = await parseBody(req);
    if (!Array.isArray(sale.items) || !sale.items.length) return json(res, 400, { error: "Cart is empty." });

    // Validate stock
    for (const line of sale.items) {
      const product = await DB.getProductById(line.productId);
      if (!product || product.stock < line.qty) {
        return json(res, 400, { error: `Insufficient stock for ${line.name}` });
      }
    }

    // Decrement stock
    for (const line of sale.items) await DB.decrementStock(line.productId, line.qty);

    const count     = await DB.getSalesCount();
    const receiptNo = `R-${String(count + 1).padStart(5, "0")}`;
    const timestamp = new Date().toISOString();

    const saleId = await DB.insertSale({
      receipt_no:    receiptNo,
      timestamp,
      cashier:       user.username, // always use authenticated user
      payment_method: sale.paymentMethod,
      subtotal:      sale.subtotal,
      discount:      sale.discount,
      tax:           sale.tax,
      total:         sale.total,
      received:      sale.received,
      change_amount: sale.change,
      currency:      sale.currency || "USD",
    });

    for (const line of sale.items) {
      await DB.insertSaleItem({ sale_id: saleId, product_id: line.productId, name: line.name,
        price: line.price, qty: line.qty, hsn_code: line.hsnCode||null, gst_rate: line.gstRate||0 });
    }

    return json(res, 200, { ok: true, receiptNo, timestamp });
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
    if (!supplierId || !sku || Number(qty) <= 0) return json(res, 400, { error: "Invalid purchase order." });
    const poNumber = `PO-${Date.now()}`;
    if (SUPABASE_URL) {
      const products = await sbQuery("products", "GET", null, `?sku=ilike.${encodeURIComponent(sku.trim())}&select=id,stock&limit=1`);
      if (!products || !products.length) return json(res, 404, { error: "SKU not found." });
      const product = products[0];
      const newStock = (Number(product.stock) || 0) + Number(qty);
      await sbQuery("purchase_orders", "POST", { supplier_id: Number(supplierId), po_number: poNumber, status: "Received", total: 0, created_at: new Date().toISOString() });
      await fetch(`${SUPABASE_URL}/rest/v1/products?id=eq.${product.id}`, {
        method: "PATCH",
        headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", "Prefer": "return=minimal" },
        body: JSON.stringify({ stock: newStock })
      });
      return json(res, 200, { ok: true, poNumber, newStock });
    }
    const dbx = getDb();
    const product = dbx.prepare("SELECT id, stock FROM products WHERE lower(sku)=lower(?)").get(sku.trim());
    if (!product) return json(res, 404, { error: "SKU not found." });
    const newStock = (Number(product.stock) || 0) + Number(qty);
    dbx.prepare("INSERT INTO purchase_orders (supplier_id, po_number, status, total, created_at) VALUES (?, ?, 'Received', 0, ?)").run(Number(supplierId), poNumber, new Date().toISOString());
    dbx.prepare("UPDATE products SET stock = ? WHERE id=?").run(newStock, product.id);
    return json(res, 200, { ok: true, poNumber, newStock });
  }

  if (pathname === "/api/stock-transfer" && req.method === "POST") {
    if (!requireAdmin(req)) return json(res, 403, { error: "Admin only." });
    const { sku, qty, fromStore, toStore } = await parseBody(req);
    const amount = Number(qty);
    if (!sku || amount <= 0 || !fromStore || !toStore) return json(res, 400, { error: "Invalid transfer payload." });
    if (SUPABASE_URL) {
      const products = await sbQuery("products", "GET", null, `?sku=ilike.${encodeURIComponent(sku.trim())}&select=id,stock&limit=1`);
      if (!products || !products.length) return json(res, 404, { error: "SKU not found." });
      const product = products[0];
      if ((Number(product.stock) || 0) < amount) return json(res, 400, { error: `Insufficient stock. Available: ${product.stock}` });
      const newStock = (Number(product.stock) || 0) - amount;
      await fetch(`${SUPABASE_URL}/rest/v1/products?id=eq.${product.id}`, {
        method: "PATCH",
        headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", "Prefer": "return=minimal" },
        body: JSON.stringify({ stock: newStock })
      });
      await sbQuery("stock_transfers", "POST", { sku: String(sku).trim(), qty: amount, from_store: String(fromStore).trim(), to_store: String(toStore).trim(), created_at: new Date().toISOString() });
      return json(res, 200, { ok: true, newStock });
    }
    const dbx = getDb();
    const product = dbx.prepare("SELECT id, stock FROM products WHERE lower(sku)=lower(?)").get(sku.trim());
    if (!product) return json(res, 404, { error: "SKU not found." });
    if ((Number(product.stock) || 0) < amount) return json(res, 400, { error: `Insufficient stock. Available: ${product.stock}` });
    const newStock = (Number(product.stock) || 0) - amount;
    dbx.prepare("UPDATE products SET stock = ? WHERE id=?").run(newStock, product.id);
    dbx.prepare("INSERT INTO stock_transfers (sku, qty, from_store, to_store, created_at) VALUES (?, ?, ?, ?, ?)").run(String(sku).trim(), amount, String(fromStore).trim(), String(toStore).trim(), new Date().toISOString());
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
      await sbQuery("sales","POST",{ receipt_no:refundNo, timestamp:new Date().toISOString(), cashier:user.username, payment_method:"REFUND", subtotal:-(sale.subtotal||0), discount:0, tax:-(sale.tax||0), total:-(sale.total||0), received:0, change_amount:sale.total||0, currency:sale.currency||"USD" });
      return json(res, 200, { ok:true, refundNo, amount: sale.total||0 });
    }

    const dbx  = getDb();
    const sale = dbx.prepare("SELECT * FROM sales WHERE receipt_no=?").get(receiptNo);
    if (!sale) return json(res, 404, { error: "Receipt not found." });
    if (dbx.prepare("SELECT id FROM sales WHERE receipt_no=?").get(refundNo)) return json(res, 409, { error: "Already refunded." });
    const items = dbx.prepare("SELECT product_id, qty FROM sale_items WHERE sale_id=?").all(sale.id);
    for (const item of items) dbx.prepare("UPDATE products SET stock=stock+? WHERE id=?").run(item.qty, item.product_id);
    dbx.prepare("INSERT INTO sales (receipt_no,timestamp,cashier,payment_method,subtotal,discount,tax,total,received,change_amount,currency) VALUES(?,?,?,'REFUND',?,0,?,?,0,?,?)").run(refundNo, new Date().toISOString(), user.username, -(sale.subtotal||0), -(sale.tax||0), -(sale.total||0), sale.total||0, sale.currency||"USD");
    return json(res, 200, { ok:true, refundNo, amount: sale.total||0 });
  }

  // ── REPORTS ───────────────────────────────────────────────────
  if (pathname === "/api/reports" && req.method === "GET") {
    if (!requireAuth(req)) return json(res, 401, { error: "Login required." });
    if (!SUPABASE_URL) return json(res, 200, { reports: sqliteFeatureData().reports });

    const sales    = await sbQuery("sales","GET",null,"?select=timestamp,total,tax,payment_method,subtotal&order=timestamp.desc") || [];
    const items    = await sbQuery("sale_items","GET",null,"?select=name,qty,price,product_id") || [];
    const products = await sbQuery("products","GET",null,"?select=id,name,sku,stock,price") || [];

    // 30-day cutoff for slow moving calculation
    const cutoff30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0,10);

    const dailyMap={}, monthMap={}, taxMap={}, cashMap={}, itemMap={};
    for (const s of sales) {
      if ((s.total||0) < 0) continue;
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

    // Best selling: ALL time, group by product name
    for (const i of items) {
      if (!itemMap[i.name]) itemMap[i.name]={name:i.name, qty:0};
      itemMap[i.name].qty += i.qty||0;
    }
    const allItems = Object.values(itemMap);

    // Slow moving (proper POS logic):
    // - Start with ALL products in inventory (including zero-sale products)
    // - Count qty sold in last 30 days only
    // - Sort: zero-sale products first, then least sold, then by stock DESC (most stock = most urgent)
    // - Only show products with stock > 0 (no point showing out-of-stock as "slow moving")
    const soldLast30 = {};
    for (const i of items) {
      // We need sale timestamp — use sale_items joined approach via sales map
      soldLast30[i.name] = (soldLast30[i.name]||0); // init
    }
    // Build sale timestamp map for last-30 filter
    const recentSaleIds = new Set(
      sales.filter(s => s.timestamp?.slice(0,10) >= cutoff30 && (s.total||0) > 0)
           .map((_,idx) => idx) // we don't have sale_id in this query, use name-based approach
    );
    // Simpler: re-scan items but filter via sale dates using a joined query isn't available
    // Use all-time qty but note in label — still correct vs current broken logic
    const sold30Map = {};
    // Since sale_items doesn't have timestamp, use sales fetched and match via a second item fetch with sale join
    const recentItems = await sbQuery("sale_items","GET",null,
      `?select=name,qty,sales(timestamp)&sales.timestamp=gte.${cutoff30}T00:00:00`) || [];
    for (const i of recentItems) {
      const ts = i.sales?.timestamp;
      if (!ts || ts.slice(0,10) < cutoff30) continue;
      sold30Map[i.name] = (sold30Map[i.name]||0) + (i.qty||0);
    }

    const slowMoving = products
      .filter(p => p.stock > 0)  // only in-stock items
      .map(p => ({
        name:  p.name,
        sku:   p.sku,
        stock: p.stock,
        qty:   sold30Map[p.name] || 0,  // sold in last 30 days (0 if never sold)
      }))
      .sort((a,b) => {
        if (a.qty !== b.qty) return a.qty - b.qty;   // least sold first
        return b.stock - a.stock;                     // tie-break: most stock = most urgent
      })
      .slice(0, 10);

    const revenue=+sales.filter(s=>(s.total||0)>0).reduce((a,s)=>a+(s.total||0),0).toFixed(2);
    const cogs=+items.reduce((a,i)=>a+(i.price||0)*(i.qty||0),0).toFixed(2);
    const stockValue=+products.reduce((a,p)=>a+(p.price||0)*(p.stock||0),0).toFixed(2);
    return json(res, 200, { reports: {
      dailySales:    Object.values(dailyMap).sort((a,b)=>b.day.localeCompare(a.day)).slice(0,14),
      monthlyRevenue:Object.values(monthMap).sort((a,b)=>b.month.localeCompare(a.month)).slice(0,12),
      bestSelling:   [...allItems].sort((a,b)=>b.qty-a.qty).slice(0,10),
      slowMoving,
      taxReport:     Object.values(taxMap).sort((a,b)=>b.day.localeCompare(a.day)).slice(0,14),
      cashSummary:   Object.values(cashMap).sort((a,b)=>b.amount-a.amount),
      profitLoss:    { revenue, cogs, grossProfit:+(revenue-cogs).toFixed(2), stockValue }
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
    if (!requireAdmin(req)) return json(res, 403, { error: "Admin only." });
    const sku = decodeURIComponent(pathname.split("/")[3]);
    const { stock, reason } = await parseBody(req);
    if (stock === undefined || stock < 0) return json(res, 400, { error: "Invalid stock value." });
    if (SUPABASE_URL) {
      await sbQuery("products", "PATCH", { stock }, `?sku=eq.${encodeURIComponent(sku)}`);
      return json(res, 200, { ok: true });
    }
    getDb().prepare("UPDATE products SET stock=? WHERE sku=?").run(stock, sku);
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
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, username TEXT UNIQUE, password TEXT, role TEXT);
    CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, hsn_code TEXT NOT NULL, gst_rate REAL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS tax_codes (id TEXT PRIMARY KEY, name TEXT NOT NULL, gst_rate REAL DEFAULT 0, cess_rate REAL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY, name TEXT, sku TEXT UNIQUE, barcode TEXT UNIQUE, price REAL, wholesale_price REAL, retail_price REAL, mrp REAL, stock INTEGER, hsn_code TEXT, gst_rate REAL DEFAULT 0, cess_rate REAL DEFAULT 0, tax_code TEXT, category_id INTEGER);
    CREATE TABLE IF NOT EXISTS sales (id INTEGER PRIMARY KEY, receipt_no TEXT UNIQUE, timestamp TEXT, cashier TEXT, payment_method TEXT, subtotal REAL, discount REAL, tax REAL, total REAL, received REAL, change_amount REAL, currency TEXT);
    CREATE TABLE IF NOT EXISTS sale_items (id INTEGER PRIMARY KEY, sale_id INTEGER, product_id TEXT, name TEXT, price REAL, qty INTEGER, hsn_code TEXT, gst_rate REAL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS suppliers (id INTEGER PRIMARY KEY, name TEXT, phone TEXT, email TEXT);
    CREATE TABLE IF NOT EXISTS purchase_orders (id INTEGER PRIMARY KEY, supplier_id INTEGER, po_number TEXT, status TEXT, total REAL, created_at TEXT);
    CREATE TABLE IF NOT EXISTS stock_transfers (id INTEGER PRIMARY KEY, sku TEXT, qty INTEGER, from_store TEXT, to_store TEXT, created_at TEXT);
    CREATE TABLE IF NOT EXISTS stock_batches (id INTEGER PRIMARY KEY, sku TEXT, batch_no TEXT, expiry_date TEXT, qty INTEGER);
    CREATE TABLE IF NOT EXISTS customers (id INTEGER PRIMARY KEY, name TEXT, phone TEXT UNIQUE, loyalty_points INTEGER DEFAULT 0, member_discount REAL DEFAULT 0, credit_balance REAL DEFAULT 0);
  `);

  const ensureCol = (sql) => { try { db.exec(sql); } catch {} };
  ensureCol("ALTER TABLE products ADD COLUMN barcode TEXT");
  ensureCol("ALTER TABLE products ADD COLUMN wholesale_price REAL DEFAULT 0");
  ensureCol("ALTER TABLE products ADD COLUMN retail_price REAL DEFAULT 0");
  ensureCol("ALTER TABLE products ADD COLUMN mrp REAL DEFAULT 0");
  ensureCol("ALTER TABLE products ADD COLUMN cess_rate REAL DEFAULT 0");
  ensureCol("ALTER TABLE products ADD COLUMN tax_code TEXT");

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
  }
  db.exec("UPDATE products SET barcode = COALESCE(barcode, sku)");
  db.exec("UPDATE products SET wholesale_price = COALESCE(wholesale_price, round(price / (1 + (COALESCE(gst_rate,0)+COALESCE(cess_rate,0))/100.0), 2))");
  db.exec("UPDATE products SET retail_price = COALESCE(retail_price, price)");
  db.exec("UPDATE products SET mrp = CASE WHEN COALESCE(mrp,0) <= 0 THEN retail_price ELSE mrp END");
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('currency', 'USD')").run();
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
      await sbQuery("settings", "POST", { key: "currency",    value: "USD"   });
      await sbQuery("settings", "POST", { key: "theme",       value: "light" });
      await sbQuery("settings", "POST", { key: "cashierName", value: ""      });
    }
    console.log("✅ Supabase ready!");
  } catch (err) {
    console.error("❌ Supabase seed error:", err.message);
  }
}

// ── START ─────────────────────────────────────────────────────
await initSqlite().catch((err) => console.warn("SQLite init skipped:", err.message));
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